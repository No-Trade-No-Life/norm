import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { fail } from '../http';
import { nowSeconds, randomToken } from '../ids';
import { checkProvenance, hostOf } from '../provenance';
import { findCredential, listCredentials } from '../store';

type Body = {
  label?: string;
  provider?: string;
  base_url?: string;
  key_hint?: string;
  sealed_key?: string;
  kdf?: string;
  declared_source?: string;
};

const PROVIDERS = new Set(['openai', 'deepseek', 'anthropic', 'google', 'xai', 'moonshot', 'zhipu', 'qwen', 'self-hosted', 'other']);
const SOURCES = new Set(['official-api-key', 'official-subscription', 'self-hosted', 'other']);
const KDFS = new Set(['pbkdf2-sha256-600000+xchacha20poly1305']);

export const credentialRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

credentialRoutes.get('/', async (c) => c.json({ items: await listCredentials(c.env, c.get('principal').address) }));

credentialRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  const provider = body.provider ?? '';
  const declaredSource = body.declared_source ?? '';
  const kdf = body.kdf ?? '';
  if (!PROVIDERS.has(provider)) fail(400, 'provider_invalid', `provider 不合法：${provider}`);
  if (!SOURCES.has(declaredSource)) fail(400, 'source_invalid', `declared_source 不合法：${declaredSource}`);
  if (!KDFS.has(kdf)) fail(400, 'kdf_invalid', 'kdf 必须是 docs/crypto.md 约定的那一串');
  if (!body.base_url || !hostOf(body.base_url)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');
  if (!body.sealed_key) fail(400, 'sealed_key_missing', '缺少密文；明文密钥不允许上传');

  const now = nowSeconds();
  const provenance = checkProvenance({
    provider,
    baseUrl: body.base_url,
    // 创建时服务端拿不到明文密钥，前缀信号只能留空，等第一次调用时补齐。
    upstreamKey: '',
    declaredSource,
    checkedAt: now,
  });

  const id = `cred_${randomToken(12)}`;
  await c.env.DB.prepare(
    `INSERT INTO credentials
       (id, address, label, provider, base_url, key_hint, sealed_key, kdf, declared_source, public_listed, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      id,
      c.get('principal').address,
      (body.label ?? '').trim() || provider,
      provider,
      body.base_url.replace(/\/+$/, ''),
      body.key_hint ?? '••••',
      body.sealed_key,
      kdf,
      declaredSource,
      JSON.stringify(provenance),
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
