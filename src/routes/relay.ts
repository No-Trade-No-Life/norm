import { Hono } from 'hono';
import type { Env } from '../env';
import { feeMicros } from '../env';
import type { Principal } from '../auth';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { checkProvenance } from '../provenance';
import { refreshProvenance } from '../refresh-provenance';
import { charge, findCredential, findPrincipal } from '../store';

type ChatBody = {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
};

/**
 * OpenAI 兼容转发。BYOK 的明文密钥走请求头，只在本函数的作用域里存在：
 * 不写 D1、不写日志、不进响应。
 */
export const relayRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

relayRoutes.post('/completions', async (c) => {
  const address = c.get('principal').address;
  const credentialId = c.req.header('X-Norm-Credential');
  const upstreamKey = c.req.header('X-Norm-Upstream-Key');
  if (!credentialId) fail(400, 'credential_required', '缺少 X-Norm-Credential');
  if (!upstreamKey) fail(400, 'upstream_key_required', '缺少 X-Norm-Upstream-Key：明文密钥只在请求里');

  const credential = await findCredential(c.env, address, credentialId);
  if (!credential) fail(404, 'credential_not_found', '凭证不存在或已撤销');

  const baseUrl = (c.req.header('X-Norm-Base-Url') || credential.base_url).replace(/\/+$/, '');
  const body = await c.req.json<ChatBody>();
  const model = body.model ?? '';

  const requestId = `req_${randomToken(12)}`;
  const startedAt = Date.now();
  const fee = feeMicros(c.env);
  const principal = await findPrincipal(c.env, address);
  if (principal.balance_micros < fee) {
    fail(402, 'insufficient_balance', `余额不足：需要 ${fee} 微美元，当前 ${principal.balance_micros}`);
  }

  const provenance = checkProvenance({
    provider: credential.provider,
    baseUrl,
    upstreamKey,
    declaredSource: credential.declared_source,
    checkedAt: nowSeconds(),
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    await record(c.env, { requestId, address, credentialId, model, status: 'network_error', statusCode: 502, startedAt, fee: 0, provenance });
    return c.json({ error: 'upstream_unreachable', message: `上游不可达：${(error as Error).message}` }, 502);
  }

  if (!upstream.ok) {
    // 失败不扣钱：隔离执行的成本由站点承担，用户只看到一次诚实的失败记录。
    const text = await upstream.text();
    await record(c.env, { requestId, address, credentialId, model, status: 'upstream_error', statusCode: upstream.status, startedAt, fee: 0, provenance });
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' } });
  }

  if (body.stream) {
    c.executionCtx.waitUntil(refreshProvenance({ env: c.env, credential, baseUrl, upstreamKey }).then(() => undefined));
    return streamRelay({ env: c.env, address, requestId, upstream, startedAt, fee, provenance, credentialId, model });
  }

  const payload = (await upstream.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const refreshed = await refreshProvenance({ env: c.env, credential, baseUrl, upstreamKey });
  const balance = await charge(c.env, address, requestId, fee, nowSeconds());
  await record(c.env, {
    requestId,
    address,
    credentialId,
    model: (payload as { model?: string }).model ?? model,
    status: 'ok',
    statusCode: upstream.status,
    startedAt,
    fee: balance === null ? 0 : fee,
    provenance,
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  });
  return c.json({
    ...payload,
    norm: normMeta({ requestId, fee, balance, startedAt, provenance: refreshed }),
  });
});

function normMeta({
  requestId,
  fee,
  balance,
  startedAt,
  provenance,
}: {
  requestId: string;
  fee: number;
  balance: number | null;
  startedAt: number;
  provenance: ReturnType<typeof checkProvenance>;
}) {
  return {
    request_id: requestId,
    fee_micros: fee,
    balance_micros: balance,
    latency_ms: Date.now() - startedAt,
    provenance: {
      declared_source: provenance.declared_source,
      verified: provenance.verified,
      signals: provenance.signals,
      host: provenance.host,
    },
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
    provenance: ReturnType<typeof checkProvenance>;
    promptTokens?: number;
    completionTokens?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO requests
       (id, address, credential_id, model, status, status_code, latency_ms, prompt_tokens, completion_tokens, fee_micros, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify({ declared_source: args.provenance.declared_source, verified: args.provenance.verified, signals: args.provenance.signals }),
      nowSeconds(),
    )
    .run();
}

/**
 * 流式转发：把上游 SSE 原样带给浏览器，在结尾补一条 norm 事件再收尾。
 * 上游中途断掉时，已产生的字节直接结束——不伪造一个「成功」的结尾。
 */
function streamRelay({
  env,
  address,
  requestId,
  upstream,
  startedAt,
  fee,
  provenance,
  credentialId,
  model,
}: {
  env: Env;
  address: string;
  requestId: string;
  upstream: Response;
  startedAt: number;
  fee: number;
  provenance: ReturnType<typeof checkProvenance>;
  credentialId: string;
  model: string;
}): Response {
  const source = upstream.body;
  if (!source) return new Response('上游没有返回流', { status: 502 });

  const reader = source.getReader();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
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
          provenance,
        });
        const meta = normMeta({ requestId, fee, balance, startedAt, provenance });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ norm: meta })}\n\n`));
        controller.close();
        return;
      }
      controller.enqueue(value);
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
