import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { findPrincipal, listProviders } from '../store';

export type AccountRoutes = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;

export const accountRoutes: AccountRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

accountRoutes.get('/me', async (c) => {
  const principal = await findPrincipal(c.env, c.get('principal').address);
  const providers = await listProviders(c.env, principal.address);
  // 余额、花费、请求数、token 三项，一次查询里取齐：页头那四张卡片不该各发一次请求。
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(gas_fee_nanos), 0) AS gas_fee_nanos,
            COALESCE(SUM(token_nanos), 0) AS token_nanos,
            COALESCE(SUM(unbilled_nanos), 0) AS unbilled_nanos
     FROM requests WHERE address = ?`,
  )
    .bind(principal.address)
    .first<{
      n: number;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      gas_fee_nanos: number;
      token_nanos: number;
      unbilled_nanos: number;
    }>();

  return c.json({
    address: principal.address,
    label: principal.label,
    balance_nanos: principal.balance_nanos,
    granted_nanos: principal.granted_nanos,
    spend_nanos: principal.spend_nanos,
    requests: totals?.n ?? 0,
    providers: providers.length,
    usage: {
      input_tokens: totals?.input_tokens ?? 0,
      cached_tokens: totals?.cached_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
    },
    // 账目构成：Gas 费 vs token，以及没能收上来的部分（余额不足时由站点承担）。
    billed: {
      gas_fee_nanos: totals?.gas_fee_nanos ?? 0,
      token_nanos: totals?.token_nanos ?? 0,
      unbilled_nanos: totals?.unbilled_nanos ?? 0,
    },
    created_at: principal.created_at,
  });
});

/**
 * 请求记录。游标翻页：`before` 传上一页最后一行的 request_id。
 *
 * 为什么按 id 而不是按时间翻：request_id 是 UUID v7，字典序就是时间序，
 * 一次走完索引，也不需要 `OFFSET` 那种越翻越慢的写法。
 */
accountRoutes.get('/usage', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const before = c.req.query('before') ?? '';
  const address = c.get('principal').address;

  const where = before ? 'address = ? AND id < ?' : 'address = ?';
  const statement = c.env.DB.prepare(
    `SELECT * FROM requests WHERE ${where} ORDER BY id DESC LIMIT ?`,
  );
  const { results } = await (before ? statement.bind(address, before, limit) : statement.bind(address, limit)).all();

  return c.json({ items: results });
});

/**
 * 记账流水。游标翻页：`cursor` 传上一页最后一行的 `cursor` 字段。
 *
 * 流水没有时间序主键（它的 id 是随机的 base58），但 D1 的 rowid 就是写入顺序，
 * 而这张表只追加、不更新——所以 rowid 序等于时间序，翻页也不必 `OFFSET`。
 */
accountRoutes.get('/ledger', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const cursor = c.req.query('cursor') ?? '';
  const address = c.get('principal').address;

  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS cursor, id, request_id, kind, amount_nanos, balance_after_nanos, created_at
     FROM ledger WHERE address = ? ${cursor ? 'AND rowid < ?' : ''}
     ORDER BY rowid DESC LIMIT ?`,
  )
    .bind(...(cursor ? [address, Number(cursor), limit] : [address, limit]))
    .all();

  return c.json({ items: results });
});

/**
 * 按下游消费者密钥聚合用量：账本要能回答「这把钥匙花了多少」。
 * 只回 id、名字与合计，不含任何请求内容。
 */
accountRoutes.get('/usage/by-consumer', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT requests.consumer_id AS consumer_id,
            consumers.name AS consumer_name,
            consumers.key_hint AS key_hint,
            COUNT(*) AS requests,
            COALESCE(SUM(requests.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(requests.cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(requests.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(requests.fee_nanos), 0) AS fee_nanos
     FROM requests
     LEFT JOIN consumers ON consumers.id = requests.consumer_id
     WHERE requests.address = ?
     GROUP BY requests.consumer_id
     ORDER BY fee_nanos DESC`,
  )
    .bind(c.get('principal').address)
    .all();

  return c.json({ items: results });
});

/** 按上游提供商聚合：钱花在哪个上游提供商、打给哪个地址。 */
accountRoutes.get('/usage/by-provider', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT requests.provider_id AS provider_id,
            providers.label AS provider_label,
            COUNT(*) AS requests,
            COALESCE(SUM(requests.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(requests.cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(requests.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(requests.fee_nanos), 0) AS fee_nanos
     FROM requests
     LEFT JOIN providers ON providers.id = requests.provider_id
     WHERE requests.address = ?
     GROUP BY requests.provider_id
     ORDER BY fee_nanos DESC`,
  )
    .bind(c.get('principal').address)
    .all();

  return c.json({ items: results });
});
