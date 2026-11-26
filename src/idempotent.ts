import type { Env } from './env';
import { sha256Hex, utf8 } from './crypto';

/**
 * 一次性不再靠一张 `nonces` 表，而靠两样东西：
 *
 *   1. 时间窗（`SIGNATURE_WINDOW_SECONDS`）只管**新鲜度**：这个签名是不是刚签的；
 *   2. 请求自带的幂等键（`X-Norm-Nonce`）只管**做过没有**：它落在被改的那一行上，
 *      或者派生出新行的 id。
 *
 * 为什么值得这样换掉：D1 按行计费，而旧做法对**每一次**签名调用都要写两行
 * （`nonces` 的表行 + 主键索引），读也一样：浏览器每轮询一次 `/account/me`，
 * 就是两行。而 `nonces` 还只能靠手工脚本清理。
 *
 * 新做法里「去重」不产生任何额外写入：它本身就是那次真正的改动。
 *
 * 一条边界要说清：这些都是**状态变更**的事。读（GET / HEAD）既不查也不写任何去重
 * 状态——重放一次读没有副作用，时间窗放行就够了。
 */

/** 只有这两张表是「一行一个资源、`address` 是主人」的形状，幂等键就落在这两张表的行上。 */
export type IdempotentTable = 'providers' | 'consumers';

/** 一次带幂等键的写入的结果；调用方按它决定回 200 / 404 / 409。 */
export type ApplyOutcome =
  /** 这次真的改到了：写入 1 行，幂等键同时落在这一行上。 */
  | { applied: true }
  /** 这一行上一次就是被这把 nonce 改的——重放。没写任何行，但语义上算成功。 */
  | { applied: false; reason: 'replayed' }
  /** 行不在，或已撤销。 */
  | { applied: false; reason: 'missing' }
  /** 行还在、也没撤销，却始终没改着（并发抢同一行，重试一次仍没落上）。 */
  | { applied: false; reason: 'stale' };

/**
 * 由幂等键派生出的行 id：`sha256(address ‖ METHOD ‖ PATH ‖ nonce)` 的前 22 位十六进制。
 *
 * 用**签名覆盖的那几个字段**派生，而不是另加一个 id 字段：同一个签名请求打两次，
 * 两次算出同一个 id，于是第二条 `INSERT ... ON CONFLICT (id) DO NOTHING` 落空
 * （`meta.changes === 0`），「只建一行」不需要任何额外的去重写。
 *
 * PATH 取 pathname（不含 query），与 `signingMessage` 里的 PATH 同源。
 */
export function idempotentId({
  address,
  method,
  path,
  nonce,
}: {
  address: string;
  method: string;
  path: string;
  nonce: string;
}): string {
  return sha256Hex(utf8(`${address}\n${method.toUpperCase()}\n${path.split('?')[0]}\n${nonce}`)).slice(0, 22);
}

/**
 * 改一行，并把这次的幂等键写在这一行上——**这是状态变更唯一的写法**。
 *
 *   · 第一次：`UPDATE` 命中 1 行（写入 1 行），`last_nonce` 换成这次的 nonce；
 *   · 同一把 nonce 再来一次：`last_nonce <> ?` 不成立，`changes = 0`，再读一次这一行，
 *     nonce 对得上就当「已应用」返回，**一行都不写**；
 *   · 行不在或已撤销：读也读不到（或读到 revoked），调用方回 404；
 *   · 并发：另一把 nonce 刚刚抢先落上，重试一次（第二次通常就成），仍不行就是 `stale`。
 *
 * 条件更新而不是「先查再改」：查与改之间的窗口里，同一行的两次改动会互相覆盖；
 * `(last_nonce IS NULL OR last_nonce <> ?)` 让 SQLite 自己判定谁先落上。
 *
 * `last_nonce` 存的是 `X-Norm-Nonce` 的原值（不是派生出来的 id）：排查一行「上一次
 * 是谁改的」时，看到的就是调用方手里那把 nonce。同一把 nonce 用在两个不同端点上
 * 属于客户端误用，后果只是后一次被当成重放——不是安全问题，也不会改错行。
 */
export async function applyOnce({
  env,
  table,
  id,
  address,
  set,
  values,
  nonce,
  guard = 'revoked_at IS NULL',
}: {
  env: Env;
  table: IdempotentTable;
  id: string;
  address: string;
  /** SET 子句本体，**不含** `last_nonce`（由这里补）。 */
  set: string;
  values: readonly (string | number | null)[];
  /** 这次的幂等键：`X-Norm-Nonce` 原值。 */
  nonce: string;
  /** 额外条件，默认「未撤销」。 */
  guard?: string;
}): Promise<ApplyOutcome> {
  // 表名来自上面那个联合类型（不是用户输入），SET 子句由调用方以字面量给出，值全部走绑定。
  const update = () =>
    env.DB.prepare(
      `UPDATE ${table} SET ${set}, last_nonce = ?
        WHERE id = ? AND address = ? AND (last_nonce IS NULL OR last_nonce <> ?) AND ${guard}`,
    ).bind(...values, nonce, id, address, nonce);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await update().run();
    if (updated.meta.changes > 0) return { applied: true };

    // 没改着只有三种可能，读一次这一行就能分开：不在了 / 就是这把 nonce 改的 / 别人刚改的。
    const row = await env.DB.prepare(`SELECT last_nonce, revoked_at FROM ${table} WHERE id = ? AND address = ?`)
      .bind(id, address)
      .first<{ last_nonce: string | null; revoked_at: number | null }>();
    if (!row) return { applied: false, reason: 'missing' };
    if (row.last_nonce === nonce) return { applied: false, reason: 'replayed' };
    if (row.revoked_at !== null) return { applied: false, reason: 'missing' };
    // 剩下的是并发：另一把 nonce 先落上了。再试一次。
  }
  return { applied: false, reason: 'stale' };
}
