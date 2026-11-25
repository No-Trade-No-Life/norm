import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { consumerKeyHash, consumerKeyHint, newConsumerKey } from '../consumers';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { findCredential } from '../store';

export type ConsumerRow = {
  id: string;
  address: string;
  name: string;
  /** 建的时候就绑死的那条上游提供者：一把密钥 = 一条完整调用。 */
  credential_id: string;
  key_sha256: string;
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export const consumerRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

/**
 * 列表绝不回 key_sha256：它虽然不是明文，但把「哪把钥匙属于这一行」变成了可下载的指纹，
 * 而前端一行都不需要它。SELECT * 会顺手把它带出去，所以这里逐列写出。
 */
consumerRoutes.get('/', async (c) => {
  // 顺带把上游提供者的昵称带上：列表要回答「这把钥匙打到哪」，而不是只回一个 id。
  const { results } = await c.env.DB.prepare(
    `SELECT consumers.id, consumers.name, consumers.key_hint, consumers.credential_id,
            credentials.label AS credential_label, credentials.base_url AS credential_base_url,
            consumers.created_at, consumers.last_used_at
     FROM consumers
     LEFT JOIN credentials ON credentials.id = consumers.credential_id
     WHERE consumers.address = ? AND consumers.revoked_at IS NULL
     ORDER BY consumers.created_at DESC, consumers.rowid DESC`,
  )
    .bind(c.get('principal').address)
    .all<Omit<ConsumerRow, 'address' | 'key_sha256' | 'revoked_at'>>();
  return c.json({ items: results });
});

/**
 * 建钥必须指定上游：绑定只在这一次决定，之后一次 Bearer 就是一次完整调用。
 * 不设默认值——「随便挑一条上游」会让一把钥匙悄悄变成别人的账单。
 */
consumerRoutes.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; credential_id?: string }>();
  const address = c.get('principal').address;
  const name = (body.name ?? '').trim();
  const credentialId = (body.credential_id ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');
  if (!credentialId) fail(400, 'credential_missing', '缺少 credential_id');

  const credential = await findCredential(c.env, address, credentialId);
  if (!credential) fail(404, 'credential_not_found', '凭证不存在或已撤销');

  // 明文密钥只在这几行里存在：哈希入库，明文只随这一次响应离开服务器。
  const key = newConsumerKey();
  const id = `cons_${randomToken(12)}`;
  await c.env.DB.prepare(
    'INSERT INTO consumers (id, address, name, credential_id, key_sha256, key_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, address, name, credentialId, consumerKeyHash(key), consumerKeyHint(key), nowSeconds())
    .run();

  return c.json(
    {
      id,
      name,
      credential_id: credentialId,
      credential_label: credential.label,
      key,
      key_hint: consumerKeyHint(key),
    },
    201,
  );
});

/**
 * 轮换：旧的立刻作废，新的明文同样只出现一次。
 * 就地换哈希而不是新建一行，是因为「这是同一个消费者」——备注名与使用历史都该留着。
 */
consumerRoutes.post('/:id/rotate', async (c) => {
  const address = c.get('principal').address;
  const existing = await c.env.DB.prepare(
    'SELECT * FROM consumers WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(c.req.param('id'), address)
    .first<ConsumerRow>();
  if (!existing) fail(404, 'consumer_not_found', '消费者不存在或已撤销');

  const key = newConsumerKey();
  await c.env.DB.prepare('UPDATE consumers SET key_sha256 = ?, key_hint = ? WHERE id = ?')
    .bind(consumerKeyHash(key), consumerKeyHint(key), existing.id)
    .run();
  return c.json({ id: existing.id, key, key_hint: consumerKeyHint(key) });
});

consumerRoutes.post('/:id/name', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) fail(400, 'name_missing', '缺少 name');

  const address = c.get('principal').address;
  const existing = await c.env.DB.prepare(
    'SELECT * FROM consumers WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(c.req.param('id'), address)
    .first<ConsumerRow>();
  if (!existing) fail(404, 'consumer_not_found', '消费者不存在或已撤销');

  await c.env.DB.prepare('UPDATE consumers SET name = ? WHERE id = ?').bind(name, existing.id).run();
  return c.json({ id: existing.id, name });
});

consumerRoutes.delete('/:id', async (c) => {
  const address = c.get('principal').address;
  const existing = await c.env.DB.prepare(
    'SELECT * FROM consumers WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(c.req.param('id'), address)
    .first<ConsumerRow>();
  if (!existing) fail(404, 'consumer_not_found', '消费者不存在或已撤销');

  await c.env.DB.prepare('UPDATE consumers SET revoked_at = ? WHERE id = ?')
    .bind(nowSeconds(), existing.id)
    .run();
  return c.json({ id: existing.id, revoked: true });
});
