import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { feeMicros } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { charge, findCredential, findPrincipal } from '../store';
import { adapterFor, upstreamUrlFor, type ChatBody, type UpstreamProtocol } from '../upstreams';

type RelayContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * OpenAI Chat 兼容入口。
 *
 * 客户端只说一种方言（`/v1/chat/completions`），上游可以是四种协议之一——
 * 由凭证的 `upstream_protocol` 决定，翻译在边界处完成。所以「换一家上游」
 * 只是换一张凭证，客户端一行都不用改。
 *
 * 两件事只在本函数作用域里成立，不落库：上游明文密钥（BYOK）、请求与响应内容（ZDR）。
 */
export const relayRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

relayRoutes.post('/chat/completions', (c: RelayContext) => proxy(c));

async function proxy(c: RelayContext): Promise<Response> {
  const address = c.get('principal').address;
  const credentialId = c.req.header('X-Norm-Credential');
  const upstreamKey = c.req.header('X-Norm-Upstream-Key');
  if (!credentialId) fail(400, 'credential_required', '缺少 X-Norm-Credential');
  if (!upstreamKey) fail(400, 'upstream_key_required', '缺少 X-Norm-Upstream-Key：明文密钥只在请求里');

  const credential = await findCredential(c.env, address, credentialId);
  if (!credential) fail(404, 'credential_not_found', '凭证不存在或已撤销');

  // 目的地只能来自凭证：不读任何请求头。少了这一条，「钉死的 base_url」就只是句口号。
  const baseUrl = credential.base_url;
  const adapter = adapterFor(credential.upstream_protocol);
  const body = await c.req.json<ChatBody>();
  const model = body.model ?? '';
  const stream = body.stream === true;

  const requestId = `req_${randomToken(12)}`;
  const startedAt = Date.now();
  const fee = feeMicros(c.env);
  const principal = await findPrincipal(c.env, address);
  if (principal.balance_micros < fee) {
    fail(402, 'insufficient_balance', `余额不足：需要 ${fee} 微美元，当前 ${principal.balance_micros}`);
  }

  // 唯一关于上游的事实：它落在哪台主机上。是否"可信"由清单决定，记账不需要知道。
  const host = hostOf(baseUrl);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrlFor(credential.upstream_protocol, baseUrl, model, stream), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(upstreamKey) },
      body: JSON.stringify(adapter.request(body, model)),
    });
  } catch (error) {
    await record(c.env, { requestId, address, credentialId, model, status: 'network_error', statusCode: 502, startedAt, fee: 0, host });
    return c.json({ error: 'upstream_unreachable', message: `上游不可达：${(error as Error).message}` }, 502);
  }

  if (!upstream.ok) {
    // 失败不扣钱：隔离执行的成本由站点承担，用户只看到一条诚实的失败记录。
    const text = await upstream.text();
    await record(c.env, { requestId, address, credentialId, model, status: 'upstream_error', statusCode: upstream.status, startedAt, fee: 0, host });
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  }

  if (stream) {
    return streamRelay({ env: c.env, address, requestId, upstream, startedAt, fee, host, credentialId, model, protocol: credential.upstream_protocol });
  }

  // 上游是 OpenAI 时这就是原始响应；其他协议在这里被翻译回 OpenAI Chat 形状。
  const payload = adapter.response(await upstream.json(), model) as { model?: string; usage?: Usage };
  const balance = await charge(c.env, address, requestId, fee, nowSeconds());
  const usage = readUsage(payload.usage);
  await record(c.env, {
    requestId,
    address,
    credentialId,
    model: payload.model ?? model,
    status: 'ok',
    statusCode: upstream.status,
    startedAt,
    fee: balance === null ? 0 : fee,
    host,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
  });
  return c.json({ ...payload, norm: normMeta({ requestId, fee, balance, startedAt, host }) });
}

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

function readUsage(usage: Usage | undefined): { prompt: number; completion: number } {
  return { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 };
}

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
}) {
  return {
    request_id: requestId,
    fee_micros: fee,
    balance_micros: balance,
    latency_ms: Date.now() - startedAt,
    host,
  };
}

async function record(
  env: Env,
  args: {
    requestId: string;
    address: string;
    credentialId: string;
    model: string;
    status: string;
    statusCode: number;
    startedAt: number;
    fee: number;
    host: string;
    promptTokens?: number;
    completionTokens?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO requests
       (id, address, credential_id, model, status, status_code, latency_ms, prompt_tokens, completion_tokens, fee_micros, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.requestId,
      args.address,
      args.credentialId,
      args.model,
      args.status,
      args.statusCode,
      Date.now() - args.startedAt,
      args.promptTokens ?? 0,
      args.completionTokens ?? 0,
      args.fee,
      nowSeconds(),
    )
    .run();
}

/**
 * 流式：把上游 SSE 逐条按协议翻译成 OpenAI Chat 的 chunk，结尾统一补一条 norm 事件，
 * 再补一个 `[DONE]`。上游中途断掉时已产生的字节直接结束——不伪造成功的结尾。
 */
function streamRelay({
  env,
  address,
  requestId,
  upstream,
  startedAt,
  fee,
  host,
  credentialId,
  model,
  protocol,
}: {
  env: Env;
  address: string;
  requestId: string;
  upstream: Response;
  startedAt: number;
  fee: number;
  host: string;
  credentialId: string;
  model: string;
  protocol: UpstreamProtocol;
}): Response {
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });

  const adapter = adapterFor(protocol);
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const { value, done: finished } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data.length === 0) continue;
          // `[DONE]` 由我们自己发，统一发一次，避免上游与本地各发一次。
          if (data === '[DONE]') continue;
          for (const chunk of adapter.streamData(data, model)) {
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          }
        }
      }

      if (!finished) return;
      done = true;
      const balance = await charge(env, address, requestId, fee, nowSeconds());
      await record(env, {
        requestId,
        address,
        credentialId,
        model,
        status: 'ok',
        statusCode: 200,
        startedAt,
        fee: balance === null ? 0 : fee,
        host,
      });
      const meta = normMeta({ requestId, fee, balance, startedAt, host });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
