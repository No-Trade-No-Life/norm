import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { isProtocol, isVisibility } from '../upstreams';
import { hostOf } from '../base-urls';
import { keyHintOf, sealUpstreamKey } from '../seal';
import { findCredential, listCredentials } from '../store';

type Body = {
  label?: string;
  provider?: string;
  base_url?: string;
  /** 上游明文密钥：只在这一次请求体里出现，服务端立刻封装，之后再也不见明文。 */
  upstream_key?: string;
  upstream_protocol?: string;
  upstream_visibility?: string;
};

/** provider 只是个展示标签，不参与任何判断。 */
const PROVIDERS = new Set([
  'openai',
  'deepseek',
  'anthropic',
  'google',
  'xai',
  'moonshot',
  'zhipu',
  'qwen',
  'self-hosted',
  'other',
]);
/** 库里密文的封装方式。改这个常量意味着要迁移全部旧密文。 */
const KDF = 'aes-256-gcm+worker-secret';

export const credentialRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

credentialRoutes.get('/', async (c) => c.json({ items: await listCredentials(c.env, c.get('principal').address) }));

credentialRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  const provider = body.provider ?? '';
  // 两个都可选，但默认值必须是"最保守"的那个：协议默认 chat，公开性默认私有。
  const protocol = body.upstream_protocol ?? 'openai-chat';
  const visibility = body.upstream_visibility ?? 'private';

  if (!PROVIDERS.has(provider)) fail(400, 'provider_invalid', `provider 不合法：${provider}`);
  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `upstream_protocol 只能是 openai-chat / openai-responses`);
  if (!isVisibility(visibility)) fail(400, 'visibility_invalid', `upstream_visibility 只能是 public / private`);
  if (!body.base_url || !hostOf(body.base_url)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');
  if (!body.upstream_key?.trim()) fail(400, 'upstream_key_missing', '缺少 upstream_key');

  const now = nowSeconds();
  const id = `cred_${randomToken(12)}`;

  // 明文只活在这几行里：封装后立刻丢弃，既不进 D1 也不进日志。
  const upstreamKey = body.upstream_key.trim();
  const sealedKey = await sealUpstreamKey({
    env: c.env,
    address: c.get('principal').address,
    credentialId: id,
    upstreamKey,
  });

  await c.env.DB.prepare(
    `INSERT INTO credentials
       (id, address, label, provider, base_url, key_hint, sealed_key, kdf,
        upstream_protocol, upstream_visibility, public_listed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      c.get('principal').address,
      (body.label ?? '').trim() || provider,
      provider,
      body.base_url.replace(/\/+$/, ''),
      keyHintOf(upstreamKey),
      sealedKey,
      KDF,
      protocol,
      visibility,
      now,
    )
    .run();

  return c.json({ id }, 201);
});

credentialRoutes.post('/:id/visibility', async (c) => {
  const { public_listed } = await c.req.json<{ public_listed?: boolean }>();
  const address = c.get('principal').address;
  const existing = await findCredential(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'credential_not_found', '凭证不存在或已撤销');
  await c.env.DB.prepare('UPDATE credentials SET public_listed = ? WHERE id = ? AND address = ?')
    .bind(public_listed ? 1 : 0, existing.id, address)
    .run();
  return c.json({ id: existing.id, public_listed: public_listed ? 1 : 0 });
});

credentialRoutes.delete('/:id', async (c) => {
  const address = c.get('principal').address;
  const existing = await findCredential(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'credential_not_found', '凭证不存在或已撤销');
  await c.env.DB.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ? AND address = ?')
    .bind(nowSeconds(), existing.id, address)
    .run();
  return c.json({ id: existing.id, revoked: true });
});
