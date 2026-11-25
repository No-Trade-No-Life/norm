import { Hono } from 'hono';
import { canOwnPool, type Env } from '../env';
import type { Identity } from '../auth';
import { fail } from '../http';
import { nowSeconds, uuidv4 } from '../ids';
import { PROTOCOLS, adapterFor, isProtocol } from '../protocols';
import { hostOf } from '../base-urls';
import { syncProviderModels } from '../models';
import { keyHintOf, sealProviderKey } from '../seal';
import { findProvider, listProviders } from '../store';

type Body = {
  label?: string;
  /** 基址：协议钉死时（`deepseek`）可以不填；通用协议必填。 */
  base_url?: string;
  /** 上游提供商明文密钥：只在这一次请求体里出现，服务端立刻封装，之后再也不见明文。 */
  provider_key?: string;
  protocol?: string;
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

providerRoutes.get('/', async (c) => {
  const address = c.get('principal').address;
  return c.json({
    items: await listProviders(c.env, address),
    // 「公开」只有一个开关（进公共池），但能拨它的只有站点地址：前端据此把开关置灰，
    // 而不是让人点完才收一个 403。
    can_own_pool: canOwnPool(c.env, address),
  });
});

providerRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  const label = (body.label ?? '').trim();
  // 协议可省，默认最通用的 chat；scope 不写就绝不会进池子。
  const protocol = body.protocol ?? 'openai-chat';
  // 不写就绝不会进池子：池子里的密钥是站点的，进不进是一个显式动作。
  const scope = body.scope ?? 'private';
  const enabled = body.enabled ?? true;

  if (!label) fail(400, 'label_missing', '缺少 label');
  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 ${PROTOCOLS.join(' / ')}`);
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
        protocol, scope, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      scope,
      enabled ? 1 : 0,
      now,
    )
    .run();

  // 清单在后台抓：新建一条上游不该为了「顺便问一句它有哪些模型」多等一个上游的响应，
  // 但选址要按模型筛，这张表就得有。抓不到也没关系——没有清单的上游仍然可被选中。
  background(
    c,
    syncProviderModels({
      env: c.env,
      address: c.get('principal').address,
      provider: { id, base_url: baseUrl, protocol, sealed_key: sealedKey },
    }).then(() => undefined),
  );

  return c.json({ id, scope }, 201);
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

/**
 * 编辑一条上游：只有本人名下的那条能动。密钥是**可换不可看**的——请求里给新值就重新
 * 封装并更新提示，留空就保持原密文；明文既不进日志、也不进响应。
 *
 * 基址仍由协议决定：固定基址的协议不接受另一个地址；从固定基址的协议换到通用协议时
 * 必须给一个新地址，否则会把官方地址悄悄当成用户自己的上游。
 */
providerRoutes.patch('/:id', async (c) => {
  const address = c.get('principal').address;
  const existing = await findProvider(c.env, address, c.req.param('id'));
  if (!existing) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');

  const body = await c.req.json<Body>();
  const label = body.label === undefined ? existing.label : body.label.trim();
  const protocol = body.protocol ?? existing.protocol;
  const enabled = body.enabled === undefined ? existing.enabled === 1 : body.enabled;

  if (!label) fail(400, 'label_missing', '缺少 label');
  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 ${PROTOCOLS.join(' / ')}`);
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');

  const fixedBaseUrl = adapterFor(protocol).base_url;
  const givenBaseUrl = (body.base_url ?? '').trim().replace(/\/+$/, '');
  let baseUrl: string;
  if (fixedBaseUrl !== undefined) {
    if (givenBaseUrl && givenBaseUrl !== fixedBaseUrl) {
      fail(400, 'base_url_fixed', `${protocol} 协议的基址固定为 ${fixedBaseUrl}，不要另填 base_url`);
    }
    baseUrl = fixedBaseUrl;
  } else if (givenBaseUrl) {
    baseUrl = givenBaseUrl;
  } else if (protocol === existing.protocol || adapterFor(existing.protocol).base_url === undefined) {
    // 通用方言之间换协议，地址还是用户自己那一个，沿用；只有从厂商给定的地址
    // 换回通用方言时，才必须重新填一次。
    baseUrl = existing.base_url;
  } else {
    fail(400, 'base_url_invalid', '切换到这个协议要填 base_url');
  }
  if (!hostOf(baseUrl)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');

  const nextKey = body.provider_key?.trim() ?? '';
  const sealedKey = nextKey
    ? await sealProviderKey({ env: c.env, address, providerId: existing.id, providerKey: nextKey })
    : existing.sealed_key;
  const keyHint = nextKey ? keyHintOf(nextKey) : existing.key_hint;

  await c.env.DB.prepare(
    `UPDATE providers
        SET label = ?, base_url = ?, protocol = ?, enabled = ?,
            sealed_key = ?, key_hint = ?, kdf = ?
      WHERE id = ? AND address = ?`,
  )
    .bind(label, baseUrl, protocol, enabled ? 1 : 0, sealedKey, keyHint, KDF, existing.id, address)
    .run();

  // 换了协议、地址或密钥，这一条能跑的型号可能全变了：重新抓一次清单。
  background(
    c,
    syncProviderModels({
      env: c.env,
      address,
      provider: { id: existing.id, base_url: baseUrl, protocol, sealed_key: sealedKey },
    }).then(() => undefined),
  );

  return c.json({ id: existing.id });
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

/**
 * 挂在响应之后跑的一件事：`waitUntil` 让它在响应发出去之后继续，调用方不用等它。
 *
 * 拿不到 executionCtx 的环境（单测、`vite` 预览）就当没跑——这类同步是尽力而为，
 * 它失败不该改变请求的结果：没有清单的上游仍然参与选址，只是筛不了模型。
 */
function background(
  c: { readonly executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  task: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(task.catch(() => undefined));
  } catch {
    // 没有 executionCtx：这次不同步，等「模型」页读一次总表时再补。
  }
}
