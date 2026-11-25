import type { Env } from './env';
import type { Protocol, Visibility } from './protocols';
import { grantNanos } from './env';
import { isTrusted } from './base-urls';
import { fail } from './http';
import { randomToken } from './ids';

export type PrincipalRow = {
  address: string;
  label: string;
  created_at: number;
  balance_nanos: number;
  granted_nanos: number;
  spend_nanos: number;
};

export type ProviderView = ProviderRow & {
  /** 主机名是否在信任清单里。只回事实，怎么措辞由前端决定。 */
  trusted: boolean;
};

export type ProviderRow = {
  id: string;
  address: string;
  label: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  kdf: string;
  // INVARIANT: 这两列只由 providers 路由写入，写入前已校验枚举；
  // 因此读出来一定是合法取值，不需要在每个调用点再判一次。
  protocol: Protocol;
  visibility: Visibility;
  /** 1 = 参与选址；0 = 暂时不用。撤销（revoked_at）才是永久退场。 */
  enabled: number;
  public_listed: number;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 地址第一次出现就开户并给演示授信。三条语句在同一个 batch 里，
 * 保证「给钱」与「记这笔钱」不会分叉；重复调用安全。
 */
export async function ensurePrincipal(env: Env, address: string, at: number): Promise<void> {
  const grant = grantNanos(env);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO principals (address, created_at) VALUES (?, ?)').bind(address, at),
    env.DB.prepare(
      `INSERT INTO ledger (id, address, request_id, kind, amount_nanos, balance_after_nanos, created_at)
       SELECT ?, address, NULL, 'grant', ?, ?, ? FROM principals
       WHERE address = ? AND granted_nanos = 0`,
    ).bind(randomToken(), grant, grant, at, address),
    env.DB.prepare(
      `UPDATE principals SET balance_nanos = balance_nanos + ?, granted_nanos = ?
       WHERE address = ? AND granted_nanos = 0`,
    ).bind(grant, grant, address),
  ]);
}

export async function principalExists(env: Env, address: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS found FROM principals WHERE address = ?').bind(address).first<{ found: number }>();
  return row !== null;
}

export async function findPrincipal(env: Env, address: string): Promise<PrincipalRow> {
  const row = await env.DB.prepare('SELECT * FROM principals WHERE address = ?').bind(address).first<PrincipalRow>();
  if (!row) throw new Error(`账户不存在：${address}`);
  return row;
}

export async function listProviders(env: Env, address: string): Promise<ProviderView[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM providers WHERE address = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC',
  )
    .bind(address)
    .all<ProviderRow>();
  // trusted 由同一份清单算出，不落库：清单改了，所有上游提供商的说法立刻跟着变。
  return results.map((row) => ({ ...row, trusted: isTrusted(row.base_url, env) }));
}

export async function findProvider(env: Env, address: string, id: string): Promise<ProviderRow | null> {
  return env.DB.prepare('SELECT * FROM providers WHERE id = ? AND address = ? AND revoked_at IS NULL')
    .bind(id, address)
    .first<ProviderRow>();
}

/**
 * 一次调用的全部记账：扣钱、记流水、记请求，三步只描述同一件事。
 *
 * 余额的扣减用一条 `UPDATE ... MIN(?, balance)` 完成：扣掉的是「该付的」与「还剩下的」
 * 里较小的那个，返回值天然与并发隔离。为什么允许扣不满：上游提供商已经执行完了，
 * 这笔钱该记下来，而账不能变成负数——差的那部分记成 `unbilled_nanos`，
 * 由站点承担，并在页面上如实显示。
 *
 * 余额充足时 `unbilled_nanos` 恒为 0，`fee_nanos = gas_fee_nanos + token_nanos`。
 * 失败（上游提供商报错、网络不可达）也走这里：Gas 照收，token 那部分是 0。
 */

export type Settled = {
  /** 真正从余额里扣掉的数。 */
  billedNanos: number;
  /** 扣不满、由站点承担的部分。 */
  unbilledNanos: number;
  balanceNanos: number;
};

export type RequestRecord = {
  requestId: string;
  address: string;
  providerId: string | null;
  /** 这次调用由哪把下游消费者密钥发起；签名直连时为空。 */
  consumerId: string | null;
  baseUrl: string;
  model: string;
  status: string;
  statusCode: number | null;
  latencyMs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  gasFeeNanos: number;
  tokenNanos: number;
  feeNanos: number;
  unbilledNanos: number;
  at: number;
};

/** 只写请求记录、不扣费：`settle` 三次都被并发改写时用它兜底，那一笔标成未收。 */
export async function recordRequest(env: Env, row: RequestRecord): Promise<void> {
  await requestInsert(env, row).run();
}

/**
 * 这次转发用哪条上游提供商：头里点了名就用它，没点名就用账户里唯一的那条。
 *
 * 多条又不指名是 409 而不是猜一条——「钱付给谁」是这个服务里失败代价最高的选择，
 * 不该由一个默认值替用户决定。签名身份与消费者 Token 走同一个判定点。
 */
export async function resolveProviderId(env: Env, address: string, requested: string | null): Promise<string> {
  const named = requested?.trim();
  if (named) return named;

  // 只有启用的上游提供商参与自动选址：禁用的那条等于「这次不想用它」，
  // 不该因为它是账户里唯一的一条就被悄悄用上。
  const { results } = await env.DB.prepare(
    'SELECT id FROM providers WHERE address = ? AND revoked_at IS NULL AND enabled = 1 ORDER BY created_at DESC, rowid DESC LIMIT 2',
  )
    .bind(address)
    .all<{ id: string }>();

  if (results.length === 0) {
    // 「一条都没有」与「有但都关掉了」是两种处境：前者去添加，后者只需拨回开关。
    const any = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM providers WHERE address = ? AND revoked_at IS NULL',
    )
      .bind(address)
      .first<{ n: number }>();
    if ((any?.n ?? 0) > 0) fail(409, 'provider_disabled', '账户里的上游提供商都已禁用：到「上游提供商」页启用一条');
    fail(400, 'provider_missing', '还没有上游提供商：先去「上游提供商」页添加一条');
  }
  if (results.length > 1) {
    fail(409, 'provider_ambiguous', '账户里有多条上游提供商，请用 X-Norm-Provider 指名用哪一条');
  }
  return results[0].id;
}

/**
 * 扣费 + 流水 + 请求记录：一次调用的三件事，写在一起。
 *
 * 扣多少：该付多少就扣多少，余额不够时把剩下的全扣掉（余额落到 0），
 * 差的那部分记成 `unbilled_nanos` 由站点承担——上游提供商已经执行完了，账要记，
 * 但余额不能变成负数。
 *
 * 为什么是「先读再带条件更新」而不是一条 `UPDATE ... RETURNING`：
 * 我们需要知道**扣掉了多少**才能写流水，而 RETURNING 只给新余额，
 * 分不清「余额刚好够」与「余额不够」这两种都落到 0 的情况。
 * 于是用读到的余额做乐观并发条件（`balance_nanos = ?`），被并发改掉就重读重算。
 * 同一个账户同时打多个请求时才会撞上，最多重试 3 次。
 */
export async function settle(env: Env, row: RequestRecord): Promise<Settled> {
  const due = row.gasFeeNanos + row.tokenNanos;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await env.DB.prepare('SELECT balance_nanos FROM principals WHERE address = ?')
      .bind(row.address)
      .first<{ balance_nanos: number }>();
    if (!current) throw new Error(`账户不存在：${row.address}`);

    const billed = Math.min(due, Math.max(current.balance_nanos, 0));
    const updated = await env.DB.prepare(
      `UPDATE principals SET balance_nanos = balance_nanos - ?, spend_nanos = spend_nanos + ?
       WHERE address = ? AND balance_nanos = ?
       RETURNING balance_nanos`,
    )
      .bind(billed, billed, row.address, current.balance_nanos)
      .first<{ balance_nanos: number }>();
    if (!updated) continue;

    const settled: Settled = {
      billedNanos: billed,
      unbilledNanos: due - billed,
      balanceNanos: updated.balance_nanos,
    };

    // 流水与请求记录同批写入：这条 charge 一定能回到那次请求。
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ledger (id, address, request_id, kind, amount_nanos, balance_after_nanos, created_at)
         VALUES (?, ?, ?, 'charge', ?, ?, ?)`,
      ).bind(randomToken(), row.address, row.requestId, -billed, settled.balanceNanos, row.at),
      requestInsert(env, { ...row, feeNanos: billed, unbilledNanos: settled.unbilledNanos }),
    ]);
    return settled;
  }

  // 三次都被并发改写：宁可不扣，也不猜一个数。请求照样落库，账面上标成未收。
  const latest = await env.DB.prepare('SELECT balance_nanos FROM principals WHERE address = ?')
    .bind(row.address)
    .first<{ balance_nanos: number }>();
  await recordRequest(env, { ...row, feeNanos: 0, unbilledNanos: due });
  return { billedNanos: 0, unbilledNanos: due, balanceNanos: latest?.balance_nanos ?? 0 };
}

function requestInsert(env: Env, row: RequestRecord) {
  return env.DB.prepare(
    `INSERT INTO requests
       (id, address, provider_id, consumer_id, base_url, model, status, status_code, latency_ms,
        input_tokens, cached_tokens, output_tokens,
        gas_fee_nanos, token_nanos, fee_nanos, unbilled_nanos, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.requestId,
    row.address,
    row.providerId,
    row.consumerId,
    row.baseUrl,
    row.model,
    row.status,
    row.statusCode,
    row.latencyMs,
    row.inputTokens,
    row.cachedTokens,
    row.outputTokens,
    row.gasFeeNanos,
    row.tokenNanos,
    row.feeNanos,
    row.unbilledNanos,
    row.at,
  );
}
