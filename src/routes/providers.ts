import { Hono } from 'hono';
import { canOwnPool, type Env } from '../env';
import type { Identity } from '../auth';
import { fail } from '../http';
import { nowSeconds, uuidv4 } from '../ids';
import { PROTOCOLS, adapterFor, isProtocol, isVisibility } from '../protocols';
import { hostOf } from '../base-urls';
import { keyHintOf, sealProviderKey } from '../seal';
import { findProvider, listProviders } from '../store';

type Body = {
  label?: string;
  /** 基址：协议钉死时（`deepseek`）可以不填；通用协议必填。 */
  base_url?: string;
  /** 上游提供商明文密钥：只在这一次请求体里出现，服务端立刻封装，之后再也不见明文。 */
  provider_key?: string;
  protocol?: string;
  visibility?: string;
  /**
   * private / pool，默认 private。pool 的那条是**公共池**：所有账户在自己的上游
   * 不可用时都能兜底用到它。只有站点地址（POOL_ADMIN_ADDRESSES）能写这个值。
   */
  scope?: string;
  /** 可选，默认启用。禁用后不参与选址。 */
  enabled?: boolean;
};

/** 库里密文的封装方式。改这个常量意味着要迁移全部旧密文。 */
const KDF = 'aes-256-gcm+worker-secret';

export const providerRoutes = new Hono<{ Bindings: Env; Variables: { principal: Identity } }>();

providerRoutes.get('/', async (c) => c.json({ items: await listProviders(c.env, c.get('principal').address) }));

providerRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  const label = (body.label ?? '').trim();
  // 两个都可选，但默认值必须是"最保守"的那个：协议默认 chat，公开性默认私有。
  const protocol = body.protocol ?? 'openai-chat';
  const visibility = body.visibility ?? 'private';
  // 不写就绝不会进池子：池子里的密钥是站点的，进不进是一个显式动作。
  const scope = body.scope ?? 'private';
  const enabled = body.enabled ?? true;

  if (!label) fail(400, 'label_missing', '缺少 label');
  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 ${PROTOCOLS.join(' / ')}`);
  if (!isVisibility(visibility)) fail(400, 'visibility_invalid', `visibility 只能是 public / private`);
  if (scope !== 'private' && scope !== 'pool') fail(400, 'scope_invalid', 'scope 只能是 private / pool');
  if (scope === 'pool' && !canOwnPool(c.env, c.get('principal').address)) {
    fail(403, 'pool_forbidden', '只有站点地址可以把上游放进公共池');
  }
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');

  // 基址从哪来由协议决定：厂商协议（`deepseek`）的地址是协议自带的，用户不填；通用的
  // 四条方言才要用户填自己的上游。填了固定协议的地址且对不上，说明调用方以为它能选。
  const adapter = adapterFor(protocol);
  const fixedBaseUrl = adapter.base_url;
  const givenBaseUrl = (body.base_url ?? '').trim().replace(/\/+$/, '');
  if (fixedBaseUrl !== undefined && givenBaseUrl && givenBaseUrl !== fixedBaseUrl) {
    fail(400, 'base_url_fixed', `${protocol} 协议的基址固定为 ${fixedBaseUrl}，不要另填 base_url`);
  }
  const baseUrl = fixedBaseUrl ?? givenBaseUrl;
  if (!baseUrl || !hostOf(baseUrl)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');
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
        protocol, visibility, scope, enabled, public_listed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      c.get('principal').address,
      label,
      baseUrl,
      keyHintOf(providerKey),
      sealedKey,
      KDF,
      protocol,
      visibility,
      scope,
      enabled ? 1 : 0,
      now,
    )
    .run();

  return c.json({ id, scope }, 201);
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

/**
 * 把一条已在名下的上游放进 / 拿回公共池。只有站点地址能动这个开关：
 * 池子里的密钥是站点付钱，别人往里塞一条等于替站点决定「拿什么服务全站」。
 */
providerRoutes.post('/:id/scope', async (c) => {
  const { scope } = await c.req.json<{ scope?: string }>();
  if (scope !== 'private' && scope !== 'pool') fail(400, 'scope_invalid', 'scope 只能是 private / pool');
  const address = c.get('principal').address;
  if (scope === 'pool' && !canOwnPool(c.env, address)) fail(403, 'pool_forbidden', '只有站点地址可以把上游放进公共池');
  const existing = await findProvider(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  await c.env.DB.prepare('UPDATE providers SET scope = ? WHERE id = ? AND address = ?')
    .bind(scope, existing.id, address)
    .run();
  return c.json({ id: existing.id, scope });
});

providerRoutes.post('/:id/enabled', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: boolean }>();
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');
  const address = c.get('principal').address;
  const existing = await findProvider(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'provider_not_found', 'provider 不存在或已撤销');
  await c.env.DB.prepare('UPDATE providers SET enabled = ? WHERE id = ? AND address = ?')
    .bind(enabled ? 1 : 0, existing.id, address)
    .run();
  return c.json({ id: existing.id, enabled: enabled ? 1 : 0 });
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
