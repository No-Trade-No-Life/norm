import { Hono, type Context } from 'hono';
import { readSpeechAsk, readTranscriptionAsk, audioCodecFor, type AudioAsk, type AudioWire } from '../audio';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { needsConsumerTouch, touchConsumer } from '../consumers';
import { providerCredential } from '../credentials';
import { sendUpstream } from '../tunnel';
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
import { audioRateFor, quoteAudio } from '../pricing';
import { protocolFor } from '../protocols';
import { affinityKeyOf } from '../routing';
import { resolveProvider } from '../store';
import { failureHeaders, receiptHeaders, recordFailure, settleBill, type Accounting } from './billing';

/**
 * 音频转发面：`POST /v1/audio/transcriptions` 与 `POST /v1/audio/speech`。
 *
 * 与文本那条路（`relay.ts`）共用同一件事：一个消费者 Token、一次选址、一笔 Gas、一笔
 * 转给上游提供方的费用。不同的只有两处——入口不是一个 JSON 而是一段 multipart 或音频字节，
 * 用量不是 token 而是秒/字符，所以这条流程单独写一遍、保持一条直线：解析 → 拒掉没价目的
 * 型号 → 选址（只挑做得了这次调用的上游）→ 转发 → 归一化 → 结算。
 *
 * 不做重试：文本那条「换一条候选再试一次」是为了纠正清单里错的一行（`isModelNotServed`），
 * 而音频的型号表是代码里钉死的（Qwen）或上游自己列的（直通的音频上游），没有那种误差可纠。
 */
export const audioRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

type AudioContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

audioRoutes.post('/audio/transcriptions', async (c: AudioContext) => {
  const { ask, wire } = await readTranscriptionAsk(c.req.raw);
  return proxyAudio(c, ask, wire);
});

audioRoutes.post('/audio/speech', async (c: AudioContext) => {
  const { ask, wire } = readSpeechAsk({
    rawBody: await c.req.text(),
    contentType: c.req.header('Content-Type') ?? '',
  });
  return proxyAudio(c, ask, wire);
});

async function proxyAudio(c: AudioContext, ask: AudioAsk, wire: AudioWire): Promise<Response> {
  const principal = c.get('principal');
  const address = principal.address;

  // 音频没有兜底价：认不出的型号在这里就拒，0 次 D1 写、0 次上游请求、0 笔记账。
  if (audioRateFor(ask.model) === null) {
    fail(
      400,
      'audio_model_unpriced',
      `音频价目表里没有 ${ask.model}：一次音频调用必须先知道按秒、按字符还是按 token 算钱`,
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

  // 走哪条上游仍是 Norm 自己的决定：做得了这次音频调用是前提，自己的上游优先、公共池兜底。
  const choice = await resolveProvider(c.env, address, affinity, {
    model: ask.model,
    audio: ask,
    gas,
    pendingRequiredNanos: pendingTouch + GAS_SETTLE_NANOS,
    abortOnInsufficientBalance: true,
  });
  const provider = choice.provider;
  const profile = protocolFor(provider.protocol);
  // 选址已经按音频能力筛过，走到了这里说明它确实有音频方言。
  if (profile.audio === undefined) fail(404, 'audio_not_served', `${provider.protocol} 没有音频能力`);
  const codec = audioCodecFor(profile.audio);

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
  let providerKey: string;
  try {
    providerKey = await providerCredential({ env: c.env, address: provider.address, provider });
  } catch (error) {
    return c.json({ error: 'provider_credential_unavailable', message: (error as Error).message }, 502);
  }

  const call = codec.encode(ask, wire);
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
    // 音频价目不分时：档位是文本协议的事（DeepSeek 的高峰 / 低谷）。
    rate: null,
  };

  let reply: Response;
  try {
    // 音频与文本走同一条出口：配了代理就进隧道（见 `src/tunnel.ts`）。
    reply = await sendUpstream({
      env: c.env,
      address: provider.address,
      provider,
      url: `${provider.base_url.replace(/\/+$/, '')}${call.path}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': call.wire.contentType, ...profile.headers(providerKey) },
        body: call.wire.body,
      },
    });
  } catch (error) {
    const settled = await recordFailure(accounting, 'network_error', 502);
    return c.json(
      { error: 'provider_unreachable', message: `Provider 不可达：${(error as Error).message}` },
      502,
      failureHeaders(requestId, settled),
    );
  }

  if (!reply.ok) {
    // Gas 照收，token 不收：这次调用已经真的打出去了；上游的原话原样交回，它比一句概括有用。
    const settled = await recordFailure(accounting, 'provider_error', reply.status);
    return new Response(await reply.text(), {
      status: reply.status,
      headers: {
        'Content-Type': reply.headers.get('Content-Type') ?? 'application/json',
        ...failureHeaders(requestId, settled),
      },
    });
  }

  const answer = await codec.read(ask, reply);
  // 自有上游只付 Gas：自己直接付给上游厂商，Norm 不在这两者之间转一笔钱。
  const quote = provider.address === address ? null : quoteAudio(ask.model, answer.usage);
  const meta = await settleBill(accounting, {
    status: 'ok',
    statusCode: reply.status,
    tokenNanos: quote?.nanos ?? 0,
    usage: { input: answer.usage.input, cached: 0, output: answer.usage.output },
    audio: answer.usage,
  });

  if (answer.kind === 'transcriptions') {
    // 钱就写在这次响应里：上层网关（NormAI）结算读的是 `cost_usd_nanos`，而它和
    // `norm.fee_nanos` 是同一个数——一个请求一次往返，没有「先转出去、后回捞」。
    return c.json({ text: answer.text, cost_usd_nanos: meta.fee_nanos, norm: meta });
  }

  // 合成回的是音频字节，账目没法塞进响应体，只能挂在头上。
  return new Response(answer.audio, {
    status: 200,
    headers: {
      'Content-Type': answer.contentType,
      'Content-Length': String(answer.audio.byteLength),
      ...receiptHeaders(meta),
    },
  });
}
