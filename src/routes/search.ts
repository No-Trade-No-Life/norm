import { Hono, type Context } from 'hono';
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
import { MAX_HOST_ATTEMPTS } from '../hosts';
import { HttpError, fail } from '../http';
import { uuidv7 } from '../ids';
import { logError } from '../log';
import { isModelNotServed } from '../models';
import { ZERO_AUDIO_USAGE } from '../pricing';
import { protocolFor } from '../protocols';
import { affinityKeyOf } from '../routing';
import { readSearchAsk, searchCodecForProtocol, searchDialectFor, type SearchAnswer } from '../search';
import { resolveProvider } from '../store';
import { failureHeaders, receiptHeaders, recordFailure, settleBill, type Accounting } from './billing';

/**
 * 联网搜索转发面：`POST /v1/web-search`。
 *
 * 这是一条**独立端点**，不是 `/v1/responses` 上的一件 `tools`。理由不是审美：搜索本身已经
 * 是一次确定的 API 调用（`/v1/tools/search`，见 `src/search.ts`），把它包进一次对话里，
 * 就得先让一个宿主模型读懂问题、决定搜什么、再写一段散文把结果复述回来——多一次推理、多
 * 一份不确定性，而且同一次搜索还要按 token 再收一遍钱。这里不做那件事：请求进、结果出，
 * 中间只有一次上游调用。
 *
 * 与文本、音频同一条骨架：一个消费者 Token、一次选址、一笔 Gas、一笔转给上游提供方的钱。
 * 不同的只有两处——**没有模型**（搜索不跑模型，选址只看「这条上游会不会搜索」），以及
 * 计价不由调用方挑的型号决定：直连 Search API 按**成功的调用**（一次 750,000 纳美元），
 * 把宿主模型包成搜索的那条按上游报的 **token**。失败、超时与无结果不收 Token 费。
 *
 * 唯一像例外的是订阅上游（`openai-oauth`）：它只有 `/responses`，`web_search` 在那里是
 * 一个工具，于是 Norm 替它包**一次只调这个工具的**请求。那是上游的形状，不是把搜索变成
 * 对话：`tool_choice` 钉死，宿主模型不替调用方做决定，回来的仍是 `sources[]`（见
 * `src/search.ts` 的 `openai-oauth` 那一条）。
 */
export const searchRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

type SearchContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

searchRoutes.post('/web-search', async (c: SearchContext) => {
  const principal = c.get('principal');
  const address = principal.address;

  // 解析在任何记账之前：坏请求 0 次 D1 写、0 次上游请求、0 笔记账。
  const ask = readSearchAsk(await c.req.text());
  // 下游选的是**搜索协议**（deepseek / openai），不是模型：两条协议的区别在上游怎么把搜索
  // 做出来（直连搜索引擎，或把宿主模型 + `web_search` 工具包成同一条信封），而不在型号。
  // 协议只决定「要哪条方言」；具体跟谁说、怎么说，要等选出上游之后按**协议**取编解码
  // （`openai-search` 这条方言有两条上游：做好信封的服务，与 Norm 自己包工具的订阅）。
  const dialect = searchDialectFor(ask.protocol);

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

  // 走哪条上游是 Norm 自己的决定：会搜索是前提，自己的上游优先、公共池兜底。
  const choice = await resolveProvider(c.env, address, affinityKeyOf(c.req.raw.headers), {
    search: dialect,
    gas,
    pendingRequiredNanos: pendingTouch + GAS_SETTLE_NANOS,
    abortOnInsufficientBalance: true,
  });
  const provider = choice.provider;
  const profile = protocolFor(provider.protocol);
  const codec = searchCodecForProtocol(provider.protocol);
  // 选址按方言筛过，这里再按协议取编解码：取不到、或它说的不是同一条方言，就是一份与
  // 选址规则不一致的协议声明——当场说清，别拿着别的方言的请求体打出去。
  if (codec === null || codec.dialect !== dialect) {
    fail(404, 'search_not_served', `${provider.protocol} 不做 ${ask.protocol} 这条搜索协议`);
  }

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
    // 搜索不跑模型：这一列在这条路上留空，路径（`/v1/web-search`）已经说清了这是什么调用。
    // 拿一个型号名填进去，只会让「这个模型花了多少钱」这个问题多出一条假答案。
    model: '',
    // 搜索按次计价，不分时：档位是文本协议的事（DeepSeek 的高峰 / 低谷）。
    rate: null,
  };

  // 宿主模型逐个试：同一个订阅里可达的文本模型不同（有的回 `model_not_found`，有的能用），
  // 而宿主是谁与调用方无关。只在这一种错上换候选——内容被拒、额度用光，换宿主也没用。
  const hosts: Array<string | undefined> =
    codec.hostModels === undefined ? [undefined] : codec.hostModels.slice(0, MAX_HOST_ATTEMPTS);

  let answer: SearchAnswer | null = null;
  let failure: { status: number; contentType: string; text: string } | null = null;
  let upstreamStatus = 200;

  for (let index = 0; index < hosts.length; index += 1) {
    const host = hosts[index];
    let reply: Response;
    try {
      reply = await sendUpstream({
        env: c.env,
        address: provider.address,
        provider,
        url: `${provider.base_url.replace(/\/+$/, '')}${codec.path}`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...profile.headers(providerKey) },
          body: codec.encode(ask, host),
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
      try {
        answer = await codec.read(reply);
      } catch (error) {
        // 上游回了 200，却没有一页结果（或回的不是搜索信封）：这次搜索不算成功，Token 费
        // 不收，但那次上游请求真的发生过，Gas 照收——与文本、音频的失败同一口径。
        const readFailure = error instanceof HttpError ? error : null;
        if (readFailure === null) {
          logError('search_read_error', error, {
            request_id: requestId,
            provider_id: provider.id,
            host: accounting.host,
          });
        }
        const settled = await recordFailure(accounting, readFailure?.code ?? 'search_data_missing', 502);
        return c.json(
          {
            error: readFailure?.code ?? 'search_data_missing',
            message: readFailure?.message ?? '联网搜索失败',
          },
          502,
          failureHeaders(requestId, settled),
        );
      }
      break;
    }

    // Gas 照收，Token 不收：这次调用已经真的打出去了；上游的原话原样交回，它比一句概括有用。
    const text = await reply.text();
    failure = {
      status: reply.status,
      contentType: reply.headers.get('Content-Type') ?? 'application/json',
      text,
    };
    if (host !== undefined && index + 1 < hosts.length && isModelNotServed(reply.status, text, host)) {
      continue;
    }
    break;
  }

  if (answer === null) {
    const settled = await recordFailure(accounting, 'provider_error', failure?.status ?? 502);
    return new Response(failure?.text ?? '', {
      status: failure?.status ?? 502,
      headers: {
        'Content-Type': failure?.contentType ?? 'application/json',
        ...failureHeaders(requestId, settled),
      },
    });
  }

  // 自有上游也按真价记（自转自，余额只减 Gas）：报价由方言自己算——直连搜索按次
  // （一次 750,000 纳美元），宿主模型那条按上游报的 token。折成 0 会让账本说不出这次
  // 搜索实际值多少钱（`billing.ts` 与 `store.settle` 的同一句话）。
  const meta = await settleBill(accounting, {
    status: 'ok',
    statusCode: upstreamStatus,
    tokenNanos: codec.quote(answer),
    usage: answer.usage,
    audio: ZERO_AUDIO_USAGE,
  });

  // 钱就写在这次响应里：上层网关（NormAI）结算读的是 `cost_usd_nanos`，而它和
  // `norm.fee_nanos` 是同一个数——一个请求一次往返，没有「先转出去、后回捞」。
  return c.json(
    {
      created: Math.floor(startedAt / 1000),
      source: ask.protocol,
      sources: answer.sources,
      cost_usd_nanos: meta.fee_nanos,
      norm: meta,
    },
    200,
    receiptHeaders(meta),
  );
});
