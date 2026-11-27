import { Hono } from 'hono';
import type { Env } from '../env';
import type { Identity } from '../auth';
import { consumerKeyHash, consumerKeyHint, newConsumerKey } from '../consumers';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';

export type ConsumerRow = {
  id: string;
  address: string;
  name: string;
  key_sha256: string;
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
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
    .all<Omit<ConsumerRow, 'address' | 'key_sha256' | 'revoked_at'>>();
  return c.json({ items: results });
});

/**
 * 建钥只要一个名字：它回答的是「这段代码是谁」，与「走哪条上游提供商」无关。
 *
 * 少一个必填字段就少一次配置错误——走哪条上游在转发时才决定（见 store.resolveProvider），
 * 所以给一个新程序发钥匙不必先想清楚它会用哪个上游提供商，也不会因为后来换了上游提供商而作废。
 */
consumerRoutes.post('/', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const address = c.get('principal').address;
  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');

  // 明文密钥只在这几行里存在：哈希入库，明文只随这一次响应离开服务器。
  const id = `cons_${randomToken(12)}`;
  const key = newConsumerKey();
  await c.env.DB.prepare(
    `INSERT INTO consumers (id, address, name, key_sha256, key_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, address, name, consumerKeyHash(key), consumerKeyHint(key), nowSeconds())
    .run();

  return c.json({ id, name, key, key_hint: consumerKeyHint(key) }, 201);
});

/**
 * 轮换：旧的立刻作废，新的明文同样只出现一次。
 * 就地换哈希而不是新建一行，是因为「这是同一个消费者」——备注名与使用历史都该留着。
 */
consumerRoutes.post('/:id/rotate', async (c) => {
  const address = c.get('principal').address;
  const id = c.req.param('id');
  const key = newConsumerKey();
  const keyHint = consumerKeyHint(key);
  const updated = await c.env.DB.prepare(
    'UPDATE consumers SET key_sha256 = ?, key_hint = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(consumerKeyHash(key), keyHint, id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'consumer_not_found', '消费者不存在或已撤销');
  return c.json({ id, key, key_hint: keyHint });
});

consumerRoutes.post('/:id/name', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');

  const address = c.get('principal').address;
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare(
    'UPDATE consumers SET name = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(name, id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'consumer_not_found', '消费者不存在或已撤销');
  return c.json({ id, name });
});

consumerRoutes.delete('/:id', async (c) => {
  const address = c.get('principal').address;
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare(
    'UPDATE consumers SET revoked_at = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(nowSeconds(), id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'consumer_not_found', '消费者不存在或已撤销');
  return c.json({ id, revoked: true });
});
