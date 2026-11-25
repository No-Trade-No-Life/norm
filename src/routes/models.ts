import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { fail } from '../http';
import { randomToken } from '../ids';
import { unsealProviderKey } from '../seal';
import { findProvider, resolveProviderId } from '../store';
import { adapterFor, type ModelInfo } from '../protocols';

type ModelsContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * 模型清单：`GET /v1/models` 与 `GET /v1/models/:model`。
 *
 * 这是转发面的一部分（签名或消费者密钥都认），因为「这个上游有哪些模型」只有拿着
 * 那把上游密钥的人才知道，而密钥在服务端。它也是**唯一**一条打上游却不扣费的路径：
 * 列清单不是一次模型调用，没有生成也没有 token，所以既不写 `requests` 也不动账本，
 * 只在响应里挂一张「全是 0」的账单，让客户端知道这次确实没花钱。
 *
 * 出口只有一种方言：OpenAI 的 `/models`。四种上游的清单形状互不相干，统一在这里
 * 归一成 `{object:"list", data:[{id, object:"model", …}]}`——各家 SDK 里只有它
 * 是通用形状（`/v1/messages` 那种入口天生没有列模型的方法）。
 */
export const modelRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

modelRoutes.get('/', async (c: ModelsContext) => {
  const resolved = await resolve(c);
  if (!resolved.ok) return resolved.upstream;
  return c.json({
    object: 'list',
    data: resolved.items.map((item) => modelShape(item)),
    norm: resolved.norm,
  });
});

/** 模型名里可能带斜杠（`meta-llama/Llama-3`），所以这里不能用单段参数。 */
modelRoutes.get('/:model{.+}', async (c: ModelsContext) => {
  const wanted = decodeURIComponent(c.req.param('model') ?? '');
  const resolved = await resolve(c);
  if (!resolved.ok) return resolved.upstream;

  const found = resolved.items.find((item) => item.id === wanted);
  if (!found) fail(404, 'model_not_found', `这个上游的清单里没有 ${wanted}；GET /v1/models 看全部`);

  return c.json({ ...modelShape(found), norm: resolved.norm });
});

/** 一个模型在出口方言里的形状。`created` / `owned_by` 不是每家都给，缺了就不编。 */
function modelShape(item: ModelInfo): Record<string, unknown> {
  return {
    id: item.id,
    object: 'model',
    ...(item.created === undefined ? {} : { created: item.created }),
    ...(item.owned_by === undefined ? {} : { owned_by: item.owned_by }),
  };
}

type Resolved =
  | { ok: false; upstream: Response }
  | { ok: true; upstream: Response; items: ModelInfo[]; norm: Record<string, unknown> };

/**
 * 认人 → 认上游 → 现解密钥 → 打上游的清单端点。
 *
 * 上游失败时把它的原话原样交回（与转发同一套做法）：改写上游的报错只会让
 * 「为什么列不出来」更难查。唯一的例外是网络不可达，那没有上游原话可交。
 */
async function resolve(c: ModelsContext): Promise<Resolved> {
  const address = c.get('principal').address;
  const providerId = await resolveProviderId(c.env, address, c.req.header('X-Norm-Provider') ?? null);

  const provider = await findProvider(c.env, address, providerId);
  if (!provider) fail(404, 'provider_not_found', 'Provider 不存在或已撤销');
  if (provider.enabled === 0) fail(409, 'provider_disabled', '上游提供商已禁用：到「上游提供商」页启用它，或改用另一条');

  const upstreamKey = await unsealProviderKey({
    env: c.env,
    address,
    providerId: provider.id,
    sealed: provider.sealed_key,
  });

  const adapter = adapterFor(provider.protocol);
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const host = hostOf(baseUrl);
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${adapter.modelsPath()}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...adapter.headers(upstreamKey) },
    });
  } catch (error) {
    return {
      ok: false,
      upstream: c.json({ error: 'upstream_unreachable', message: `上游不可达：${(error as Error).message}` }, 502),
    };
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return {
      ok: false,
      upstream: new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      }),
    };
  }

  // 清单不是生成，没人读它、也没人改写它：形状不认识就当空清单，不猜。
  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    parsed = {};
  }

  return {
    ok: true,
    upstream,
    items: adapter.readModels(parsed),
    // 全是 0 的账单：没有 Gas（没打出去一次生成）、没有 token、也没去读余额。
    norm: {
      request_id: `req_${randomToken(12)}`,
      fee_nanos: 0,
      gas_fee_nanos: 0,
      token_nanos: 0,
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      unbilled_nanos: 0,
      balance_nanos: null,
      latency_ms: Date.now() - startedAt,
      host,
    },
  };
}
