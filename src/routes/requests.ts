import { Hono, type Context } from 'hono';
import type { Principal } from '../auth';
import type { Env } from '../env';
import { fail } from '../http';
import { REQUEST_RECEIPT_BATCH_LIMIT, requestReceipts, type RequestReceiptRow } from '../store';

/**
 * 请求费用查询：下游（上层网关）拿着请求 ID 回头问「这一笔收了多少」。
 *
 * 这是 `Qwen LB` / `DeepSeek LB` / `OpenAI LB` 一族共用的那条契约，Norm 现在也说它：
 *
 *   POST /v1/requests/query  {"ids":[…]} → {"requests":[{…,"cost_usd_nanos":N}],"missing":[…]}
 *   GET  /v1/requests/{id}                → 一条记录
 *
 * 为什么需要它：上游网关往往**先**把调用转出去、**后**结算（它不能等 Norm 扣完钱才回客户端），
 * 于是它记下请求 ID，等账落定再回头补齐金额。没有这个接口，网关只能自己猜价——那等于账本
 * 有两份，迟早对不上。
 *
 * 只回答记账字段：金额、用量、状态、延迟。没有请求体、没有响应体、没有上游地址里的密钥。
 */
export const requestRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

type RequestContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/** 对外的记录形状：`cost_usd_nanos` 是这条契约字段名，恒等于实扣的 `fee_nanos`。 */
export function receiptOf(row: RequestReceiptRow) {
  return {
    request_id: row.id,
    model: row.model,
    status: row.status,
    status_code: row.status_code,
    cost_usd_nanos: row.fee_nanos,
    gas_billed_nanos: row.gas_billed_nanos,
    token_billed_nanos: row.token_billed_nanos,
    input_tokens: row.input_tokens,
    cached_tokens: row.cached_tokens,
    output_tokens: row.output_tokens,
    audio_ms: row.audio_ms,
    audio_characters: row.audio_characters,
    latency_ms: row.latency_ms,
    first_token_ms: row.first_token_ms,
    host: hostOf(row.base_url),
    created_at: row.created_at,
  };
}

/** 只回答主机名：账本里存的是 base_url，对账不需要看见路径。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

requestRoutes.post('/requests/query', async (c: RequestContext) => {
  const principal = c.get('principal');
  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    fail(400, 'body_invalid', '请求体必须是 JSON');
  }
  const asked = Array.isArray(raw.ids) ? raw.ids : [];
  const ids = [...new Set(asked.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) fail(400, 'ids_required', '至少给一个请求 ID：{"ids":["…"]}');
  if (ids.length > REQUEST_RECEIPT_BATCH_LIMIT) {
    fail(400, 'ids_too_many', `一次最多查 ${REQUEST_RECEIPT_BATCH_LIMIT} 条`);
  }

  const rows = await requestReceipts(c.env, principal.consumerId, ids);
  const seen = new Set(rows.map((row) => row.id));
  return c.json(
    { requests: rows.map(receiptOf), missing: ids.filter((id) => !seen.has(id)) },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

requestRoutes.get('/requests/:id', async (c: RequestContext) => {
  const principal = c.get('principal');
  const id = c.req.param('id') ?? '';
  const rows = await requestReceipts(c.env, principal.consumerId, [id]);
  const row = rows[0];
  // 「不是你的」与「不存在」回答同一句话：前者能区分出来，就等于承认这个 id 存在。
  if (!row) fail(404, 'request_not_found', `这把 Token 名下没有这个请求：${id}`);
  return c.json(receiptOf(row), 200, { 'Cache-Control': 'no-store' });
});
