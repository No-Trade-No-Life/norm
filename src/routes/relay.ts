import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { gasFeeNanos } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import {
  carriesText,
  parseInbound,
  readAnswer,
  renderInbound,
  streamEmitter,
  usageSniffer,
  type AnswerCore,
  type Dialect,
  type NormMeta,
} from '../dialects';
import { fail } from '../http';
import { nowSeconds, uuidv7 } from '../ids';
import { quote, type PriceAnchor, type Usage } from '../pricing';
import { unsealProviderKey } from '../seal';
import { findPrincipal, resolveProvider, settle, type RequestRecord, type Settled } from '../store';
import { affinityKeyOf } from '../routing';
import { sessionIdFor } from '../sessions';
import { adapterFor, protocolUrlFor, rateAt, type Protocol } from '../protocols';

type RelayContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * 转发面：四条入口方言 × 四种上游提供商协议。
 *
 * 入口与上游提供商用的是同一套名字，所以「入口方言 === 上游提供商协议」就是字符串相等，
 * 而那 4 格**不转换**：请求体按原始字节发出去，响应体原样回来（只多一个 `norm` 字段）。
 *
 * 其余 12 格才经过 OpenAI Chat 这座桥：入口 → ChatBody → 协议适配器 → 回来时渲染成入口方言。
 * 桥只在一侧出现，所以矩阵是 4 段入口翻译 + 4 段上游提供商适配，而不是 16 条路径。
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

async function proxy(c: RelayContext, entry: Entry): Promise<Response> {
  const principal = c.get('principal');
  const address = principal.address;

  // 走哪条上游是 Norm 自己的决定，调用方一个头都不用带：自己的上游优先、公共池兜底，
  // 同一个 thread-id / session-id 粘在同一条上（见 store.resolveProvider 与 routing.ts）。
  // 亲和键只取一次：选址用它，要会话 id 的协议（OpenCode Go）也用它。
  const affinity = affinityKeyOf(c.req.raw.headers);
  const choice = await resolveProvider(c.env, address, affinity);
  const provider = choice.provider;

  // 明文密钥在库里是密文，用 Worker secret 里那把高熵对称密钥现解现用，
  // 只在本次请求的作用域里存在：不写日志、不进响应、不返回给客户端。
  //
  // 解封用的是**持有者**的地址，不是调用方的：公共池里那条属于站点，调用方只是借用。
  const providerKey = await unsealProviderKey({
    env: c.env,
    address: provider.address,
    providerId: provider.id,
    sealed: provider.sealed_key,
  });

  // 原始字节先留住：同格式直通要把它一个字节不改地发出去。
  const rawBody = await c.req.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    fail(400, 'body_invalid', '请求体必须是 JSON');
  }

  const protocol = provider.protocol;
  const model = entry.model ?? (typeof raw.model === 'string' ? raw.model : '');
  const stream = entry.stream ?? raw.stream === true;

  // 目的地只能来自上游提供商：不读任何请求头。少了这一条，「钉死的 base_url」就只是句口号。
  const baseUrl = provider.base_url;
  const adapter = adapterFor(protocol);
  // 「同格式直通」比的是**线缆上的方言**，不是协议值的字面：`deepseek` 说 Responses，
  // 所以 Responses 客户端打给它一样一个字节都不动。
  const sameShape = entry.dialect === adapter.dialect;

  /**
   * 会话头：有的上游（OpenCode Go）缺了它连路由都不做，直接 400 `MissingSessionID`。
   * 值由 `sessions.ts` 从这次请求派生，调用方自报的原值永远不上行——它只影响
   * 提示词缓存命中，不该成为一条能把两段对话对齐起来的明文线索。
   */
  const sessionHeaders = adapter.session_header
    ? {
        [adapter.session_header]: sessionIdFor({ address, headers: c.req.raw.headers, affinity, body: raw, model }),
      }
    : {};

  // 客户端有没有要求用量：OpenAI 兼容的流默认**不**回 usage，要它得显式 include_usage。
  const wantsUsage = obj(raw.stream_options).include_usage === true;

  /**
   * 发往上游的请求体。
   *
   * 同格式直通按原始字节发出去——唯一的例外是流式请求打向 openai-chat 上游时：
   * 那种上游默认不回 token 用量，而账本就靠它算钱。所以这里补一个
   * `stream_options.include_usage`，并把多出来的那条用量帧吃掉（客户端没要就不转发）。
   * 少了这一步，真实的流式调用在账本上永远是 0 / 0 / 0，只剩一笔 Gas。
   */
  const withUsage = (body: Record<string, unknown>): string =>
    JSON.stringify({ ...body, stream_options: { ...obj(body.stream_options), include_usage: true } });
  const askForUsage = stream && adapter.dialect === 'openai-chat';

  const outbound = sameShape
    ? askForUsage
      ? withUsage(raw)
      : rawBody
    : askForUsage
      ? withUsage(adapter.request(parseInbound(entry.dialect, raw, model, stream), model) as Record<string, unknown>)
      : JSON.stringify(adapter.request(parseInbound(entry.dialect, raw, model, stream), model));

  // UUID v7：字典序即时间序，账本按时间翻页就是按主键翻页。
  const requestId = uuidv7();
  const startedAt = Date.now();
  // 分时价（DeepSeek 高峰 / 低谷）的档位在请求开始的这一刻定下，之后算账都用它：
  // 跨过档位边界的请求按起点算，不按收尾算（与 DeepSeek LB 同一口径）。
  const rate = rateAt(protocol, model, Math.floor(startedAt / 1000));
  // Gas 是「执行一次」的价：付不起就不打上游，也就没有这次执行，不记账。
  const gasFee = gasFeeNanos(c.env);
  const account = await findPrincipal(c.env, address);
  if (account.balance_nanos < gasFee) {
    fail(402, 'insufficient_balance', `余额不足：需要 ${gasFee} 纳美元，当前 ${account.balance_nanos}`);
  }

  // 唯一关于上游提供商的事实：它落在哪台主机上。是否"可信"由清单决定，记账不需要知道。
  const host = hostOf(baseUrl);
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
    baseUrl,
    requestId,
    startedAt,
    gasFee,
    host,
    model,
    rate,
  };

  let reply: Response;
  try {
    reply = await fetch(protocolUrlFor(protocol, baseUrl, model, stream), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(providerKey), ...sessionHeaders },
      body: outbound,
    });
  } catch (error) {
    const settled = await recordFailure(accounting, 'network_error', 502);
    return c.json(
      { error: 'provider_unreachable', message: `Provider 不可达：${(error as Error).message}` },
      502,
      failureHeaders(accounting.requestId, settled),
    );
  }

  if (!reply.ok) {
    // Gas 照收，token 不收：这次调用已经真的打出去了（Worker 与 D1 的成本都发生过），
    // 上游回什么也改不了这一点；没有答案，就没有可计价的 token。
    // 上游提供商的错误体原样返回——它不是记账数据，改写它只会让上游提供商的报错更难查；
    // 这一笔扣了多少，挂在响应头上。
    const text = await reply.text();
    const settled = await recordFailure(accounting, 'provider_error', reply.status);
    return new Response(text, {
      status: reply.status,
      headers: {
        'Content-Type': reply.headers.get('Content-Type') ?? 'application/json',
        ...failureHeaders(accounting.requestId, settled),
      },
    });
  }

  if (stream) {
    return sameShape
      ? passThroughStream({ ...accounting, reply, dialect: entry.dialect, wantsUsage })
      : bridgeStream({ ...accounting, reply, entry: entry.dialect, protocol, wantsUsage });
  }

  const json = await reply.json<Record<string, unknown>>();
  const core = readAnswer(adapter.dialect, json);
  const billed = await bill(accounting, core, reply.status);
  // 同格式：响应体一个字段都不动，只把 `norm` 作为附加字段挂上去。
  // 跨方言：整个响应由 renderInbound 说出入口方言。
  const body = sameShape ? { ...json, norm: billed } : renderInbound(entry.dialect, core, billed);
  return c.json(body as Record<string, unknown>);
}

/* ── 记账 ─────────────────────────────────────────────────────────── */

/** 一次调用在记账时需要知道的一切，与它最终成功还是失败无关。 */
type Accounting = {
  env: Env;
  address: string;
  providerId: string;
  /** 收钱的那一方的地址：公共池时是站点的地址，不是调用方的。 */
  providerUser: string;
  /** 花钱的那一方的地址：消费者密钥属于谁；签名直连时为空。 */
  consumerUser: string | null;
  /** true = 公共池兜底，false = 自己名下的上游。 */
  pool: boolean;
  consumerId: string;
  /** 打到的上游提供商地址：账本要能回答「这一笔打给哪台机器」。 */
  baseUrl: string;
  requestId: string;
  startedAt: number;
  /** 这一次「执行」的价，与成败无关。 */
  gasFee: number;
  host: string;
  model: string;
  /**
   * 这一次按哪一档计价：协议自带分时价时由请求开始的时刻定下（`rateAt`），
   * null = 用通用价目表。存下来是因为同一笔账要算两遍（账单结论 + 记账），两遍必须同价。
   */
  rate: PriceAnchor | null;
  /** 首字延迟：流式里第一个文本增量到达的时刻；非流式没有这个事件，留空。 */
  firstTokenMs?: number | null;
};

/**
 * 账单结论：总价、构成、三项 token、差多少没收到。
 *
 * `fee_nanos` 是真正扣掉的那个数，恒等于 `gas_fee_nanos + token_nanos - unbilled_nanos`；
 * 三个数一起回，是因为只回一个总数就没人能自己核对了。
 */
function normMeta(accounting: Accounting, usage: Usage, billed: { billedNanos: number; unbilledNanos: number; balanceNanos: number }): NormMeta {
  const price = quote(accounting.model, usage, accounting.rate);
  return {
    request_id: accounting.requestId,
    fee_nanos: billed.billedNanos,
    gas_fee_nanos: accounting.gasFee,
    token_nanos: price.total_nanos,
    input_tokens: usage.input,
    cached_tokens: usage.cached,
    output_tokens: usage.output,
    unbilled_nanos: billed.unbilledNanos,
    balance_nanos: billed.balanceNanos,
    latency_ms: Date.now() - accounting.startedAt,
    host: accounting.host,
    pool: accounting.pool,
  };
}

/** 把一次成功的调用折成钱、记下来，返回给客户端看的账单结论。 */
async function bill(accounting: Accounting, answer: AnswerCore, statusCode: number): Promise<NormMeta> {
  const price = quote(accounting.model, answer.usage, accounting.rate);
  const settled = await settle(accounting.env, recordOf(accounting, {
    answer,
    status: 'ok',
    statusCode,
    tokenNanos: price.total_nanos,
  }));
  return normMeta(accounting, answer.usage, settled);
}

/**
 * 失败也收 Gas，只免 token：能被记成失败的调用都已经真的打出去了（一次 Worker 调用、
 * 几次 D1 读写），那笔成本与上游回不回得出答案无关；没有答案，就没有可计价的量。
 * 记录仍然是完整的——打了哪台机器、用哪把钥匙、跑了多久，一个都不少。
 */
async function recordFailure(accounting: Accounting, status: string, statusCode: number): Promise<Settled> {
  return settle(accounting.env, recordOf(accounting, {
    status,
    statusCode,
    tokenNanos: 0,
    usage: { input: 0, cached: 0, output: 0 },
  }));
}

/** 失败响应是上游的原话，账单只能挂在头上：这一次到底扣了多少 Gas。 */
function failureHeaders(requestId: string, settled: Settled): Record<string, string> {
  return {
    'X-Norm-Request-Id': requestId,
    'X-Norm-Gas-Fee-Nanos': String(settled.billedNanos),
  };
}

function recordOf(
  accounting: Accounting,
  parts: { status: string; statusCode: number; tokenNanos: number; answer?: AnswerCore; usage?: Usage },
): RequestRecord {
  // 记客户端要的那个模型名，不记上游提供商回的那个：价格跟着它算，两者必须是同一个字符串，
  // 否则一个把自己响应改写成便宜模型的上游提供商就顺手给自己定了价。 上游提供商实际跑的版本
  // 是它的私事，账本不需要为此多一列。
  // 用量可能显式传（流式收尾时已经算好了），也可能藏在回答里（非流式）。
  const usage = parts.usage ?? parts.answer?.usage ?? { input: 0, cached: 0, output: 0 };
  return {
    requestId: accounting.requestId,
    address: accounting.address,
    providerId: accounting.providerId,
    providerUser: accounting.providerUser,
    consumerId: accounting.consumerId,
    consumerUser: accounting.consumerUser,
    baseUrl: accounting.baseUrl,
    model: accounting.model,
    status: parts.status,
    statusCode: parts.statusCode,
    latencyMs: Date.now() - accounting.startedAt,
    firstTokenMs: accounting.firstTokenMs ?? null,
    inputTokens: usage.input,
    cachedTokens: usage.cached,
    outputTokens: usage.output,
    gasFeeNanos: accounting.gasFee,
    tokenNanos: parts.tokenNanos,
    // 由 settle 覆盖成「真正扣掉的」：成功是 Gas + token，失败只有 Gas。
    feeNanos: 0,
    unbilledNanos: 0,
    at: nowSeconds(),
  };
}

/* ── 流式：同格式直通 ─────────────────────────────────────────────── */

/**
 * 同格式直通：上游提供商的 SSE 原样往下走，我们只在末尾记账。
 *
 * 用量在流里只出现一两次（见 dialects.ts 的 usageSniffer），所以这里一边转发一边嗅，
 * 到收尾时才计价——流式的 token 数只有末帧才知道。
 *
 * 唯一例外是 openai-chat：Norm 自己的 Playground 是这条路的客户端，它靠流末那条
 * `{"norm":…}` 显示本次调用的费用与余额。另外三条路的客户端是第三方 SDK，
 * 它们的解析器我们管不着，所以一个事件都不插——request_id 走 `X-Norm-Request-Id`。
 */
function passThroughStream(accounting: Accounting & { reply: Response; dialect: Dialect; wantsUsage: boolean }): Response {
  const { env, reply, dialect, wantsUsage } = accounting;
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
  const noteFrame = (payload: string) => {
    sniffer.push(payload);
    if (accounting.firstTokenMs === undefined && carriesText(dialect, payload)) {
      accounting.firstTokenMs = Date.now() - accounting.startedAt;
    }
  };
  const requestId = accounting.requestId;
  let buffer = '';
  let finished = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    const answer: AnswerCore = { text: '', model: accounting.model, usage, createdAt: 0 };
    const price = quote(accounting.model, usage, accounting.rate);
    const settled = await settle(env, recordOf(accounting, { answer, status: 'ok', statusCode: 200, tokenNanos: price.total_nanos }));
    return normMeta(accounting, usage, settled);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
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
          controller.enqueue(value);
        } else {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            // 上游提供商的 `[DONE]` 由我们自己发：这样 norm 一定排在它前面。
            if (line.trim() === 'data: [DONE]') continue;
            if (line.startsWith('data:')) noteFrame(line.slice(5).trim());
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
      }

      if (!done) return;
      finished = true;

      if (injectNorm) {
        if (buffer.length > 0 && buffer.trim() !== 'data: [DONE]') {
          if (buffer.startsWith('data:')) noteFrame(buffer.slice(5).trim());
          // 我们自己要来记账的那条用量帧：客户端没要就不转发。
          if (wantsUsage || !usageOnlyFrame(buffer.slice(5).trim())) controller.enqueue(encoder.encode(buffer));
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
      } else {
        // 上游有时不补换行，最后一段留在 buffer 里——它可能就是那条 response.completed。
        const rest = buffer.startsWith('data:') ? buffer.slice(5).trim() : '';
        if (rest.length > 0 && rest !== '[DONE]') noteFrame(rest);
        await finish();
      }
      controller.close();
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
 * 跨方言流：上游提供商 SSE → OpenAI chat chunk（协议适配器负责）→ 入口方言的帧（dialects 负责）。
 *
 * 用量同样一边嗅一边转发。这里比直通多一件事：入口若是 Gemini / Anthropic / Responses，
 * 收尾帧必须带上最终 token 数——那正是我们记账用的那一份，于是「账」与「回给客户端的
 * 用量」永远一致，不会出现「扣了钱但报 0 token」。
 */
function bridgeStream(accounting: Accounting & { reply: Response; entry: Dialect; protocol: Protocol; wantsUsage: boolean }): Response {
  const { env, reply, entry, protocol, wantsUsage } = accounting;
  const source = reply.body;
  if (!source) return new Response('上游提供商没有返回流', { status: 502 });

  const adapter = adapterFor(protocol);
  const emitter = streamEmitter(entry, accounting.requestId, accounting.model);
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (chunks: string[]) => chunks.map((chunk) => encoder.encode(chunk));
  const toChat = entry === 'openai-chat';
  const sniffer = usageSniffer(adapter.dialect);
  const noteFrame = (payload: string) => {
    sniffer.push(payload);
    if (accounting.firstTokenMs === undefined && carriesText(adapter.dialect, payload)) {
      accounting.firstTokenMs = Date.now() - accounting.startedAt;
    }
  };
  let buffer = '';
  let done = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    const price = quote(accounting.model, usage, accounting.rate);
    const settled = await settle(env, recordOf(accounting, {
      answer: { text: '', model: accounting.model, usage, createdAt: 0 },
      status: 'ok',
      statusCode: 200,
      tokenNanos: price.total_nanos,
    }));
    return normMeta(accounting, usage, settled);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const { value, done: finished } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data.length === 0 || data === '[DONE]') continue;
          noteFrame(data);
          for (const chunk of adapter.streamData(data, accounting.model)) {
            // 入口也是 chat 时直接透传 chunk，不含任何二次解读。
            if (toChat) {
              controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
              continue;
            }
            const delta = (JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
            if (delta) emit(emitter.delta(delta)).forEach((bytes) => controller.enqueue(bytes));
          }
        }
      }

      if (!finished) return;
      done = true;
      const meta = await finish();

      if (toChat) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
      } else {
        const core: AnswerCore = {
          text: '',
          model: accounting.model,
          usage: { input: meta.input_tokens, cached: meta.cached_tokens, output: meta.output_tokens },
          createdAt: Math.floor(Date.now() / 1000),
        };
        emit(emitter.tail(core)).forEach((bytes) => controller.enqueue(bytes));
      }
      controller.close();
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
