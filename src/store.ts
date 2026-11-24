import type { Env } from './env';
import type { UpstreamProtocol, UpstreamVisibility } from './upstreams';
import { grantMicros } from './env';
import { isTrusted } from './base-urls';
import { randomToken } from './ids';

export type PrincipalRow = {
  address: string;
  label: string;
  created_at: number;
  balance_micros: number;
  granted_micros: number;
  spend_micros: number;
};

export type CredentialView = CredentialRow & {
  /** 主机名是否在信任清单里。只回事实，怎么措辞由前端决定。 */
  trusted: boolean;
};

export type CredentialRow = {
  id: string;
  address: string;
  label: string;
  provider: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  kdf: string;
  // INVARIANT: 这两列只由 credentials 路由写入，写入前已校验枚举；
  // 因此读出来一定是合法取值，不需要在每个调用点再判一次。
  upstream_protocol: UpstreamProtocol;
  upstream_visibility: UpstreamVisibility;
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

export async function listCredentials(env: Env, address: string): Promise<CredentialView[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM credentials WHERE address = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC',
  )
    .bind(address)
    .all<CredentialRow>();
  // trusted 由同一份清单算出，不落库：清单改了，所有凭证的说法立刻跟着变。
  return results.map((row) => ({ ...row, trusted: isTrusted(row.base_url, env) }));
}

export async function findCredential(env: Env, address: string, id: string): Promise<CredentialRow | null> {
  return env.DB.prepare('SELECT * FROM credentials WHERE id = ? AND address = ? AND revoked_at IS NULL')
    .bind(id, address)
    .first<CredentialRow>();
}

/**
 * 扣费与记账之间不能有窗口：余额的更新用一条 `UPDATE ... RETURNING` 完成，
 * 返回值就是这笔扣费之后的余额，天然与并发隔离。
 * 余额不足时返回 null——不做"先欠后补"。
 */
export async function charge(
  env: Env,
  address: string,
  requestId: string,
  amountMicros: number,
  at: number,
): Promise<number | null> {
  const updated = await env.DB.prepare(
    `UPDATE principals SET balance_micros = balance_micros - ?, spend_micros = spend_micros + ?
     WHERE address = ? AND balance_micros >= ?
     RETURNING balance_micros`,
  )
    .bind(amountMicros, amountMicros, address, amountMicros)
    .first<{ balance_micros: number }>();
  if (!updated) return null;

  await env.DB.prepare(
    `INSERT INTO ledger (id, address, request_id, kind, amount_micros, balance_after_micros, created_at)
     VALUES (?, ?, ?, 'charge', ?, ?, ?)`,
  )
    .bind(randomToken(), address, requestId, -amountMicros, updated.balance_micros, at)
    .run();
  return updated.balance_micros;
}
