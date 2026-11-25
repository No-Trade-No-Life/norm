import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { serviceFeeMicros } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import {
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
import { quote, type Usage } from '../pricing';
import { unsealUpstreamKey } from '../seal';
import { findPrincipal, findProvider, recordRequest, settle, type RequestRecord } from '../store';
import { adapterFor, upstreamUrlFor, type UpstreamProtocol } from '../upstreams';

type RelayContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * 转发面：四条入口方言 × 四种上游协议。
 *
 * 入口与上游用的是同一套名字，所以「入口方言 === 上游协议」就是字符串相等，
 * 而那 4 格**不转换**：请求体按原始字节发出去，响应体原样回来（只多一个 `norm` 字段）。
 *
 * 其余 12 格才经过 OpenAI Chat 这座桥：入口 → ChatBody → 上游适配器 → 回来时渲染成入口方言。
 * 桥只在一侧出现，所以矩阵是 4 段入口翻译 + 4 段上游适配，而不是 16 条路径。
 *
 * 两件事只在本请求的作用域里成立，不落库：上游明文密钥（BYOK）、请求与响应内容（ZDR）。
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

async function proxy(c: RelayContext, entry: Entry): Promise<Response> {
  const principal = c.get('principal');
  const address = principal.address;

  // 下游消费者密钥自带绑定的上游；只有人是签名来的，才需要在头里指名用哪一条。
  // 这条规矩就是「密钥即完整调用」：程序侧永远不用再拼第二个头。
  const providerId = principal.providerId ?? c.req.header('X-Norm-Provider');
  if (!providerId) fail(400, 'provider_required', '缺少 X-Norm-Provider');

  const provider = await findProvider(c.env, address, providerId);
  if (!provider) fail(404, 'provider_not_found', '凭证不存在或已撤销');

  // 明文密钥在库里是密文，用 Worker secret 里那把高熵对称密钥现解现用，
  // 只在本次请求的作用域里存在：不写日志、不进响应、不返回给客户端。
  const upstreamKey = await unsealUpstreamKey({
    env: c.env,
    address,
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

  const protocol = provider.upstream_protocol;
  const model = entry.model ?? (typeof raw.model === 'string' ? raw.model : '');
  const stream = entry.stream ?? raw.stream === true;
  const sameShape = entry.dialect === protocol;

  // 目的地只能来自凭证：不读任何请求头。少了这一条，「钉死的 base_url」就只是句口号。
  const baseUrl = provider.base_url;
  const adapter = adapterFor(protocol);
  const outbound = sameShape ? rawBody : JSON.stringify(adapter.request(parseInbound(entry.dialect, raw, model, stream), model));

  // UUID v7：字典序即时间序，账本按时间翻页就是按主键翻页。
  const requestId = uuidv7();
  const startedAt = Date.now();
  const serviceFee = serviceFeeMicros(c.env);
  const account = await findPrincipal(c.env, address);
  if (account.balance_micros < serviceFee) {
    fail(402, 'insufficient_balance', `余额不足：需要 ${serviceFee} 微美元，当前 ${account.balance_micros}`);
  }

  // 唯一关于上游的事实：它落在哪台主机上。是否"可信"由清单决定，记账不需要知道。
  const host = hostOf(baseUrl);
  const accounting: Accounting = {
    env: c.env,
    address,
    providerId: provider.id,
    consumerId: principal.consumerId ?? null,
    baseUrl,
    requestId,
    startedAt,
    serviceFee,
    host,
    model,
  };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrlFor(protocol, baseUrl, model, stream), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(upstreamKey) },
      body: outbound,
    });
  } catch (error) {
    await recordFailure(accounting, 'network_error', 502);
    return c.json({ error: 'upstream_unreachable', message: `上游不可达：${(error as Error).message}` }, 502);
  }

  if (!upstream.ok) {
    // 失败不扣钱：隔离执行的成本由站点承担，用户只看到一条诚实的失败记录。
    // 上游的错误体原样返回——它不是记账数据，改写它只会让上游的报错更难查。
    const text = await upstream.text();
    await recordFailure(accounting, 'upstream_error', upstream.status);
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  }

  if (stream) {
    return sameShape
      ? passThroughStream({ ...accounting, upstream, dialect: entry.dialect })
      : bridgeStream({ ...accounting, upstream, entry: entry.dialect, protocol });
  }

  const json = await upstream.json<Record<string, unknown>>();
  const core = readAnswer(protocol, json);
  const billed = await bill(accounting, core, upstream.status);
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
  consumerId: string | null;
  /** 打到的上游地址：账本要能回答「这一笔打给哪台机器」。 */
  baseUrl: string;
  requestId: string;
  startedAt: number;
  serviceFee: number;
  host: string;
  model: string;
};

/**
 * 账单结论：总价、构成、三项 token、差多少没收到。
 *
 * `fee_micros` 是真正扣掉的那个数，恒等于 `service_fee_micros + token_micros - unbilled_micros`；
 * 三个数一起回，是因为只回一个总数就没人能自己核对了。
 */
function normMeta(accounting: Accounting, usage: Usage, billed: { billedMicros: number; unbilledMicros: number; balanceMicros: number }): NormMeta {
  const price = quote(accounting.model, usage);
  return {
    request_id: accounting.requestId,
    fee_micros: billed.billedMicros,
    service_fee_micros: accounting.serviceFee,
    token_micros: price.total_micros,
    input_tokens: usage.input,
    cached_tokens: usage.cached,
    output_tokens: usage.output,
    unbilled_micros: billed.unbilledMicros,
    balance_micros: billed.balanceMicros,
    latency_ms: Date.now() - accounting.startedAt,
    host: accounting.host,
  };
}

/** 把一次成功的调用折成钱、记下来，返回给客户端看的账单结论。 */
async function bill(accounting: Accounting, answer: AnswerCore, statusCode: number): Promise<NormMeta> {
  const price = quote(accounting.model, answer.usage);
  const settled = await settle(accounting.env, recordOf(accounting, {
    answer,
    status: 'ok',
    statusCode,
    tokenMicros: price.total_micros,
  }));
  return normMeta(accounting, answer.usage, settled);
}

/**
 * 失败不扣钱：隔离执行的成本由站点承担，用户只看到一条诚实的失败记录。
 * 记录仍然是完整的——打了哪台机器、用哪把钥匙、跑了多久，一个都不少，
 * 只是 token 与费用都是 0（上游没给出答案，也就没有可计价的量）。
 */
async function recordFailure(accounting: Accounting, status: string, statusCode: number): Promise<void> {
  await recordRequest(accounting.env, recordOf(accounting, {
    status,
    statusCode,
    tokenMicros: 0,
    usage: { input: 0, cached: 0, output: 0 },
  }));
}

function recordOf(
  accounting: Accounting,
  parts: { status: string; statusCode: number; tokenMicros: number; answer?: AnswerCore; usage?: Usage },
): RequestRecord {
  // 记客户端要的那个模型名，不记上游回的那个：价格跟着它算，两者必须是同一个字符串，
  // 否则一个把自己响应改写成便宜模型的上游就顺手给自己定了价。上游实际跑的版本
  // 是它的私事，账本不需要为此多一列。
  // 用量可能显式传（流式收尾时已经算好了），也可能藏在回答里（非流式）。
  const usage = parts.usage ?? parts.answer?.usage ?? { input: 0, cached: 0, output: 0 };
  return {
    requestId: accounting.requestId,
    address: accounting.address,
    providerId: accounting.providerId,
    consumerId: accounting.consumerId,
    baseUrl: accounting.baseUrl,
    model: accounting.model,
    status: parts.status,
    statusCode: parts.statusCode,
    latencyMs: Date.now() - accounting.startedAt,
    inputTokens: usage.input,
    cachedTokens: usage.cached,
    outputTokens: usage.output,
    serviceFeeMicros: accounting.serviceFee,
    tokenMicros: parts.tokenMicros,
    // 由 settle 覆盖成「真正扣掉的」；失败路径上它保持 0。
    feeMicros: 0,
    unbilledMicros: 0,
    at: nowSeconds(),
  };
}

/* ── 流式：同格式直通 ─────────────────────────────────────────────── */

/**
 * 同格式直通：上游的 SSE 原样往下走，我们只在末尾记账。
 *
 * 用量在流里只出现一两次（见 dialects.ts 的 usageSniffer），所以这里一边转发一边嗅，
 * 到收尾时才计价——流式的 token 数只有末帧才知道。
 *
 * 唯一例外是 openai-chat：Norm 自己的 Playground 是这条路的客户端，它靠流末那条
 * `{"norm":…}` 显示本次调用的费用与余额。另外三条路的客户端是第三方 SDK，
 * 它们的解析器我们管不着，所以一个事件都不插——request_id 走 `X-Norm-Request-Id`。
 */
function passThroughStream(accounting: Accounting & { upstream: Response; dialect: Dialect }): Response {
  const { env, upstream, dialect } = accounting;
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const injectNorm = dialect === 'openai-chat';
  const sniffer = usageSniffer(dialect);
  const requestId = accounting.requestId;
  let buffer = '';
  let finished = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    const answer: AnswerCore = { text: '', model: accounting.model, usage, createdAt: 0 };
    const price = quote(accounting.model, usage);
    const settled = await settle(env, recordOf(accounting, { answer, status: 'ok', statusCode: 200, tokenMicros: price.total_micros }));
    return normMeta(accounting, usage, settled);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const { value, done } = await reader.read();

      if (value) {
        if (!injectNorm) {
          controller.enqueue(value);
        } else {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            // 上游的 `[DONE]` 由我们自己发：这样 norm 一定排在它前面。
            if (line.trim() === 'data: [DONE]') continue;
            if (line.startsWith('data:')) sniffer.push(line.slice(5).trim());
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
      }

      if (!done) return;
      finished = true;

      if (injectNorm) {
        if (buffer.length > 0 && buffer.trim() !== 'data: [DONE]') controller.enqueue(encoder.encode(buffer));
        const meta = await finish();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
      } else {
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
      'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Norm-Request-Id': requestId,
    },
  });
}

/* ── 流式：跨方言 ─────────────────────────────────────────────────── */

/**
 * 跨方言流：上游 SSE → OpenAI chat chunk（上游适配器负责）→ 入口方言的帧（dialects 负责）。
 *
 * 用量同样一边嗅一边转发。这里比直通多一件事：入口若是 Gemini / Anthropic / Responses，
 * 收尾帧必须带上最终 token 数——那正是我们记账用的那一份，于是「账」与「回给客户端的
 * 用量」永远一致，不会出现「扣了钱但报 0 token」。
 */
function bridgeStream(accounting: Accounting & { upstream: Response; entry: Dialect; protocol: UpstreamProtocol }): Response {
  const { env, upstream, entry, protocol } = accounting;
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });

  const adapter = adapterFor(protocol);
  const emitter = streamEmitter(entry, accounting.requestId, accounting.model);
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (chunks: string[]) => chunks.map((chunk) => encoder.encode(chunk));
  const toChat = entry === 'openai-chat';
  const sniffer = usageSniffer(protocol);
  let buffer = '';
  let done = false;

  const finish = async (): Promise<NormMeta> => {
    const usage = sniffer.usage();
    const price = quote(accounting.model, usage);
    const settled = await settle(env, recordOf(accounting, {
      answer: { text: '', model: accounting.model, usage, createdAt: 0 },
      status: 'ok',
      statusCode: 200,
      tokenMicros: price.total_micros,
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
          sniffer.push(data);
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
