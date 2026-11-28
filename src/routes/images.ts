import { Hono, type Context } from 'hono';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { needsConsumerTouch, touchConsumer } from '../consumers';
import { providerCredential } from '../credentials';
import { minBalanceNanos, type Env } from '../env';
import {
  D1_ROW_WRITES,
  GAS_CONSUMER_TOUCH_NANOS,
  GAS_SETTLE_NANOS,
  GAS_TOKEN_TRANSFER_NANOS,
  GasMeter,
} from '../gas';
import { fail } from '../http';
import { uuidv7 } from '../ids';
import { logError } from '../log';
import { MAX_HOST_ATTEMPTS } from '../hosts';
import { imageCodecFor, readImageAsk, type ImageAsk } from '../images';
import { isModelNotServed } from '../models';
import { quoteImage, ZERO_AUDIO_USAGE } from '../pricing';
import { protocolFor } from '../protocols';
import { affinityKeyOf } from '../routing';
import { resolveProvider } from '../store';
import { sendUpstream } from '../tunnel';
import { failureHeaders, receiptHeaders, recordFailure, settleBill, type Accounting } from './billing';

/**
 * 图像转发面：`POST /v1/images/generations`。
 *
 * 与另外两条路（`relay.ts` 的文本、`audio.ts` 的音频）共用同一件事：一个消费者 Token、
 * 一次选址、一笔 Gas、一笔转给上游提供方的费用。不同的是三处，所以这条流程单独走一遍、
 * 保持一条直线：
 *
 *   1. 用量不是 token：图是按张卖的，一张图的价钱与上游回的那几十个 token 差着几个数量级
 *      （见 `pricing.ts` 的 `IMAGE_RATES`）；
 *   2. 出口不是一层：ChatGPT 没有 `/images/generations`，要一次 Responses 请求加一个
 *      `image_generation` 工具，答是 SSE 流，图在流里（见 `src/images.ts`）；
 *   3. 宿主是谁与调用方无关：那条替调用方发起工具的文本模型是 Norm 的实现细节，
 *      所以它按候选表逐个试，而不让调用方指定。
 */
export const imageRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

type ImageContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

imageRoutes.post('/images/generations', async (c: ImageContext) => {
  const principal = c.get('principal');
  const address = principal.address;
  const ask = readImageAsk(await c.req.text());

  // 图像没有兜底价：认不出的型号在这里就拒，0 次 D1 写、0 次上游请求、0 笔记账。
  if (quoteImage(ask.model, { count: 1, pixels: 0, quality: 'medium' }) === null) {
    fail(
      400,
      'image_model_unpriced',
      `图像价目表里没有 ${ask.model}：一次图像生成必须先知道按哪张图算钱`,
    );
  }

  const affinity = affinityKeyOf(c.req.raw.headers);
  const requestId = uuidv7();
  const startedAt = Date.now();
  const gas = new GasMeter({
    availableNanos: principal.balanceNanos,
    minBalanceNanos: minBalanceNanos(c.env),
  });
  // 闸门 A：低于安全阈值直接 402，0 次 D1 写、0 次上游请求。
  if (!gas.canStart()) {
    fail(
      402,
      'insufficient_balance',
      `余额不足：至少需要 ${gas.minBalanceNanos} 纳美元安全余额，当前 ${principal.balanceNanos}`,
    );
  }

  /** 本日 consumers.last_used_at 是否已经记过：按 UTC 自然日节流，每天最多写 1 行。 */
  let consumerTouched = !needsConsumerTouch(principal.consumerLastUsedAt, Math.floor(startedAt / 1000));
  const pendingTouch = consumerTouched ? 0 : GAS_CONSUMER_TOUCH_NANOS;

  // 走哪条上游仍是 Norm 自己的决定：做得了这次图像调用是前提（方言认得这个型号），
  // 自己的上游优先、公共池兜底。
  const choice = await resolveProvider(c.env, address, affinity, {
    model: ask.model,
    image: ask,
    gas,
    pendingRequiredNanos: pendingTouch + GAS_SETTLE_NANOS,
    abortOnInsufficientBalance: true,
  });
  const provider = choice.provider;
  const profile = protocolFor(provider.protocol);
  // 选址已经按图像能力筛过，走到了这里说明它确实有图像方言。
  if (profile.image === undefined) fail(404, 'image_not_served', `${provider.protocol} 没有图像能力`);
  const codec = imageCodecFor(profile.image);

  // 闸门 B（发往上游前预算检查）：余额要够覆盖「记一笔消费者 + 跨用户转账 + 结算」这几次写库。
  const pendingTransfer = choice.via === 'pool' ? GAS_TOKEN_TRANSFER_NANOS : 0;
  if (!gas.canAfford(pendingTouch + pendingTransfer + GAS_SETTLE_NANOS)) {
    fail(
      402,
      'insufficient_balance',
      `余额不足：本次请求预计需要 ${gas.projectedTotal(pendingTouch + pendingTransfer + GAS_SETTLE_NANOS)} 纳美元 Gas，当前 ${principal.balanceNanos}`,
    );
  }
  if (!consumerTouched) {
    await touchConsumer(c.env, principal.consumerId);
    gas.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    consumerTouched = true;
  }

  // 明文密钥现解现用，只在本次请求的作用域里存在；解封用的是**持有者**的地址。
  // OAuth 协议的凭据会过期，换新也在这一步里。
  let providerKey: string;
  try {
    providerKey = await providerCredential({ env: c.env, address: provider.address, provider });
  } catch (error) {
    logError('provider_credential_error', error, {
      request_id: requestId,
      provider_id: provider.id,
      protocol: provider.protocol,
    });
    return c.json({ error: 'provider_credential_unavailable', message: (error as Error).message }, 502);
  }

  const accounting: Accounting = {
    env: c.env,
    address,
    providerId: provider.id,
    providerUser: provider.address,
    consumerUser: principal.consumerId ? address : null,
    pool: choice.via === 'pool',
    consumerId: principal.consumerId,
    baseUrl: provider.base_url,
    requestId,
    startedAt,
    gas,
    host: hostOf(provider.base_url),
    model: ask.model,
    // 图像价目不分时：档位是文本协议的事（DeepSeek 的高峰 / 低谷）。
    rate: null,
  };

  // 宿主模型逐个试：账户不同，可达的那条文本模型不同（同一个订阅里有的回 model_not_found，
  // 有的能用）。只在这一种错上换候选——内容被拒、额度用光换宿主也没用，那些原话交回。
  const hosts = codec.hostModels.slice(0, MAX_HOST_ATTEMPTS);
  let answer: ReturnType<typeof codec.read> | null = null;
  let failure: { status: number; contentType: string; text: string } | null = null;
  let upstreamStatus = 200;
  for (let index = 0; index < hosts.length; index += 1) {
    const call = codec.encode(ask, hosts[index]);
    let reply: Response;
    try {
      // 图像与文本走同一条出口：配了代理就进隧道（见 `src/tunnel.ts`）。
      reply = await sendUpstream({
        env: c.env,
        address: provider.address,
        provider,
        url: `${provider.base_url.replace(/\/+$/, '')}${call.path}`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 上游只认流式；Accept 明说这件事，省掉一次「你为什么不是 SSE」的歧义。
            Accept: 'text/event-stream',
            ...profile.headers(providerKey),
          },
          body: call.body,
        },
      });
    } catch (error) {
      logError('upstream_network_error', error, {
        request_id: requestId,
        provider_id: provider.id,
        protocol: provider.protocol,
        host: accounting.host,
      });
      const settled = await recordFailure(accounting, 'network_error', 502);
      return c.json(
        { error: 'provider_unreachable', message: `Provider 不可达：${(error as Error).message}` },
        502,
        failureHeaders(requestId, settled),
      );
    }

    if (reply.ok) {
      upstreamStatus = reply.status;
      answer = codec.read(await reply.text());
      break;
    }

    const text = await reply.text();
    failure = { status: reply.status, contentType: reply.headers.get('Content-Type') ?? 'application/json', text };
    // 宿主模型不在这个账户的可达清单里：换下一个候选再问一次。
    if (index + 1 < hosts.length && isModelNotServed(reply.status, text, hosts[index])) continue;
    break;
  }

  if (answer === null) {
    // Gas 照收，图钱不收：这次调用已经真的打出去了；上游的原话原样交回，它比一句概括有用。
    const settled = await recordFailure(
      accounting,
      'provider_error',
      failure?.status ?? 502,
    );
    return new Response(failure?.text ?? '', {
      status: failure?.status ?? 502,
      headers: {
        'Content-Type': failure?.contentType ?? 'application/json',
        ...failureHeaders(requestId, settled),
      },
    });
  }

  // 钱按「上游回显的那张图」算：请求里写 auto 时，质量与尺寸只有上游知道。
  // 回显里没有质量就退回请求里那个具体档位；连请求也是 auto 就按最高档收——上界，宁高估不漏收。
  const echoedQuality = answer.quality;
  const quality: 'low' | 'medium' | 'high' =
    echoedQuality === 'low' || echoedQuality === 'medium' || echoedQuality === 'high'
      ? echoedQuality
      : ask.quality === 'auto'
        ? 'high'
        : ask.quality;
  const pixels = pixelsOf(answer.size) ?? pixelsOf(ask.size) ?? 0;
  // 自有上游也按真价记（自转自，余额只减 Gas）：一张图的价与上游归谁无关，折成 0 会让
  // 账本说不出这次生成实际花了多少钱。
  const quote = quoteImage(ask.model, {
    count: answer.images.length,
    pixels,
    quality: quality as 'low' | 'medium' | 'high',
  });

  const meta = await settleBill(accounting, {
    status: 'ok',
    statusCode: upstreamStatus,
    tokenNanos: quote?.nanos ?? 0,
    usage: answer.usage,
    audio: ZERO_AUDIO_USAGE,
    image: { count: answer.images.length, pixels, quality },
  });

  // 形状按 OpenAI 的 `/v1/images/generations` 回：`data[].b64_json`，账目挂在顶层与回执头上。
  // 图不进本站存储——它只在这次响应里存在一次（ZDR 的同一句话）。
  return c.json(
    {
      created: Math.floor(startedAt / 1000),
      data: answer.images.map((image) => ({
        b64_json: image.b64_json,
        ...(image.revised_prompt === null ? {} : { revised_prompt: image.revised_prompt }),
      })),
      usage: {
        input_tokens: answer.usage.input,
        output_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
      },
      cost_usd_nanos: meta.fee_nanos,
      norm: meta,
    },
    200,
    receiptHeaders(meta),
  );
});

/** `WIDTHxHEIGHT` → 像素数；`auto` 或读不出来就是 null（上游没回显尺寸时按 1K 方图算）。 */
function pixelsOf(size: string | null): number | null {
  if (size === null) return null;
  const match = /^([0-9]+)x([0-9]+)$/.exec(size);
  if (match === null) return null;
  const pixels = Number(match[1]) * Number(match[2]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}
