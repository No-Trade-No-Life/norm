import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { minBalanceNanos } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { needsConsumerTouch, touchConsumer } from '../consumers';
import { dialectCodecFor } from '../codecs';
import {
  carriesOutput,
  parseInbound,
  readAnswer,
  renderInbound,
  streamEmitter,
  streamError,
  usageSniffer,
  type AnswerCore,
  type Dialect,
  type NormMeta,
} from '../dialects';
import {
  D1_ROW_WRITES,
  GAS_CONSUMER_TOUCH_NANOS,
  GAS_SCHEDULE,
  GAS_SETTLE_NANOS,
  GAS_TOKEN_TRANSFER_NANOS,
  GasMeter,
} from '../gas';
import { fail } from '../http';
import { nowSeconds, uuidv7 } from '../ids';
import { isModelNotServed } from '../models';
import { quote, ZERO_AUDIO_USAGE } from '../pricing';
import { providerCredential } from '../credentials';
import { dropProviderModel, forgetAffinity, resolveProvider, type ProviderChoice } from '../store';
import { sendUpstream } from '../tunnel';
import {
  failureHeaders,
  normMeta,
  receiptHeaders,
  recordFailure,
  settleBill,
  type Accounting,
} from './billing';
import { affinityHash, affinityKeyOf } from '../routing';
import { sessionIdFor } from '../sessions';
import { protocolFor, protocolUrlFor, rateAt } from '../protocols';

type RelayContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * 转发面：四条入口方言 + 可复用的上游协议契约。
 *
 * 直通判定只比较线缆方言（`entry.dialect === profile.dialect`）：
 *   - 同方言直通：请求体按原始字节发出去，响应体原样回来（只多一个 `norm` 字段）；
 *   - 跨方言桥接：入口 → 规范中间态（`ChatBody`）→ 上游方言编解码（`src/codecs.ts`）→ 回来时渲染成入口方言。
 *
 * 翻译层只按 4 种方言分发（复杂度 4 + 4），上游厂商协议（`deepseek` / `opencode-go` 等）只声明复用的方言与传输/计价契约。
 *
 * 两件事只在本请求的作用域里成立，不落库：上游提供商明文密钥（BYOK）、请求与响应内容（ZDR）。
 */
export const relayRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

/* ── 四条入口 ──────────────────────────────────────────────────────
 * Gemini 的模型在路径上、流式也在路径上（`:streamGenerateContent`），所以它多一个
 * 从路径取参数的入口；另外三条都从 body 里读。
 */
relayRoutes.post('/chat/completions', (c: RelayContext) => proxy(c, { dialect: 'openai-chat' }));
relayRoutes.post('/responses', (c: RelayContext) => proxy(c, { dialect: 'openai-responses' }));
relayRoutes.post('/messages', (c: RelayContext) => proxy(c, { dialect: 'anthropic-messages' }));
relayRoutes.post('/models/:target', (c: RelayContext) => {
  // `gemini-2.0-flash:streamGenerateContent` —— 模型名与动作被一个冒号拼在同一段里。
  const [model = '', action = ''] = (c.req.param('target') ?? '').split(':');
  if (action !== 'generateContent' && action !== 'streamGenerateContent') {
    fail(404, 'not_found', `不认识这个 Gemini 方法：${action || '(缺少 :action)'}`);
  }
  return proxy(c, { dialect: 'google-gemini', model, stream: action === 'streamGenerateContent' });
});

type Entry = { dialect: Dialect; model?: string; stream?: boolean };

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * 这条 SSE 帧是不是「只有用量、没有内容」的那一条。
 *
 * OpenAI 兼容的流在 `stream_options.include_usage` 时会在结尾补一条
 * `{"choices":[],"usage":{…}}`——没有文本增量，客户端拿它只为对账。
 * 我们自己要来的那一条不该突然出现在没要求的客户端面前。
 */
function usageOnlyFrame(payload: string): boolean {
  try {
    const json = JSON.parse(payload) as Record<string, unknown>;
    const choices = json.choices;
    return json.usage !== undefined && json.usage !== null && (!Array.isArray(choices) || choices.length === 0);
  } catch {
    return false;
  }
}

/**
 * 给上游补一句「把用量也回给我」：OpenAI 兼容的流默认**不**回 usage，而账本就靠它算钱。
 * 少了这一步，真实的流式调用在账本上永远是 0 / 0 / 0，只剩一笔 Gas。
 */
/**
 * 把 `store` 钉成 false：这条上游只认这一个值（写 true、或不写，回的都是
 * `400 Store must be set to false`）。只对声明了 `store_false` 的协议生效。
 */
const withStoreFalse = (body: string): string => JSON.stringify({ ...obj(JSON.parse(body)), store: false });

const withUsage = (body: Record<string, unknown>): string =>
  JSON.stringify({ ...body, stream_options: { ...obj(body.stream_options), include_usage: true } });

/** 一次请求最多试两条上游：够覆盖「清单里那条其实不认这个型号」，又不会变成一次扫荡。 */
const MAX_ATTEMPTS = 2;

/** 上游的原话：状态码 + 响应体。改写它只会让「为什么失败」更难查。 */
type UpstreamFailure = { status: number; contentType: string; text: string };

async function proxy(c: RelayContext, entry: Entry): Promise<Response> {
  const principal = c.get('principal');
  const address = principal.address;

  // 原始字节先留住：同格式直通要把它一个字节不改地发出去。模型名也要在选址之前读出来
  // ——路由按模型筛候选，不先知道跑什么，就等于没筛。
  const rawBody = await c.req.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    fail(400, 'body_invalid', '请求体必须是 JSON');
  }

  const model = entry.model ?? (typeof raw.model === 'string' ? raw.model : '');
  const stream = entry.stream ?? raw.stream === true;
  // 客户端有没有要求用量：OpenAI 兼容的流默认**不**回 usage，要它得显式 include_usage。
  const wantsUsage = obj(raw.stream_options).include_usage === true;

  // 亲和键只取一次：选址用它，要会话 id 的协议（OpenCode Go）也用它。
  const affinity = affinityKeyOf(c.req.raw.headers);

  // UUID v7：字典序即时间序，账本按时间翻页就是按主键翻页。
  const requestId = uuidv7();
  const startedAt = Date.now();
  // 动态 Gas 计量器：从 300 纳（Worker 调用）起累加所有实际经过的付费点，
  // 余额快照来自鉴权阶段 consumers JOIN principals（零额外 D1 读）。
  const gas = new GasMeter({
    availableNanos: principal.balanceNanos,
    minBalanceNanos: minBalanceNanos(c.env),
  });
  // 闸门 A（入口安全阈值）：低于安全阈值直接 402 拒绝，0 次 D1 写、0 次上游请求。
  if (!gas.canStart()) {
    fail(
      402,
      'insufficient_balance',
      `余额不足：至少需要 ${gas.minBalanceNanos} 纳美元安全余额，当前 ${principal.balanceNanos}`,
    );
  }

  /** 是否已满足本日 consumers.last_used_at 记录：按 UTC 自然日节流，每天最多写 1 行，同日后续 0 写、+0 Gas。 */
  let consumerTouched = !needsConsumerTouch(principal.consumerLastUsedAt, Math.floor(startedAt / 1000));
  /** 这次请求试过的上游：重挑时传给选址，保证换的是另一条。 */
  const tried: string[] = [];
  /** 上一条候选的原话：换候选换到没得换时，交回去的应该是它，不是一句「没有候选」。 */
  let refused: { failure: UpstreamFailure; accounting: Accounting } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const pendingTouch = consumerTouched ? 0 : GAS_CONSUMER_TOUCH_NANOS;
    // 走哪条上游是 Norm 自己的决定，调用方一个头都不用带：模型跑得了是前提，自己的上游
    // 优先、公共池兜底，同一个 thread-id / session-id 粘在同一条上（见 store.resolveProvider）。
    let choice: ProviderChoice;
    try {
      choice = await resolveProvider(c.env, address, affinity, {
        model,
        exclude: tried,
        gas,
        pendingRequiredNanos: pendingTouch + GAS_SETTLE_NANOS,
        abortOnInsufficientBalance: attempt === 0,
      });
    } catch (error) {
      // 换候选时发现没有下一条了：这不是新错误，把上一条上游的原话交回去。
      if (attempt > 0 && refused) return upstreamFailure(c, refused.accounting, refused.failure);
      throw error;
    }
    const provider = choice.provider;
    tried.push(provider.id);

    const profile = protocolFor(provider.protocol);
    const codec = dialectCodecFor(profile.dialect);
    // 「同格式直通」比的是**线缆上的方言**，不是协议值的字面：`deepseek` 说 Responses，
    // 所以 Responses 客户端打给它一样一个字节都不动。
    const sameShape = entry.dialect === profile.dialect;

    // 这一轮转发实际会产生的 CPU 成本：二次重试多一次基础 CPU，跨方言多桥接 CPU，流式多拆帧 CPU。
    const attemptCpu =
      (attempt > 0 ? GAS_SCHEDULE.cpu_base : 0) +
      (sameShape ? 0 : GAS_SCHEDULE.cpu_bridge) +
      (stream ? GAS_SCHEDULE.cpu_stream : 0);

    // 闸门 B（发往上游前预算检查）：如果写亲和或高成本路径后余额已不够覆盖本次执行与结算，
    // 在首次尝试阶段直接 402 中止——省掉 consumer_touch、上游 fetch 与 settle 写库。
    // 调用他人/公共池上游时预留 1 行跨用户转账写库 Gas（失败时不会实际发生）。
    const pendingTransfer = choice.via === 'pool' ? GAS_TOKEN_TRANSFER_NANOS : 0;
    const gateBNeeded = attemptCpu + pendingTouch + pendingTransfer + GAS_SETTLE_NANOS;
    if (attempt === 0 && !gas.canAfford(gateBNeeded)) {
      fail(
        402,
        'insufficient_balance',
        `余额不足：本次请求预计需要 ${gas.projectedTotal(gateBNeeded)} 纳美元 Gas，当前 ${principal.balanceNanos}`,
      );
    }

    if (attemptCpu > 0) gas.charge(attemptCpu);
    if (!consumerTouched) {
      await touchConsumer(c.env, principal.consumerId);
      gas.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
      consumerTouched = true;
    }

    // 明文密钥在库里是密文，用 Worker secret 里那把高熵对称密钥现解现用，只在本次请求的
    // 作用域里存在：不写日志、不进响应、不返回给客户端。
    //
    // 解封用的是**持有者**的地址，不是调用方的：公共池里那条属于站点，调用方只是借用。
    // OAuth 协议的凭据会过期，换新也在这一步里（见 `credentials.ts`）。
    let providerKey: string;
    try {
      providerKey = await providerCredential({ env: c.env, address: provider.address, provider });
    } catch (error) {
      // 这把钥匙用不了（换新被上游拒了、密文解不开）：请求根本没打出去，所以不记账，
      // 但必须把原因交回去——「服务内部错误」会把唯一一条能诊断的信息吞掉。
      return c.json({ error: 'provider_credential_unavailable', message: (error as Error).message }, 502);
    }

    // 只认流式的上游（ChatGPT 的 responses 端点）在这里把注定失败的请求挡住：
    // 放过去，代价是一次上游 400 加一笔 Gas，换来的还是一句「stream must be true」。
    if (profile.stream_only === true && !stream) {
      fail(400, 'stream_required', `${provider.protocol} 协议的上游只接受流式请求：请带 "stream": true`);
    }

    /**
     * 会话头：有的上游（OpenCode Go）缺了它连路由都不做，直接 400 `MissingSessionID`。
     * 值由 `sessions.ts` 从这次请求派生，调用方自报的原值永远不上行——它只影响
     * 提示词缓存命中，不该成为一条能把两段对话对齐起来的明文线索。
     */
    const sessionHeaders = profile.session_header
      ? {
          [profile.session_header]: sessionIdFor({ address, headers: c.req.raw.headers, affinity, body: raw, model }),
        }
      : {};

    /**
     * 发往上游的请求体。
     *
     * 同格式直通按原始字节发出去——唯一的例外是流式请求打向 openai-chat 上游时：那种上游
     * 默认不回 token 用量，而账本就靠它算钱。跨方言则整份重说一遍。
     */
    const askForUsage = stream && profile.dialect === 'openai-chat';
    const outbound = sameShape
      ? askForUsage
        ? withUsage(raw)
        : rawBody
      : askForUsage
        ? withUsage(codec.encodeRequest(parseInbound(entry.dialect, raw, model, stream), model) as Record<string, unknown>)
        : JSON.stringify(codec.encodeRequest(parseInbound(entry.dialect, raw, model, stream), model));

    // 有的上游只认 `store: false`（ChatGPT 的 responses 端点：写 true 或干脆不写，回的都是
    // `400 Store must be set to false`）。补在这一层，是因为它既可能是客户端的原始字节，
    // 也可能是刚由桥重建出来的请求体——同一条路补一次，就不用两条路各写一遍。
    const upstreamBody = profile.store_false === true ? withStoreFalse(outbound) : outbound;

    // 分时价（DeepSeek 高峰 / 低谷）的档位在请求开始的这一刻定下，之后算账都用它：
    // 跨过档位边界的请求按起点算，不按收尾算（与 DeepSeek LB 同一口径）。
    const rate = rateAt(provider.protocol, model, Math.floor(startedAt / 1000));
    // 唯一关于上游提供商的事实：它落在哪台主机上。是否"可信"由清单决定，记账不需要知道。
    const host = hostOf(provider.base_url);
    const accounting: Accounting = {
      env: c.env,
      address,
      providerId: provider.id,
      providerUser: provider.address,
      consumerUser: principal.consumerId ? address : null,
      /** 这一单是不是落到了公共池上：账单里要说，否则「为什么打到别人的主机」无从解释。 */
      pool: choice.via === 'pool',
      // 谁花的：消费者密钥的 id；签名直连时为空（那是人，不是一把程序凭据）。
      consumerId: principal.consumerId,
      baseUrl: provider.base_url,
      requestId,
      startedAt,
      gas,
      host,
      model,
      rate,
    };

    let reply: Response;
    try {
      // 配了代理就进隧道（见 `src/proxy.ts`）：这条路绕开的不是可达性，而是目标站对
      // 「这请求是 Cloudflare 发的」的判定。
      reply = await sendUpstream({
        env: c.env,
        address: provider.address,
        provider,
        url: protocolUrlFor(provider.protocol, provider.base_url, model, stream),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...profile.headers(providerKey), ...sessionHeaders },
          body: upstreamBody,
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

    if (reply.ok) {
      if (stream) {
        return sameShape
          ? passThroughStream({ ...accounting, reply, dialect: entry.dialect, wantsUsage })
          : bridgeStream({ ...accounting, reply, entry: entry.dialect, upstream: profile.dialect, wantsUsage });
      }

      const json = await reply.json<Record<string, unknown>>();
      const core = readAnswer(profile.dialect, json);
      const billed = await bill(accounting, core, reply.status);
      // 同格式：响应体一个字段都不动，只把 `norm` 作为附加字段挂上去。
      // 跨方言：整个响应由 renderInbound 说出入口方言。
      // 同形直通：`cost_usd_nanos` 与 `norm` 一起挂上去，上层网关读顶层字段就能记账；
      // 跨方言则由 `renderInbound` 说入口方言（账目仍在这四个回执头上，与音频同一套）。
      const body = sameShape
        ? { ...json, cost_usd_nanos: billed.fee_nanos, norm: billed }
        : renderInbound(entry.dialect, core, billed);
      return c.json(body as Record<string, unknown>, 200, receiptHeaders(billed));
    }

    // Gas 照收，token 不收：这次调用已经真的打出去了（Worker 与 D1 的成本都发生过），
    // 上游回什么也改不了这一点；没有答案，就没有可计价的 token。
    const failure: UpstreamFailure = {
      status: reply.status,
      contentType: reply.headers.get('Content-Type') ?? 'application/json',
      text: await reply.text(),
    };
    refused = { failure, accounting };

    // 上游说「我没有这个型号」——错的是路由依据，不是请求：把清单里那一行划掉、忘掉这条
    // 会话的粘性，换一条候选再试一次。只换一次，而且只在上游原话点名了这次的模型时。
    // 少了这一步，一次按错清单的选择会让同一条会话在亲和表里错满整个 TTL（7 天）。
    if (attempt + 1 < MAX_ATTEMPTS && isModelNotServed(failure.status, failure.text, model)) {
      // 闸门 C（二次重试前熔断）：余额不够覆盖「清理写库 + 二次执行 + 结算」时放弃重试，
      // 直接结算第 1 次失败并返回上游原话，替双方省掉清理 D1 写与第 2 次上游调用。
      const retryEstimate =
        (D1_ROW_WRITES.provider_model_delete + (affinity ? D1_ROW_WRITES.affinity_delete : 0)) *
          GAS_SCHEDULE.d1_row_write +
        GAS_SCHEDULE.cpu_base +
        GAS_SETTLE_NANOS;
      if (!gas.canAfford(retryEstimate)) {
        return upstreamFailure(c, accounting, failure);
      }

      const dropped = await dropProviderModel(c.env, provider.id, model);
      if (dropped > 0) gas.chargeD1Writes(dropped * D1_ROW_WRITES.provider_model_delete);
      if (affinity) {
        const forgotten = await forgetAffinity(c.env, address, affinityHash(address, affinity.value));
        if (forgotten > 0) gas.chargeD1Writes(forgotten * D1_ROW_WRITES.affinity_delete);
      }
      continue;
    }

    return upstreamFailure(c, accounting, failure);
  }

  // 循环正常走完说明每一条候选都试过了（最后一条的失败本该在上面返回）。
  fail(502, 'provider_candidates_exhausted', '试过的上游都没跑通这次调用');
}

/** 失败响应：上游的原话原样回（它不是记账数据），这一笔扣了多少挂在响应头上。 */
async function upstreamFailure(c: RelayContext, accounting: Accounting, failure: UpstreamFailure): Promise<Response> {
  const settled = await recordFailure(accounting, 'provider_error', failure.status);
  return new Response(failure.text, {
    status: failure.status,
    headers: { 'Content-Type': failure.contentType, ...failureHeaders(accounting.requestId, settled) },
  });
}

/* ── 记账 ─────────────────────────────────────────────────────────── */

/**
 * 文本调用的账单：用量按 token 价目折成钱，剩下的（扣 Gas、扣 Token、写请求行）
 * 交给 `billing.ts`——音频那条路用的是同一份，两条路不该各算一次钱。
 */
async function bill(accounting: Accounting, answer: AnswerCore, statusCode: number): Promise<NormMeta> {
  const tokenNanos =
    accounting.providerUser === accounting.address ? 0 : quote(accounting.model, answer.usage, accounting.rate).total_nanos;
  return settleBill(accounting, {
    status: 'ok',
    statusCode,
    tokenNanos,
    usage: answer.usage,
    audio: ZERO_AUDIO_USAGE,
  });
}

/* ── 流式：同格式直通 ─────────────────────────────────────────────── */

/**
 * 同格式直通：上游提供商的 SSE 原样往下走，我们只在末尾记账。
 *
 * 用量在流里只出现一两次（见 dialects.ts 的 usageSniffer），所以这里一边转发一边嗅，
 * 到收尾时才计价——流式的 token 数只有末帧才知道。
 *
 * 唯一例外是 openai-chat：Norm 自己的「多轮对话」是这条路的客户端，它靠流末那条
 * `{"norm":…}` 显示本次调用的费用与余额。另外三条路的客户端是第三方 SDK，
 * 它们的解析器我们管不着，所以一个事件都不插——request_id 走 `X-Norm-Request-Id`。
 */
function passThroughStream(accounting: Accounting & { reply: Response; dialect: Dialect; wantsUsage: boolean }): Response {
  const { reply, dialect, wantsUsage } = accounting;
  const source = reply.body;
  if (!source) return new Response('上游提供商没有返回流', { status: 502 });
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const injectNorm = dialect === 'openai-chat';
  const sniffer = usageSniffer(dialect);
  /**
   * 每读到一帧就做两件事：喂用量嗅探器，并把「第一个字」的时刻记下来。
   * 首字按真正的文本增量算，不按第一帧算——第一帧往往只有一个空的 delta.role。
   */
  /** 上游在流里报的错：拿到它、又一个字都没生成，这一单就不是「成功」。 */
  let upstreamError: string | null = null;
  const noteFrame = (payload: string) => {
    sniffer.push(payload);
    if (accounting.firstTokenMs === undefined && carriesOutput(dialect, payload)) {
      accounting.firstTokenMs = Date.now() - accounting.startedAt;
    }
    // 上游也可能在 200 的流里说「我失败了」。记下来，收尾时按它算账。
    if (upstreamError === null) upstreamError = streamError(dialect, payload);
  };
  const requestId = accounting.requestId;
  let buffer = '';
  let finished = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    // 一个字节都没生成、上游却报了错：这不是「成功但零 token」。照失败收 Gas、不收
    // token——否则一次上游拒绝会在账本上被记成一次正常执行，而客户端只看到一片空白。
    if (upstreamError !== null && accounting.firstTokenMs === undefined) {
      return normMeta(
        accounting,
        { status: 'ok', statusCode: 200, tokenNanos: 0, usage, audio: ZERO_AUDIO_USAGE },
        await recordFailure(accounting, 'provider_error', 200),
      );
    }
    return bill(accounting, { text: '', toolCalls: [], model: accounting.model, usage, createdAt: 0 }, 200);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      // Cloudflare workerd 的 ReadableStream 要求每次 pull 至少 enqueue 一块或关闭流；
      // 若单个 TCP 分片里没有换行、或只含被跳过的 `data: [DONE]` / 额外用量帧而直接 return，
      // workerd 会提前结束响应流，导致内容截断且 finish()/settle() 永远不被执行。
      let enqueued = false;
      const push = (bytes: Uint8Array) => {
        enqueued = true;
        controller.enqueue(bytes);
      };

      try {
        while (!enqueued) {
          const { value, done } = await reader.read();

          if (value) {
            if (!injectNorm) {
              // 字节一个都不改（这几条路的客户端是第三方 SDK），但要把用量读出来：
              // 不读，responses / anthropic / gemini 的流式调用在账本上就是 0 / 0 / 0。
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload.length === 0 || payload === '[DONE]') continue;
                noteFrame(payload);
              }
              if (value.byteLength > 0) push(value);
            } else {
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                // 上游提供商的 `[DONE]` 由我们自己发：这样 norm 一定排在它前面。
                if (line.trim() === 'data: [DONE]') continue;
                if (line.startsWith('data:')) {
                  const payload = line.slice(5).trim();
                  noteFrame(payload);
                  // 我们自己要来记账的那条用量帧：客户端没要就不转发。
                  if (!wantsUsage && usageOnlyFrame(payload)) continue;
                }
                push(encoder.encode(`${line}\n`));
              }
            }
          }

          if (!done) continue;
          finished = true;
          buffer += decoder.decode();

          if (injectNorm) {
            if (buffer.length > 0 && buffer.trim() !== 'data: [DONE]') {
              if (buffer.startsWith('data:')) {
                const payload = buffer.slice(5).trim();
                noteFrame(payload);
                if (wantsUsage || !usageOnlyFrame(payload)) push(encoder.encode(buffer));
              } else {
                push(encoder.encode(buffer));
              }
            }
            const meta = await finish();
            // 入口是 chat 且客户端要了用量：上游那一家可能把用量放在别的帧里，
            // 这里统一补一条 chat 形状的用量帧（choices 为空），OpenAI SDK 认这个形状。
            if (wantsUsage) {
              const usageChunk = {
                object: 'chat.completion.chunk',
                model: accounting.model,
                choices: [],
                usage: {
                  prompt_tokens: meta.input_tokens,
                  completion_tokens: meta.output_tokens,
                  total_tokens: meta.input_tokens + meta.output_tokens,
                  prompt_tokens_details: { cached_tokens: meta.cached_tokens },
                },
              };
              push(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
            }
            push(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
          } else {
            // 上游有时不补换行，最后一段留在 buffer 里——它可能就是那条 response.completed。
            const rest = buffer.startsWith('data:') ? buffer.slice(5).trim() : '';
            if (rest.length > 0 && rest !== '[DONE]') noteFrame(rest);
            await finish();
          }
          controller.close();
          return;
        }
      } catch (error) {
        if (!finished) {
          finished = true;
          if (!accounting.gas.isFinalized) {
            await recordFailure(accounting, 'network_error', 502).catch(() => undefined);
          }
        }
        controller.error(error);
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': reply.headers.get('Content-Type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Norm-Request-Id': requestId,
    },
  });
}

/* ── 流式：跨方言 ─────────────────────────────────────────────────── */

/**
 * 跨方言流：上游方言 SSE → 规范事件（`src/codecs.ts` 负责）→ 入口方言的帧（`src/dialects.ts` 负责）。
 *
 * 注意入参只收 `upstream: Dialect`、不收 `Protocol`：流式翻译永远只按线缆方言分发，与厂商协议无关。
 *
 * 用量同样一边嗅一边转发。这里比直通多一件事：入口若是 Gemini / Anthropic / Responses，
 * 收尾帧必须带上最终 token 数——那正是我们记账用的那一份，于是「账」与「回给客户端的
 * 用量」永远一致，不会出现「扣了钱但报 0 token」。
 */
function bridgeStream(accounting: Accounting & { reply: Response; entry: Dialect; upstream: Dialect; wantsUsage: boolean }): Response {
  const { reply, entry, upstream, wantsUsage } = accounting;
  const source = reply.body;
  if (!source) return new Response('上游提供商没有返回流', { status: 502 });

  const codec = dialectCodecFor(upstream);
  const emitter = streamEmitter(entry, accounting.requestId, accounting.model);
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (chunks: string[]) => chunks.map((chunk) => encoder.encode(chunk));
  const toChat = entry === 'openai-chat';
  const sniffer = usageSniffer(upstream);
  /** 上游在流里报的错：拿到它、又一个字都没生成，这一单就不是「成功」。 */
  let upstreamError: string | null = null;
  const noteFrame = (payload: string) => {
    sniffer.push(payload);
    if (accounting.firstTokenMs === undefined && carriesOutput(upstream, payload)) {
      accounting.firstTokenMs = Date.now() - accounting.startedAt;
    }
    // 跨方言这条路上，认不出的帧会被编解码器丢掉——错误帧也在其中。这一丢，客户端就只剩
    // 「200 + 空白」，所以这里单独认一次，收尾时把原话说回去。
    if (upstreamError === null) upstreamError = streamError(upstream, payload);
  };
  /**
   * 这次回答里的工具调用，按上游给的序号攒着：参数是增量的，收尾时要用完整的那一份，
   * 而 emitter 各家的编号与拼装方式都不同，不能反过来从它那儿读。
   *
   * `forwarded` 是已经发给客户端的参数长度：有的上游把 id 与名字分两帧发，名字到齐之前
   * 参数就已经在路上了，那一段要等 tool_start 开出去之后再补发，不能丢。
   */
  const calls = new Map<number, { id: string; name: string; arguments: string; started: boolean; forwarded: number }>();
  let buffer = '';
  let done = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    // 同上：空白 + 上游报错 = 一次失败，不是一次「成功但零 token」。
    if (upstreamError !== null && accounting.firstTokenMs === undefined) {
      return normMeta(
        accounting,
        { status: 'ok', statusCode: 200, tokenNanos: 0, usage, audio: ZERO_AUDIO_USAGE },
        await recordFailure(accounting, 'provider_error', 200),
      );
    }
    return bill(accounting, { text: '', toolCalls: [], model: accounting.model, usage, createdAt: 0 }, 200);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 跨方言开场帧（Anthropic 的 message_start / content_block_start，
      // Responses 的 response.created / output_item.added / content_part.added）：
      // 官方 SDK 的流式状态机依赖开场事件初始化消息对象，缺了会在 delta 处报错或丢字。
      emit(emitter.head()).forEach((bytes) => controller.enqueue(bytes));
    },
    async pull(controller) {
      if (done) return;
      // 同 passThroughStream：持续读取直到至少产出 1 块输出或上游 EOF，
      // 防止部分 TCP 分片、空 role 帧或独立 `[DONE]` 帧触发 0-enqueue pull 导致 workerd 提前断流。
      let enqueued = false;
      const push = (bytes: Uint8Array) => {
        enqueued = true;
        controller.enqueue(bytes);
      };
      const processLine = (line: string) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === '[DONE]') return;
        noteFrame(data);
        for (const event of codec.decodeStreamEvents(data, calls.size)) {
          if (event.kind === 'text') {
            emit(emitter.delta(event.text)).forEach(push);
            continue;
          }
          if (event.kind === 'tool_start') {
            const call = calls.get(event.index) ?? { id: '', name: '', arguments: '', started: false, forwarded: 0 };
            call.id = event.id || call.id;
            call.name = event.name || call.name;
            calls.set(event.index, call);
            if (!call.started && call.name.length > 0) {
              call.started = true;
              emit(emitter.toolStart(event.index, { id: call.id, name: call.name })).forEach(push);
              const pending = call.arguments.slice(call.forwarded);
              if (pending.length > 0) {
                call.forwarded = call.arguments.length;
                emit(emitter.toolArgs(event.index, pending)).forEach(push);
              }
            }
            continue;
          }
          const call = calls.get(event.index);
          if (!call) continue;
          call.arguments += event.args;
          if (call.started) {
            call.forwarded = call.arguments.length;
            emit(emitter.toolArgs(event.index, event.args)).forEach(push);
          }
        }
      };

      try {
        while (!enqueued) {
          const { value, done: finished } = await reader.read();

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) processLine(line);
          }

          if (!finished) continue;
          done = true;
          buffer += decoder.decode();
          if (buffer.length > 0) processLine(buffer);

          const meta = await finish();
          const core: AnswerCore = {
            text: '',
            toolCalls: [...calls.values()].map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments.length > 0 ? call.arguments : '{}',
            })),
            model: accounting.model,
            usage: { input: meta.input_tokens, cached: meta.cached_tokens, output: meta.output_tokens },
            createdAt: Math.floor(Date.now() / 1000),
          };

          if (toChat) {
            // 一句话都没生成时，把上游的原话交出去：空白的 200 是最难查的一种失败。
            if (upstreamError !== null && accounting.firstTokenMs === undefined) {
              push(encoder.encode(`data: ${JSON.stringify({ error: { message: upstreamError } })}\n\n`));
            } else {
              // 无参工具调用在 Chat 流里补 `{}`，避免严格客户端 JSON.parse("") 崩溃。
              for (const [index, call] of calls.entries()) {
                if (call.started && call.arguments.length === 0) {
                  emit(emitter.toolArgs(index, '{}')).forEach(push);
                }
              }
              // 补发 finish_reason（stop / tool_calls）：OpenAI SDK 与 Agent 框架靠它收尾或触发工具执行。
              emit(emitter.tail(core)).forEach(push);
              if (wantsUsage) {
                const usageChunk = {
                  object: 'chat.completion.chunk',
                  model: accounting.model,
                  choices: [],
                  usage: {
                    prompt_tokens: meta.input_tokens,
                    completion_tokens: meta.output_tokens,
                    total_tokens: meta.input_tokens + meta.output_tokens,
                    prompt_tokens_details: { cached_tokens: meta.cached_tokens },
                  },
                };
                push(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
              }
            }
            push(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
          } else {
            emit(emitter.tail(core)).forEach(push);
          }
          controller.close();
          return;
        }
      } catch (error) {
        if (!done) {
          done = true;
          if (!accounting.gas.isFinalized) {
            await recordFailure(accounting, 'network_error', 502).catch(() => undefined);
          }
        }
        controller.error(error);
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Norm-Request-Id': accounting.requestId,
    },
  });
}
