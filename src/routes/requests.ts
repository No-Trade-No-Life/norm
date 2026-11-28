import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { fail } from '../http';

/**
 * 请求费用查询契约：`POST /v1/requests/query`。
 *
 * 一次调用花掉多少钱，Norm 已经随响应交回（`X-Norm-Fee-Nanos` 与响应体里的
 * `cost_usd_nanos`）。这个端点回答的是**另一个问题**：给定一批请求 ID，把每一笔已经
 * 落库的金额再取一遍。问它的不是人，是上层网关——网关手里的 ID 来自那次响应，而它要
 * 结账的时刻与那次 HTTP 响应的生命周期并不重合（Cybion 就是按这个契约结算的，见
 * 它的 `cloud/cost.rs`）。
 *
 * 形状与网关从自己上游收的那一份一致，于是一条 Norm 可以被当作上游直接接进去：
 *
 *   { "requests": [{request_id, status, model, input_tokens, output_tokens,
 *                   cached_tokens, cost_usd_nanos, settlement_pending, created_at}],
 *     "missing": ["…"] }
 *
 * 两条纪律：
 *
 *   - **只认本消费者**：`consumer_id` 是每条语句的第一个条件，拿着别人的请求 ID 也读
 *     不到别人的金额。
 *   - **`settlement_pending` 恒为 false**：Norm 在回响应之前就把账结完了（`store.settle`），
 *     没有「先记 pending、稍后再对账」的那一刻，所以金额就是 `fee_nanos`。字段留着是因为
 *     契约里有它，调用方按 `null` 判断「还没算完」时不会被这里卡住。
 *
 * 读是纯读：不写 `consumers.last_used_at`、不动账本、不计 Gas。
 */
export const requestQueryRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

/** 一次查询最多收多少个 ID。第三人称网关会按百为单位批量问。 */
const MAX_IDS = 200;

/**
 * 每条语句绑多少个 ID。D1 单条语句最多 100 个绑定参数，而这段查询还要带上账户与消费者
 * 两列；50 留足了余量，也让「问 200 个」不必变成 200 个占位符的长语句。
 */
const QUERY_CHUNK = 50;

requestQueryRoutes.post('/requests/query', async (c) => {
  const principal = c.get('principal');
  const ids = await readIds(c.req.raw);
  const records = new Map<string, Record<string, unknown>>();
  for (let at = 0; at < ids.length; at += QUERY_CHUNK) {
    for (const record of await loadRecords(c.env, principal, ids.slice(at, at + QUERY_CHUNK))) {
      records.set(String(record.request_id), record);
    }
  }
  return c.json({
    requests: ids.flatMap((id) => records.get(id) ?? []),
    missing: ids.filter((id) => !records.has(id)),
  });
});

/**
 * 请求体：`{"ids":[…]}`。空数组与超量都是坏请求——「问 0 个」不是一次查询，静默回空表
 * 会让调用方以为那一批都已经结完。
 */
async function readIds(request: Request): Promise<string[]> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    fail(400, 'body_invalid', '查询请求必须是一个 JSON 对象');
  }
  const raw = recordOf(body).ids;
  if (!Array.isArray(raw)) fail(400, 'ids_required', '查询请求缺少 ids（请求 ID 数组）');
  const ids = raw.map((id) => (typeof id === 'string' ? id.trim() : '')).filter((id) => id !== '');
  if (ids.length === 0) fail(400, 'ids_required', 'ids 至少要有一个请求 ID');
  if (ids.length > MAX_IDS) fail(400, 'ids_too_many', `一次最多查 ${MAX_IDS} 个请求 ID`);
  // 去重但保序：调用方按自己给的顺序读回结果时不必再排序。
  return [...new Set(ids)];
}

/** 一批 ID 里这个消费者自己的那些行。没有的行不出现——由调用方归进 `missing`。 */
async function loadRecords(env: Env, principal: Principal, ids: readonly string[]): Promise<Record<string, unknown>[]> {
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, status, model, input_tokens, cached_tokens, output_tokens,
            fee_nanos, created_at
       FROM requests
      WHERE address = ? AND consumer_id = ? AND id IN (${placeholders})`,
  )
    .bind(principal.address, principal.consumerId, ...ids)
    .all<{
      id: string;
      status: string;
      model: string;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      fee_nanos: number;
      created_at: number;
    }>();
  return results.map((row) => ({
    request_id: row.id,
    status: row.status,
    model: row.model,
    input_tokens: row.input_tokens,
    cached_tokens: row.cached_tokens,
    output_tokens: row.output_tokens,
    // 结算是同步的：这一行落下时钱已经扣过了。
    cost_usd_nanos: row.fee_nanos,
    settlement_pending: false,
    created_at: row.created_at,
  }));
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
