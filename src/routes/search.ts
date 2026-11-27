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
import { HttpError, fail } from '../http';
import { uuidv7 } from '../ids';
import { ZERO_AUDIO_USAGE } from '../pricing';
import { protocolFor } from '../protocols';
import { affinityKeyOf } from '../routing';
import { readSearchAsk, searchCodecForProtocol, type SearchAnswer } from '../search';
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
 * 计价单位是**次**：按上游价目，一次成功的搜索 750,000 纳美元，失败、超时与无结果不收。
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
  const codec = searchCodecForProtocol(ask.protocol);

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
    search: codec.dialect,
    gas,
    pendingRequiredNanos: pendingTouch + GAS_SETTLE_NANOS,
    abortOnInsufficientBalance: true,
  });
  const provider = choice.provider;
  const profile = protocolFor(provider.protocol);
  // 选址已经按方言筛过，走到了这里说明它确实说的是这一条。
  if (profile.search !== codec.dialect) {
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
        body: codec.encode(ask),
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
    // Gas 照收，Token 不收：这次调用已经真的打出去了；上游的原话原样交回，它比一句概括有用。
    const settled = await recordFailure(accounting, 'provider_error', reply.status);
    return new Response(await reply.text(), {
      status: reply.status,
      headers: {
        'Content-Type': reply.headers.get('Content-Type') ?? 'application/json',
        ...failureHeaders(requestId, settled),
      },
    });
  }

  let answer: SearchAnswer;
  try {
    answer = await codec.read(reply);
  } catch (error) {
    // 上游回了 200，却没有一页结果（或回的不是搜索信封）：这次搜索不算成功，Token 费不收，
    // 但那次上游请求真的发生过，Gas 照收——与文本、音频的失败同一口径。
    const failure = error instanceof HttpError ? error : null;
    const settled = await recordFailure(accounting, failure?.code ?? 'search_data_missing', 502);
    return c.json(
      { error: failure?.code ?? 'search_data_missing', message: failure?.message ?? '联网搜索失败' },
      502,
      failureHeaders(requestId, settled),
    );
  }

  // 自有上游只付 Gas：自己直接付给上游厂商，Norm 不在这两者之间转一笔钱。
  // 报价由方言自己算：直连搜索按次（一次 750,000 纳美元），宿主模型那条按上游报的 token。
  const meta = await settleBill(accounting, {
    status: 'ok',
    statusCode: reply.status,
    tokenNanos: provider.address === address ? 0 : codec.quote(answer),
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
