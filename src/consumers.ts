import type { Env } from './env';
import type { Principal } from './auth';
import { fail } from './http';
import { base58 } from './ids';
import { sha256Hex, utf8 } from './crypto';
import { availableNanos } from './store';

/**
 * 下游消费者密钥：`sk-norm-` + base58(32 字节随机)。
 *
 * 与 Ed25519 身份是两种不同的东西：签名身份证明「我是谁」，并且能管理自己的资源；
 * 消费者密钥只是一条程序凭据，拿去就能消费。走哪条上游是转发时的决定，不写在凭据里：
 * 自己的上游优先、公共池兜底、thread-id / session-id 粘住（见 store.resolveProvider）。
 * 库里只存 sha256，拖库拿不到明文。
 *
 * 明文只在创建与轮换的那一次响应里出现，之后只有 key_hint。
 */
const PREFIX = 'sk-norm-';

export function newConsumerKey(): string {
  return PREFIX + base58.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function consumerKeyHash(key: string): string {
  return sha256Hex(utf8(key));
}

/** 展示用提示：`sk-norm-abcd…wxyz`。8 个可见字符远不足以还原 258 位的密钥。 */
export function consumerKeyHint(key: string): string {
  return `${PREFIX}${key.slice(PREFIX.length, PREFIX.length + 4)}…${key.slice(-4)}`;
}

/**
 * Bearer 凭据 → 账户与余额快照（零写入、单次 JOIN 读）。
 *
 * 刻意不在这里写 `last_used_at`：如果后面的请求体不合法、余额低于安全阈值或没有可用上游，
 * 提前拒绝的请求应当产生 0 次 D1 写入。真正确认执行时再调 `touchConsumer` 并计入 Gas。
 * 同时顺手 JOIN `principals` 读出余额，省掉转发路径上原本多出来的那一次 `findPrincipal` 读。
 */
export async function principalFromConsumerKey(env: Env, key: string): Promise<Principal> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.address, c.last_used_at,
            p.recharge_nanos, p.voucher_nanos, p.spend_nanos, p.withdraw_nanos
       FROM consumers c
       JOIN principals p ON p.address = c.address
      WHERE c.key_sha256 = ? AND c.revoked_at IS NULL`,
  )
    .bind(consumerKeyHash(key))
    .first<{
      id: string;
      address: string;
      last_used_at: number | null;
      recharge_nanos: number;
      voucher_nanos: number;
      spend_nanos: number;
      withdraw_nanos: number;
    }>();
  if (!row) fail(401, 'consumer_key_invalid', '消费者密钥无效或已撤销');

  return {
    address: row.address,
    consumerId: row.id,
    balanceNanos: availableNanos(row),
    consumerLastUsedAt: row.last_used_at,
  };
}

const SECONDS_PER_DAY = 86_400;

/**
 * 按 UTC 自然日节流 `consumers.last_used_at`：
 * 从未使用或跨了 UTC 日期才写一次（每把钥匙每天最多 1 行 D1 写，同日后续调用 0 写、+0 Gas）。
 */
export function needsConsumerTouch(lastUsedAt: number | null, nowSec: number): boolean {
  if (lastUsedAt === null) return true;
  return Math.floor(lastUsedAt / SECONDS_PER_DAY) !== Math.floor(nowSec / SECONDS_PER_DAY);
}

/**
 * 记录下游密钥最近使用时间（1 行 D1 写，last_used_at 非索引列）。
 * 仅在确认要执行请求且跨日/首次使用时调用，并由调用方计入 GasMeter。
 */
export async function touchConsumer(env: Env, consumerId: string): Promise<void> {
  await env.DB.prepare('UPDATE consumers SET last_used_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), consumerId)
    .run();
}
