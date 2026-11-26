import { Hono } from 'hono';
import type { Env } from '../env';
import type { Identity } from '../auth';
import { availableNanos, findPrincipal, listProviders, totalSpendNanos } from '../store';

export type AccountRoutes = Hono<{ Bindings: Env; Variables: { principal: Identity } }>;

export const accountRoutes: AccountRoutes = new Hono<{ Bindings: Env; Variables: { principal: Identity } }>();

accountRoutes.get('/me', async (c) => {
  const principal = await findPrincipal(c.env, c.get('principal').address);
  const providers = await listProviders(c.env, principal.address);
  // 余额、花费、请求数、token 三项，一次查询里取齐：页头卡片不该各发一次请求。
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(gas_fee_nanos), 0) AS gas_fee_nanos,
            COALESCE(SUM(gas_billed_nanos), 0) AS gas_billed_nanos,
            COALESCE(SUM(token_nanos), 0) AS token_nanos,
            COALESCE(SUM(token_billed_nanos), 0) AS token_billed_nanos,
            COALESCE(SUM(unbilled_nanos), 0) AS unbilled_nanos,
            -- 延迟分两个数：首字只对成功的流式调用有值，平均只在有值的那部分上算。
            COALESCE(AVG(CASE WHEN first_token_ms IS NOT NULL THEN first_token_ms END), 0) AS avg_first_token_ms,
            COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
            COUNT(first_token_ms) AS streamed_requests
     FROM requests WHERE address = ?`,
  )
    .bind(principal.address)
    .first<{
      n: number;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      gas_fee_nanos: number;
      gas_billed_nanos: number;
      token_nanos: number;
      token_billed_nanos: number;
      unbilled_nanos: number;
      avg_first_token_ms: number;
      avg_latency_ms: number;
      streamed_requests: number;
    }>();

  // 上游提供方收入聚合：只有在确实收到过跨用户 Token 收入时才查请求表，0 收入账户省掉一次扫描。
  const earnedTotals =
    principal.earn_nanos > 0
      ? await c.env.DB.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(token_billed_nanos), 0) AS token_billed_nanos
             FROM requests
            WHERE provider_user = ? AND address <> ? AND token_billed_nanos > 0`,
        )
          .bind(principal.address, principal.address)
          .first<{
            n: number;
            input_tokens: number;
            cached_tokens: number;
            output_tokens: number;
            token_billed_nanos: number;
          }>()
      : null;

  return c.json({
    address: principal.address,
    label: principal.label,
    // 余额是算出来的，六块累计数各自只增：充值 + 抵扣券 + 上游收入 − Gas 支出 − Token 支出 − 提现。
    balance_nanos: availableNanos(principal),
    recharge_nanos: principal.recharge_nanos,
    voucher_nanos: principal.voucher_nanos,
    earn_nanos: principal.earn_nanos,
    gas_spend_nanos: principal.gas_spend_nanos,
    token_spend_nanos: principal.token_spend_nanos,
    spend_nanos: totalSpendNanos(principal),
    withdraw_nanos: principal.withdraw_nanos,
    requests: totals?.n ?? 0,
    providers: providers.length,
    usage: {
      input_tokens: totals?.input_tokens ?? 0,
      cached_tokens: totals?.cached_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
    },
    // 账目构成：Gas 费（付给 Norm）vs Token 费（转给他人上游），以及没能收上来的部分。
    billed: {
      gas_fee_nanos: totals?.gas_fee_nanos ?? 0,
      gas_billed_nanos: totals?.gas_billed_nanos ?? 0,
      token_nanos: totals?.token_nanos ?? 0,
      token_billed_nanos: totals?.token_billed_nanos ?? 0,
      unbilled_nanos: totals?.unbilled_nanos ?? 0,
    },
    // 作为上游提供方服务他人收到的 Token 价值转移汇总。
    earned: {
      requests: earnedTotals?.n ?? 0,
      input_tokens: earnedTotals?.input_tokens ?? 0,
      cached_tokens: earnedTotals?.cached_tokens ?? 0,
      output_tokens: earnedTotals?.output_tokens ?? 0,
      token_nanos: earnedTotals?.token_billed_nanos ?? 0,
    },
    // 延迟与缓存率：一个是体感，一个是钱；两者都只在有值的那部分上取平均。
    latency: {
      avg_first_token_ms: Math.round(totals?.avg_first_token_ms ?? 0),
      avg_latency_ms: Math.round(totals?.avg_latency_ms ?? 0),
      streamed_requests: totals?.streamed_requests ?? 0,
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
 * 上游收入记录：他人调用本账户名下上游（公共池）时，转入本账户的 Token 价值明细。
 *
 * 只返回与收入核对相关的字段（调用方公钥、模型、token、转入额、收入前后链），
 * 不暴露调用方的 Gas 费与余额。游标同样是 UUID v7 `id`。
 */
accountRoutes.get('/earnings', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const before = c.req.query('before') ?? '';
  const address = c.get('principal').address;

  const where = before
    ? 'r.provider_user = ? AND r.address <> ? AND r.token_billed_nanos > 0 AND r.id < ?'
    : 'r.provider_user = ? AND r.address <> ? AND r.token_billed_nanos > 0';
  const statement = c.env.DB.prepare(
    `SELECT r.id,
            r.address AS consumer_address,
            r.provider_id,
            p.label AS provider_label,
            r.base_url,
            r.model,
            r.status,
            r.status_code,
            r.input_tokens,
            r.cached_tokens,
            r.output_tokens,
            r.token_nanos,
            r.token_billed_nanos,
            r.earn_before_nanos,
            r.earn_after_nanos,
            r.created_at
       FROM requests r
       LEFT JOIN providers p ON p.id = r.provider_id
      WHERE ${where}
      ORDER BY r.id DESC LIMIT ?`,
  );
  const { results } = await (before
    ? statement.bind(address, address, before, limit)
    : statement.bind(address, address, limit)
  ).all();

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
    `SELECT rowid AS cursor, id, kind, amount_nanos, available_after_nanos, created_at
     FROM ledger WHERE address = ? ${cursor ? 'AND rowid < ?' : ''}
     ORDER BY rowid DESC LIMIT ?`,
  )
    .bind(...(cursor ? [address, Number(cursor), limit] : [address, limit]))
    .all();

  return c.json({ items: results });
});

/**
 * 按下游消费者密钥聚合用量：账本要能回答「这把钥匙花了多少（Gas vs Token）」。
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
            COALESCE(SUM(requests.gas_billed_nanos), 0) AS gas_fee_nanos,
            COALESCE(SUM(requests.token_billed_nanos), 0) AS token_nanos,
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

/** 按上游提供商聚合：钱花在哪个上游提供商（Gas 付给 Norm，Token 转给上游提供方）。 */
accountRoutes.get('/usage/by-provider', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT requests.provider_id AS provider_id,
            providers.label AS provider_label,
            MAX(CASE WHEN requests.provider_user = requests.address THEN 1 ELSE 0 END) AS is_own,
            COUNT(*) AS requests,
            COALESCE(SUM(requests.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(requests.cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(requests.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(requests.gas_billed_nanos), 0) AS gas_fee_nanos,
            COALESCE(SUM(requests.token_billed_nanos), 0) AS token_nanos,
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
