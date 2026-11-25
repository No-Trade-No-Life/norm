import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { fail } from '../http';
import { nowSeconds, uuidv4 } from '../ids';
import { isProtocol, isVisibility } from '../protocols';
import { hostOf } from '../base-urls';
import { keyHintOf, sealProviderKey } from '../seal';
import { findProvider, listProviders } from '../store';

type Body = {
  label?: string;
  base_url?: string;
  /** 上游提供商明文密钥：只在这一次请求体里出现，服务端立刻封装，之后再也不见明文。 */
  provider_key?: string;
  protocol?: string;
  visibility?: string;
};

/** 库里密文的封装方式。改这个常量意味着要迁移全部旧密文。 */
const KDF = 'aes-256-gcm+worker-secret';

export const providerRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

providerRoutes.get('/', async (c) => c.json({ items: await listProviders(c.env, c.get('principal').address) }));

providerRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  const label = (body.label ?? '').trim();
  // 两个都可选，但默认值必须是"最保守"的那个：协议默认 chat，公开性默认私有。
  const protocol = body.protocol ?? 'openai-chat';
  const visibility = body.visibility ?? 'private';

  if (!label) fail(400, 'label_missing', '缺少 label');
  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 openai-chat / openai-responses`);
  if (!isVisibility(visibility)) fail(400, 'visibility_invalid', `visibility 只能是 public / private`);
  if (!body.base_url || !hostOf(body.base_url)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');
  if (!body.provider_key?.trim()) fail(400, 'provider_key_missing', '缺少 provider_key');

  const now = nowSeconds();
  // 上游提供商不按时间被扫描，只是一个被引用的名字：UUID v4。
  const id = uuidv4();

  // 明文只活在这几行里：封装后立刻丢弃，既不进 D1 也不进日志。
  const providerKey = body.provider_key.trim();
  const sealedKey = await sealProviderKey({
    env: c.env,
    address: c.get('principal').address,
    providerId: id,
    providerKey,
  });

  await c.env.DB.prepare(
    `INSERT INTO providers
       (id, address, label, base_url, key_hint, sealed_key, kdf,
        protocol, visibility, public_listed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      c.get('principal').address,
      label,
      body.base_url.replace(/\/+$/, ''),
      keyHintOf(providerKey),
      sealedKey,
      KDF,
      protocol,
      visibility,
      now,
    )
    .run();

  return c.json({ id }, 201);
});

providerRoutes.post('/:id/visibility', async (c) => {
  const { public_listed } = await c.req.json<{ public_listed?: boolean }>();
  const address = c.get('principal').address;
  const existing = await findProvider(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  await c.env.DB.prepare('UPDATE providers SET public_listed = ? WHERE id = ? AND address = ?')
    .bind(public_listed ? 1 : 0, existing.id, address)
    .run();
  return c.json({ id: existing.id, public_listed: public_listed ? 1 : 0 });
});

providerRoutes.delete('/:id', async (c) => {
  const address = c.get('principal').address;
  const existing = await findProvider(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  await c.env.DB.prepare('UPDATE providers SET revoked_at = ? WHERE id = ? AND address = ?')
    .bind(nowSeconds(), existing.id, address)
    .run();
  return c.json({ id: existing.id, revoked: true });
});
