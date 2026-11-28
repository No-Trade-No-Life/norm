import { Hono } from 'hono';
import { canOwnPool, type Env } from '../env';
import type { Identity } from '../auth';
import { fail } from '../http';
import { nowSeconds, uuidv4 } from '../ids';
import { logError } from '../log';
import { PROTOCOLS, isProtocol, protocolFor } from '../protocols';
import { hostOf } from '../base-urls';
import { syncProviderModels } from '../models';
import { keyHintOf, sealProviderKey } from '../seal';
import { parseProxyUrl, proxyHintOf } from '../proxy';
import { findProvider, listProviders } from '../store';
import {
  openaiAccountHint,
  openaiAuthorize,
  openaiCredentialOf,
  openaiCredentialText,
  openaiExchange,
  type CredentialParse,
} from '../oauth';

type Body = {
  /**
   * 人看的名字。**可选、可空**：没有标签不该拦住一条能跑的上游，`null` / 空串 / 不填
   * 都是「没有标签」，库里存 NULL，页面上退回主机名。
   */
  label?: string | null;
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
  /**
   * 这条上游专用的 HTTP 代理：`http://host:port`，可带 `user:pass`。
   * 不填 = 直连；更新时空串 = 拆掉原来那条。
   */
  proxy_url?: string | null;
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

/**
 * 开始一次 OpenAI OAuth：现生成 PKCE（S256）与 state，把授权地址交给浏览器。
 *
 * Norm 不存这次流程的任何状态。verifier 随响应回到浏览器，回调回来时再一起送回来——
 * 换币要的正是它，而它只存在于发起授权的这只浏览器里。没有服务端那张流程表，就没有
 * 过期清理，也没有多实例一致性问题。
 *
 * 回调地址是 `http://localhost:1455/auth/callback`：那台机器上不会有服务在听，浏览器会停在
 * 「连不上」，而地址栏里已经有 code 与 state。把那一行贴回来就是这一步的人机接口。
 */
providerRoutes.post('/oauth/start', async (c) => c.json(await openaiAuthorize()));

/**
 * 用回调 URL 里的 code 换一对令牌，回给浏览器当 provider_key。
 *
 * 令牌走的还是 BYOK 那条老路：经过浏览器、由浏览器在创建上游时交回来一次，服务端立刻封装。
 * 所以这里不回别的、也不落库——它只是一次「把 code 换成令牌」的翻译。
 */
providerRoutes.post('/oauth/exchange', async (c) => {
  const body = await c.req.json<{ code?: string; verifier?: string }>();
  const code = (body.code ?? '').trim();
  const verifier = (body.verifier ?? '').trim();
  if (!code || !verifier) fail(400, 'oauth_parameters_missing', '需要授权码 code 与本次授权的 verifier');

  let credential;
  try {
    credential = await openaiExchange({ code, verifier });
  } catch (error) {
    // 换币失败是上游的答案（code 过期、verifier 对不上），原话交回去才好查。
    fail(502, 'oauth_exchange_failed', (error as Error).message);
  }
  return c.json({ provider_key: openaiCredentialText(credential), account_id: credential.account_id });
});

providerRoutes.post('/', async (c) => {
  const body = await c.req.json<Body>();
  // 标签不填就不填：它只影响回头认人，不影响这条上游能不能用。
  const label = labelOf(body.label);
  // 协议可省，默认最通用的 chat；scope 不写就绝不会进池子。
  const protocol = body.protocol ?? 'openai-chat';
  // 不写就绝不会进池子：池子里的密钥是站点的，进不进是一个显式动作。
  const scope = body.scope ?? 'private';
  const enabled = body.enabled ?? true;

  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 ${PROTOCOLS.join(' / ')}`);
  if (scope !== 'private' && scope !== 'pool') fail(400, 'scope_invalid', 'scope 只能是 private / pool');
  if (scope === 'pool' && !canOwnPool(c.env, c.get('principal').address)) {
    fail(403, 'pool_forbidden', '只有站点地址可以把上游放进公共池');
  }
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');

  // 基址从哪来由协议决定：厂商协议（`deepseek` / `opencode-go`）的地址是协议自带的，用户不填；通用的
  // 四条方言才要用户填自己的上游。填了固定协议的地址且对不上，说明调用方以为它能选。
  const profile = protocolFor(protocol);
  const fixedBaseUrl = profile.base_url;
  const givenBaseUrl = (body.base_url ?? '').trim().replace(/\/+$/, '');
  if (fixedBaseUrl !== undefined && givenBaseUrl && givenBaseUrl !== fixedBaseUrl) {
    fail(400, 'base_url_fixed', `${protocol} 协议的基址固定为 ${fixedBaseUrl}，不要另填 base_url`);
  }
  const baseUrl = fixedBaseUrl ?? givenBaseUrl;
  if (!baseUrl || !hostOf(baseUrl)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');
  if (!body.provider_key?.trim()) fail(400, 'provider_key_missing', '缺少 provider_key');

  const now = nowSeconds();
  const address = c.get('principal').address;
  // 上游提供商不按时间被扫描，只是一个被引用的名字：UUID v4。
  const id = uuidv4();

  // 明文只活在这几行里：封装后立刻丢弃，既不进 D1 也不进日志。
  const providerKey = body.provider_key.trim();
  const oauth = credentialFor(profile.oauth === true, providerKey);
  const sealedKey = await sealProviderKey({ env: c.env, address, providerId: id, providerKey });
  // 代理地址和密钥一样进门就封装：里面通常带着 user:pass，明文不该在库里过夜。
  const proxyUrl = (body.proxy_url ?? '').trim();
  if (proxyUrl !== '' && parseProxyUrl(proxyUrl) === null) {
    fail(400, 'proxy_url_invalid', 'proxy_url 只能是 http:// 或 https:// 的 host:port，可带 user:pass');
  }
  const sealedProxy =
    proxyUrl === '' ? '' : await sealProviderKey({ env: c.env, address, providerId: id, providerKey: proxyUrl });

  await c.env.DB.prepare(
    `INSERT INTO providers
       (id, address, label, base_url, key_hint, sealed_key, kdf,
        protocol, scope, enabled, created_at, sealed_proxy, proxy_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      address,
      label,
      baseUrl,
      hintOf(providerKey, oauth),
      sealedKey,
      KDF,
      protocol,
      scope,
      enabled ? 1 : 0,
      now,
      sealedProxy,
      proxyHintOf(proxyUrl),
    )
    .run();

  // 清单在后台抓：新建一条上游不该为了「顺便问一句它有哪些模型」多等一个上游的响应，
  // 但选址要按模型筛，这张表就得有。抓不到也没关系——没有清单的上游仍然可被选中。
  background(
    c,
    syncProviderModels({ env: c.env, address, provider: { id, base_url: baseUrl, protocol, sealed_key: sealedKey, sealed_proxy: sealedProxy } }).then(
      () => undefined,
    ),
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
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare(
    'UPDATE providers SET scope = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(scope, id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  return c.json({ id, scope });
});

providerRoutes.post('/:id/enabled', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: boolean }>();
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');
  const address = c.get('principal').address;
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare(
    'UPDATE providers SET enabled = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(enabled ? 1 : 0, id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  return c.json({ id, enabled: enabled ? 1 : 0 });
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
  // 标签三种写法，与 proxy_url 同一种三态：字段不出现 = 保持原值；null / 空串 = 清掉；
  // 有值 = 换一个。名字不是必填项，所以「清掉」也必须能表达。
  const label = body.label === undefined ? existing.label : labelOf(body.label);
  const protocol = body.protocol ?? existing.protocol;
  const enabled = body.enabled === undefined ? existing.enabled === 1 : body.enabled;

  if (!isProtocol(protocol)) fail(400, 'protocol_invalid', `protocol 只能是 ${PROTOCOLS.join(' / ')}`);
  if (typeof enabled !== 'boolean') fail(400, 'enabled_invalid', 'enabled 必须是布尔值');

  const fixedBaseUrl = protocolFor(protocol).base_url;
  const givenBaseUrl = (body.base_url ?? '').trim().replace(/\/+$/, '');
  let baseUrl: string;
  if (fixedBaseUrl !== undefined) {
    if (givenBaseUrl && givenBaseUrl !== fixedBaseUrl) {
      fail(400, 'base_url_fixed', `${protocol} 协议的基址固定为 ${fixedBaseUrl}，不要另填 base_url`);
    }
    baseUrl = fixedBaseUrl;
  } else if (givenBaseUrl) {
    baseUrl = givenBaseUrl;
  } else if (protocol === existing.protocol || protocolFor(existing.protocol).base_url === undefined) {
    // 通用方言之间换协议，地址还是用户自己那一个，沿用；只有从厂商给定的地址
    // 换回通用方言时，才必须重新填一次。
    baseUrl = existing.base_url;
  } else {
    fail(400, 'base_url_invalid', '切换到这个协议要填 base_url');
  }
  if (!hostOf(baseUrl)) fail(400, 'base_url_invalid', 'base_url 必须是绝对 URL');

  const nextKey = body.provider_key?.trim() ?? '';
  const oauth = credentialFor(nextKey !== '' && protocolFor(protocol).oauth === true, nextKey);
  const sealedKey = nextKey
    ? await sealProviderKey({ env: c.env, address, providerId: existing.id, providerKey: nextKey })
    : existing.sealed_key;
  const keyHint = nextKey ? hintOf(nextKey, oauth) : existing.key_hint;

  // 代理有三种意思：字段没提 = 不动；空串 = 拆掉；有值 = 换一条。
  const givenProxy = body.proxy_url === undefined ? undefined : (body.proxy_url ?? '').trim();
  if (givenProxy !== undefined && givenProxy !== '' && parseProxyUrl(givenProxy) === null) {
    fail(400, 'proxy_url_invalid', 'proxy_url 只能是 http:// 或 https:// 的 host:port，可带 user:pass');
  }
  const sealedProxy =
    givenProxy === undefined
      ? existing.sealed_proxy
      : givenProxy === ''
        ? ''
        : await sealProviderKey({ env: c.env, address, providerId: existing.id, providerKey: givenProxy });
  const proxyHint = givenProxy === undefined ? existing.proxy_hint : proxyHintOf(givenProxy);

  const updated = await c.env.DB.prepare(
    `UPDATE providers
        SET label = ?, base_url = ?, protocol = ?, enabled = ?, sealed_key = ?, key_hint = ?, kdf = ?, sealed_proxy = ?, proxy_hint = ?
      WHERE id = ? AND address = ? AND revoked_at IS NULL`,
  )
    .bind(label, baseUrl, protocol, enabled ? 1 : 0, sealedKey, keyHint, KDF, sealedProxy, proxyHint, existing.id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');

  // 换了协议、地址或密钥，这一条能跑的型号可能全变了：重新抓一次清单。
  background(
    c,
    syncProviderModels({ env: c.env, address, provider: { id: existing.id, base_url: baseUrl, protocol, sealed_key: sealedKey, sealed_proxy: sealedProxy } }).then(
      () => undefined,
    ),
  );

  return c.json({ id: existing.id });
});

providerRoutes.delete('/:id', async (c) => {
  const address = c.get('principal').address;
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare(
    'UPDATE providers SET revoked_at = ? WHERE id = ? AND address = ? AND revoked_at IS NULL',
  )
    .bind(nowSeconds(), id, address)
    .run();
  if (updated.meta.changes === 0) fail(404, 'provider_not_found', '上游提供商不存在或已撤销');
  return c.json({ id, revoked: true });
});

/**
 * 标签归一：没填、空串、全空白 → `null`。库里只有一个「没有标签」的值，
 * 免得 `''` 与 `NULL` 两种空法各自被页面读成不同意思。
 */
function labelOf(input: string | null | undefined): string | null {
  const text = (input ?? '').trim();
  return text === '' ? null : text;
}

/**
 * OAuth 协议的凭据在写入口解析一次：贴错的 JSON、缺 refresh_token、不是 OpenAI 的令牌，
 * 都在这里变成一句 400，而不是等到第一次调用才以上游 401 出现。别的协议原样放行。
 */
function credentialFor(oauth: boolean, providerKey: string): Extract<CredentialParse, { ok: true }> | null {
  if (!oauth) return null;
  const parsed = openaiCredentialOf(providerKey);
  if (!parsed.ok) fail(400, 'provider_key_invalid', parsed.message);
  return parsed;
}

/** 展示用提示：OAuth 凭据没有「前后四位」可言，能核对的是工作区 id。 */
function hintOf(providerKey: string, oauth: Extract<CredentialParse, { ok: true }> | null): string {
  return oauth === null ? keyHintOf(providerKey) : openaiAccountHint(oauth.credential.account_id);
}

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
    c.executionCtx.waitUntil(
      task.catch((error) => {
        logError('background_task_error', error);
      }),
    );
  } catch {
    // 没有 executionCtx：这次不同步，等「模型」页读一次总表时再补。
  }
}
