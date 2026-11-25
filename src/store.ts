import type { Env } from './env';
import type { Protocol, Visibility } from './protocols';
import { grantMicros } from './env';
import { isTrusted } from './base-urls';
import { fail } from './http';
import { randomToken } from './ids';

export type PrincipalRow = {
  address: string;
  label: string;
  created_at: number;
  balance_micros: number;
  granted_micros: number;
  spend_micros: number;
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
  public_listed: number;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 地址第一次出现就开户并给演示授信。三条语句在同一个 batch 里，
 * 保证「给钱」与「记这笔钱」不会分叉；重复调用安全。
 */
export async function ensurePrincipal(env: Env, address: string, at: number): Promise<void> {
  const grant = grantMicros(env);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO principals (address, created_at) VALUES (?, ?)').bind(address, at),
    env.DB.prepare(
      `INSERT INTO ledger (id, address, request_id, kind, amount_micros, balance_after_micros, created_at)
       SELECT ?, address, NULL, 'grant', ?, ?, ? FROM principals
       WHERE address = ? AND granted_micros = 0`,
    ).bind(randomToken(), grant, grant, at, address),
    env.DB.prepare(
      `UPDATE principals SET balance_micros = balance_micros + ?, granted_micros = ?
       WHERE address = ? AND granted_micros = 0`,
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
  // trusted 由同一份清单算出，不落库：清单改了，所有 provider 的说法立刻跟着变。
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
 * 里较小的那个，返回值天然与并发隔离。为什么允许扣不满：Provider 已经执行完了，
 * 这笔钱该记下来，而账不能变成负数——差的那部分记成 `unbilled_micros`，
 * 由站点承担，并在页面上如实显示。
 *
 * 余额充足时 `unbilled_micros` 恒为 0，`fee_micros = service_fee_micros + token_micros`。
 * 失败（Provider 报错、网络不可达）不调用这里：那条路只写请求记录，扣费为 0。
 */
export type Bill = {
  requestId: string;
  /** 一次性服务费，与 token 无关。 */
  serviceFeeMicros: number;
  /** 三项 token 折出来的钱。 */
  tokenMicros: number;
};

export type Settled = {
  /** 真正从余额里扣掉的数。 */
  billedMicros: number;
  /** 扣不满、由站点承担的部分。 */
  unbilledMicros: number;
  balanceMicros: number;
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
  serviceFeeMicros: number;
  tokenMicros: number;
  feeMicros: number;
  unbilledMicros: number;
  at: number;
};

/** 只写请求记录、不扣费：失败路径用它，代价由站点承担。 */
export async function recordRequest(env: Env, row: RequestRecord): Promise<void> {
  await requestInsert(env, row).run();
}

/**
 * 这次转发用哪条 provider：头里点了名就用它，没点名就用账户里唯一的那条。
 *
 * 多条又不指名是 409 而不是猜一条——「钱付给谁」是这个服务里失败代价最高的选择，
 * 不该由一个默认值替用户决定。签名身份与消费者 Token 走同一个判定点。
 */
export async function resolveProviderId(env: Env, address: string, requested: string | null): Promise<string> {
  const named = requested?.trim();
  if (named) return named;

  const { results } = await env.DB.prepare(
    'SELECT id FROM providers WHERE address = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 2',
  )
    .bind(address)
    .all<{ id: string }>();

  if (results.length === 0) fail(400, 'provider_missing', '还没有 provider：先去「 provider」页添加一条');
  if (results.length > 1) {
    fail(409, 'provider_ambiguous', '账户里有多条 provider，请用 X-Norm-Provider 指名用哪一条');
  }
  return results[0].id;
}

/**
 * 扣费 + 流水 + 请求记录：一次调用的三件事，写在一起。
 *
 * 扣多少：该付多少就扣多少，余额不够时把剩下的全扣掉（余额落到 0），
 * 差的那部分记成 `unbilled_micros` 由站点承担——Provider 已经执行完了，账要记，
 * 但余额不能变成负数。
 *
 * 为什么是「先读再带条件更新」而不是一条 `UPDATE ... RETURNING`：
 * 我们需要知道**扣掉了多少**才能写流水，而 RETURNING 只给新余额，
 * 分不清「余额刚好够」与「余额不够」这两种都落到 0 的情况。
 * 于是用读到的余额做乐观并发条件（`balance_micros = ?`），被并发改掉就重读重算。
 * 同一个账户同时打多个请求时才会撞上，最多重试 3 次。
 */
export async function settle(env: Env, row: RequestRecord): Promise<Settled> {
  const due = row.serviceFeeMicros + row.tokenMicros;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await env.DB.prepare('SELECT balance_micros FROM principals WHERE address = ?')
      .bind(row.address)
      .first<{ balance_micros: number }>();
    if (!current) throw new Error(`账户不存在：${row.address}`);

    const billed = Math.min(due, Math.max(current.balance_micros, 0));
    const updated = await env.DB.prepare(
      `UPDATE principals SET balance_micros = balance_micros - ?, spend_micros = spend_micros + ?
       WHERE address = ? AND balance_micros = ?
       RETURNING balance_micros`,
    )
      .bind(billed, billed, row.address, current.balance_micros)
      .first<{ balance_micros: number }>();
    if (!updated) continue;

    const settled: Settled = {
      billedMicros: billed,
      unbilledMicros: due - billed,
      balanceMicros: updated.balance_micros,
    };

    // 流水与请求记录同批写入：这条 charge 一定能回到那次请求。
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ledger (id, address, request_id, kind, amount_micros, balance_after_micros, created_at)
         VALUES (?, ?, ?, 'charge', ?, ?, ?)`,
      ).bind(randomToken(), row.address, row.requestId, -billed, settled.balanceMicros, row.at),
      requestInsert(env, { ...row, feeMicros: billed, unbilledMicros: settled.unbilledMicros }),
    ]);
    return settled;
  }

  // 三次都被并发改写：宁可不扣，也不猜一个数。请求照样落库，账面上标成未收。
  const latest = await env.DB.prepare('SELECT balance_micros FROM principals WHERE address = ?')
    .bind(row.address)
    .first<{ balance_micros: number }>();
  await recordRequest(env, { ...row, feeMicros: 0, unbilledMicros: due });
  return { billedMicros: 0, unbilledMicros: due, balanceMicros: latest?.balance_micros ?? 0 };
}

function requestInsert(env: Env, row: RequestRecord) {
  return env.DB.prepare(
    `INSERT INTO requests
       (id, address, provider_id, consumer_id, base_url, model, status, status_code, latency_ms,
        input_tokens, cached_tokens, output_tokens,
        service_fee_micros, token_micros, fee_micros, unbilled_micros, created_at)
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
    row.serviceFeeMicros,
    row.tokenMicros,
    row.feeMicros,
    row.unbilledMicros,
    row.at,
  );
}
