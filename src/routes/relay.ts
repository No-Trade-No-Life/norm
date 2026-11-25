import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { feeMicros } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import {
  parseInbound,
  readAnswer,
  renderInbound,
  streamEmitter,
  type AnswerCore,
  type Dialect,
  type NormMeta,
} from '../dialects';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { unsealUpstreamKey } from '../seal';
import { charge, findCredential, findPrincipal, resolveCredentialId } from '../store';
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

  // 身份只说「谁在用」。走哪条上游是这次转发自己的选择：头里指了名就用它，
  // 没指名就用账户里唯一的那条上游——所以「一条 Token」在只有一条上游时就是完整调用，
  // 而多上游的账户仍然可以在请求里点名。多条又不指名是错误，不是猜测。
  const credentialId = await resolveCredentialId(c.env, address, c.req.header('X-Norm-Credential') ?? null);

  const credential = await findCredential(c.env, address, credentialId);
  if (!credential) fail(404, 'credential_not_found', '凭证不存在或已撤销');

  // 明文密钥在库里是密文，用 Worker secret 里那把高熵对称密钥现解现用，
  // 只在本次请求的作用域里存在：不写日志、不进响应、不返回给客户端。
  const upstreamKey = await unsealUpstreamKey({
    env: c.env,
    address,
    credentialId: credential.id,
    sealed: credential.sealed_key,
  });

  // 原始字节先留住：同格式直通要把它一个字节不改地发出去。
  const rawBody = await c.req.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    fail(400, 'body_invalid', '请求体必须是 JSON');
  }

  const protocol = credential.upstream_protocol;
  const model = entry.model ?? (typeof raw.model === 'string' ? raw.model : '');
  const stream = entry.stream ?? raw.stream === true;
  const sameShape = entry.dialect === protocol;

  // 目的地只能来自凭证：不读任何请求头。少了这一条，「钉死的 base_url」就只是句口号。
  const baseUrl = credential.base_url;
  const adapter = adapterFor(protocol);
  const outbound = sameShape ? rawBody : JSON.stringify(adapter.request(parseInbound(entry.dialect, raw, model, stream), model));

  const requestId = `req_${randomToken(12)}`;
  const startedAt = Date.now();
  const fee = feeMicros(c.env);
  const account = await findPrincipal(c.env, address);
  if (account.balance_micros < fee) {
    fail(402, 'insufficient_balance', `余额不足：需要 ${fee} 微美元，当前 ${account.balance_micros}`);
  }

  // 唯一关于上游的事实：它落在哪台主机上。是否"可信"由清单决定，记账不需要知道。
  const host = hostOf(baseUrl);
  const accounting = { env: c.env, address, credentialId, requestId, startedAt, fee, host, model };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrlFor(protocol, baseUrl, model, stream), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(upstreamKey) },
      body: outbound,
    });
  } catch (error) {
    await record({ ...accounting, status: 'network_error', statusCode: 502, fee: 0 });
    return c.json({ error: 'upstream_unreachable', message: `上游不可达：${(error as Error).message}` }, 502);
  }

  if (!upstream.ok) {
    // 失败不扣钱：隔离执行的成本由站点承担，用户只看到一条诚实的失败记录。
    // 上游的错误体原样返回——它不是记账数据，改写它只会让上游的报错更难查。
    const text = await upstream.text();
    await record({ ...accounting, status: 'upstream_error', statusCode: upstream.status, fee: 0 });
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

  if (!sameShape) {
    const core = readAnswer(protocol, await upstream.json<Record<string, unknown>>());
    const balance = await charge(c.env, address, requestId, fee, nowSeconds());
    await record({ ...accounting, status: 'ok', statusCode: upstream.status, fee: balance === null ? 0 : fee, core });
    return c.json(renderInbound(entry.dialect, core, normMeta({ requestId, fee, balance, startedAt, host })));
  }

  // 同格式：响应体一个字段都不动，只把 `norm` 作为附加字段挂上去。
  const json = await upstream.json<Record<string, unknown>>();
  const balance = await charge(c.env, address, requestId, fee, nowSeconds());
  const core = readAnswer(protocol, json);
  await record({ ...accounting, status: 'ok', statusCode: upstream.status, fee: balance === null ? 0 : fee, core });
  return c.json({ ...json, norm: normMeta({ requestId, fee, balance, startedAt, host }) });
}

/* ── 记账 ─────────────────────────────────────────────────────────── */

type Ledger = {
  env: Env;
  address: string;
  credentialId: string;
  requestId: string;
  startedAt: number;
  fee: number;
  host: string;
  model: string;
};

/** 只回事实：这笔账属于哪个请求、扣了多少、钱在哪、打到哪台主机。 */
function normMeta({
  requestId,
  fee,
  balance,
  startedAt,
  host,
}: {
  requestId: string;
  fee: number;
  balance: number | null;
  startedAt: number;
  host: string;
}): NormMeta {
  return {
    request_id: requestId,
    fee_micros: fee,
    balance_micros: balance,
    latency_ms: Date.now() - startedAt,
    host,
  };
}

async function record(
  args: Ledger & { status: string; statusCode: number; fee: number; core?: AnswerCore },
): Promise<void> {
  await args.env.DB.prepare(
    `INSERT INTO requests
       (id, address, credential_id, model, status, status_code, latency_ms, prompt_tokens, completion_tokens, fee_micros, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.requestId,
      args.address,
      args.credentialId,
      args.core?.model || args.model,
      args.status,
      args.statusCode,
      Date.now() - args.startedAt,
      args.core?.promptTokens ?? 0,
      args.core?.completionTokens ?? 0,
      args.fee,
      nowSeconds(),
    )
    .run();
}

/* ── 流式：同格式直通 ─────────────────────────────────────────────── */

/**
 * 同格式直通：上游的 SSE 原样往下走，我们只在末尾记账。
 *
 * 唯一例外是 openai-chat：Norm 自己的 Playground 是这条路的客户端，它靠流末那条
 * `{"norm":…}` 显示本次调用的费用与余额。另外三条路的客户端是第三方 SDK，
 * 它们的解析器我们管不着，所以一个事件都不插——request_id 走 `X-Norm-Request-Id`。
 */
function passThroughStream({
  env,
  address,
  credentialId,
  requestId,
  startedAt,
  fee,
  host,
  model,
  upstream,
  dialect,
}: Ledger & { upstream: Response; dialect: Dialect }): Response {
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const injectNorm = dialect === 'openai-chat';
  let buffer = '';
  let finished = false;

  const settle = async () => {
    const balance = await charge(env, address, requestId, fee, nowSeconds());
    await record({ env, address, credentialId, requestId, startedAt, fee: balance === null ? 0 : fee, host, model, status: 'ok', statusCode: 200 });
    return balance;
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
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
      }

      if (!done) return;
      finished = true;

      if (injectNorm) {
        if (buffer.length > 0 && buffer.trim() !== 'data: [DONE]') controller.enqueue(encoder.encode(buffer));
        const balance = await settle();
        const meta = JSON.stringify({ norm: normMeta({ requestId, fee, balance, startedAt, host }) });
        controller.enqueue(encoder.encode(`data: ${meta}\n\ndata: [DONE]\n\n`));
      } else {
        await settle();
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
 * 不报 token 用量：上游不一定在中途给出，冒充一个数字不如留 0（记账同样是 0），
 * 这一条写在 docs/api.md 里。
 */
function bridgeStream({
  env,
  address,
  credentialId,
  requestId,
  startedAt,
  fee,
  host,
  model,
  upstream,
  entry,
  protocol,
}: Ledger & { upstream: Response; entry: Dialect; protocol: UpstreamProtocol }): Response {
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });

  const adapter = adapterFor(protocol);
  const emitter = streamEmitter(entry, requestId, model);
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (chunks: string[]) => chunks.map((chunk) => encoder.encode(chunk));
  const toChat = entry === 'openai-chat';
  let buffer = '';
  let done = false;

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
          for (const chunk of adapter.streamData(data, model)) {
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
      const balance = await charge(env, address, requestId, fee, nowSeconds());
      await record({ env, address, credentialId, requestId, startedAt, fee: balance === null ? 0 : fee, host, model, status: 'ok', statusCode: 200 });

      if (toChat) {
        const meta = normMeta({ requestId, fee, balance, startedAt, host });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\ndata: [DONE]\n\n`));
      } else {
        const core: AnswerCore = { text: '', model, promptTokens: 0, completionTokens: 0, createdAt: Math.floor(Date.now() / 1000) };
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
      'X-Norm-Request-Id': requestId,
    },
  });
}
