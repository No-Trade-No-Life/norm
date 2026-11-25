import type { Env } from './env';
import type { Principal } from './auth';
import { fail } from './http';
import { base58 } from './ids';
import { sha256Hex, utf8 } from './crypto';

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
 * Bearer 凭据 → 账户。
 *
 * 密钥只回答「谁的代码在用」。走哪条上游是转发时的决定，不写在身份里：
 * 自己的上游优先，公共池兜底（见 store.resolveProvider）。
 *
 * 「用过」这个事实在鉴权时就近记下：调用方不必多一个写操作分支，
 * 而页面能诚实回答「这把钥匙还在被用吗」。
 */
export async function principalFromConsumerKey(env: Env, key: string): Promise<Principal> {
  const row = await env.DB.prepare('SELECT id, address FROM consumers WHERE key_sha256 = ? AND revoked_at IS NULL')
    .bind(consumerKeyHash(key))
    .first<{ id: string; address: string }>();
  if (!row) fail(401, 'consumer_key_invalid', '消费者密钥无效或已撤销');

  await env.DB.prepare('UPDATE consumers SET last_used_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), row.id)
    .run();
  // 顺手把 consumer id 交出去：账本要能回答「这条钱是哪把钥匙花的」。
  return { address: row.address, consumerId: row.id };
}
