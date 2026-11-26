import { Hono } from 'hono';
import type { Env } from '../env';
import type { Identity } from '../auth';
import { consumerKeyHash, consumerKeyHint, newConsumerKey } from '../consumers';
import { fail } from '../http';
import { nowSeconds } from '../ids';
import { applyOnce, idempotentId, type ApplyOutcome } from '../idempotent';

export type ConsumerRow = {
  id: string;
  address: string;
  name: string;
  key_sha256: string;
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  /** 上一次改动这条记录的幂等键；见 src/idempotent.ts 的 applyOnce。 */
  last_nonce: string | null;
};

export const consumerRoutes = new Hono<{ Bindings: Env; Variables: { principal: Identity } }>();

/**
 * 列表绝不回 key_sha256：它虽然不是明文，但把「哪把钥匙属于这一行」变成了可下载的指纹，
 * 而前端一行都不需要它。SELECT * 会顺手把它带出去，所以这里逐列写出。
 */
consumerRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, key_hint, created_at, last_used_at
     FROM consumers WHERE address = ? AND revoked_at IS NULL
     ORDER BY created_at DESC, rowid DESC`,
  )
    .bind(c.get('principal').address)
    .all<Omit<ConsumerRow, 'address' | 'key_sha256' | 'revoked_at' | 'last_nonce'>>();
  return c.json({ items: results });
});

/**
 * 建钥只要一个名字：它回答的是「这段代码是谁」，与「走哪条上游提供商」无关。
 *
 * 少一个必填字段就少一次配置错误——走哪条上游在转发时才决定（见 store.resolveProvider），
 * 所以给一个新程序发钥匙不必先想清楚它会用哪个上游提供商，也不会因为后来换了上游提供商而作废。
 *
 * 新行的 id 由这把幂等键派生（见 src/idempotent.ts）：同一个签名请求打两次，第二条
 * `INSERT` 落空，于是「只建一行」不需要任何额外的去重写。
 */
consumerRoutes.post('/', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const identity = c.get('principal');
  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');

  const id = `cons_${idempotentId({ address: identity.address, method: 'POST', path: c.req.path, nonce: identity.nonce })}`;
  // 明文密钥只在这几行里存在：哈希入库，明文只随这一次响应离开服务器。
  const key = newConsumerKey();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO consumers (id, address, name, key_sha256, key_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  )
    .bind(id, identity.address, name, consumerKeyHash(key), consumerKeyHint(key), nowSeconds())
    .run();

  if (inserted.meta.changes === 0) {
    // 这把 nonce 已经建过这一条：库里存的是**第一次**那把密钥的哈希，所以这次不能再把
    // 刚生成的这一把交出去（它不会生效，交出去只会让人以为自己拿到了钥匙）。
    // 明文密钥从来只有第一次响应里那一次——重放拿到的是「已应用」。
    return c.json({ id, name, replayed: true }, 200);
  }

  return c.json({ id, name, key, key_hint: consumerKeyHint(key) }, 201);
});

/**
 * 轮换：旧的立刻作废，新的明文同样只出现一次。
 * 就地换哈希而不是新建一行，是因为「这是同一个消费者」——备注名与使用历史都该留着。
 *
 * 重放必须回 409 **且绝不能再签发第二把密钥**：第一次已经把新哈希写进库里了，
 * 第二次再生成一把，那一把的哈希没入库、拿出去也用不了，而调用方会以为自己换了钥匙。
 * 所以判「重放」发生在生成密钥之前，落库那一步的条件更新再兜一层并发。
 */
consumerRoutes.post('/:id/rotate', async (c) => {
  const identity = c.get('principal');
  const existing = await c.env.DB.prepare(
    'SELECT * FROM consumers WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(c.req.param('id'), identity.address)
    .first<ConsumerRow>();
  if (!existing) fail(404, 'consumer_not_found', '消费者不存在或已撤销');
  if (existing.last_nonce === identity.nonce) {
    fail(409, 'nonce_replayed', '这把 nonce 已经轮换过了：明文只在第一次的响应里出现，重放不会再签发第二把密钥');
  }

  const key = newConsumerKey();
  const outcome = await applyOnce({
    env: c.env,
    table: 'consumers',
    id: existing.id,
    address: identity.address,
    set: 'key_sha256 = ?, key_hint = ?',
    values: [consumerKeyHash(key), consumerKeyHint(key)],
    nonce: identity.nonce,
  });
  if (!outcome.applied) {
    // 走到这里说明并发的另一个请求先落上了：这把刚生成的密钥随响应一起丢弃，绝不交出去。
    if (outcome.reason === 'replayed') {
      fail(409, 'nonce_replayed', '这把 nonce 已经轮换过了：明文只在第一次的响应里出现，重放不会再签发第二把密钥');
    }
    failConsumer(outcome);
  }
  return c.json({ id: existing.id, key, key_hint: consumerKeyHint(key) });
});

consumerRoutes.post('/:id/name', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');

  const identity = c.get('principal');
  const outcome = await applyOnce({
    env: c.env,
    table: 'consumers',
    id: c.req.param('id'),
    address: identity.address,
    set: 'name = ?',
    values: [name],
    nonce: identity.nonce,
  });
  if (!outcome.applied && outcome.reason !== 'replayed') failConsumer(outcome);
  return c.json({ id: c.req.param('id'), name, ...(outcome.applied ? {} : { replayed: true }) });
});

consumerRoutes.delete('/:id', async (c) => {
  const identity = c.get('principal');
  const outcome = await applyOnce({
    env: c.env,
    table: 'consumers',
    id: c.req.param('id'),
    address: identity.address,
    set: 'revoked_at = ?',
    values: [nowSeconds()],
    nonce: identity.nonce,
  });
  if (!outcome.applied && outcome.reason !== 'replayed') failConsumer(outcome);
  return c.json({ id: c.req.param('id'), revoked: true, ...(outcome.applied ? {} : { replayed: true }) });
});

/** 改一行没改着：行不在或已撤销 → 404；并发抢同一行 → 409。 */
function failConsumer(outcome: ApplyOutcome): never {
  if (!outcome.applied && outcome.reason === 'stale') {
    fail(409, 'write_conflict', '这一行刚被另一个请求改动过，请重新发起');
  }
  fail(404, 'consumer_not_found', '消费者不存在或已撤销');
}
