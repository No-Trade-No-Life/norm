import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { fail } from '../http';
import { randomToken } from '../ids';
import { mergeDeclaredModels, probeProviderModels, unionModels, type ModelProbe } from '../models';
import { catalogProviders, failNoCandidate, listProviders, resolveProvider } from '../store';
import { affinityKeyOf } from '../routing';
import { type ModelInfo, type Protocol } from '../protocols';

type ModelsContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

/**
 * 模型清单：`GET /v1/models` 与 `GET /v1/models/:model`。
 *
 * 这是转发面的一部分（只认消费者密钥），因为「这个上游有哪些模型」只有拿着
 * 那把上游密钥的人才知道，而密钥在服务端。它也是**唯一**一条打上游却不扣费的路径：
 * 列清单不是一次模型调用，没有生成也没有 token，所以既不写 `requests` 也不动账本，
 * 只在响应里挂一张「全是 0」的账单，让客户端知道这次确实没花钱。
 *
 * 出口只有一种方言：OpenAI 的 `/models`。四种上游的清单形状互不相干，统一在这里
 * 归一成 `{object:"list", data:[{id, object:"model", …}]}`——各家 SDK 里只有它
 * 是通用形状（`/v1/messages` 那种入口天生没有列模型的方法）。
 *
 * 清单回答的是「这个账户现在能调什么」，所以是**逐条问、并成一条答**：账户里启用中
 * 的每条上游各问一次，同名的合成一行（`unionModels`）。抽一条上游回答是不行的——
 * 选址是 rendezvous 的，同一个账户连着问会拿到 15 条、50 条、甚至那条上游的 400，
 * 而下游网关是拿这份清单同步模型行的：抽到哪一条，它就少掉其余几条上游的型号。
 * 账户的**全部**模型在管理面上还有一张表：`/api/v1/models`（见 `model-catalog.ts`），
 * 两个面共用同一段探测（`src/models.ts`）。

 * 「一次一条上游」说的是**问**：密钥只有一条，清单只能一条一条问。但清单要回答的是
 * 「这个上游能调什么」，而有些型号根本问不出来——图像工具方言与音频原生方言的型号表
 * 写在代码里（见 `mergeDeclaredModels`）。它们属于账户里启用的那些协议，所以按账户
 * 启用情况一并报出；否则下游网关永远发现不了图片型号，图像入口也就永远选不中真正的
 * 那条上游。
 */
export const modelRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

/**
 * 一次列清单最多问几条上游：每条一次子请求，Worker 每次执行的子请求数有上限。
 * 越过上限的那几条这一次不问——没问比截成一张看起来完整的表诚实。
 */
const MAX_CATALOG_PROBES = 8;

modelRoutes.get('/', async (c: ModelsContext) => {
  const address = c.get('principal').address;
  const startedAt = Date.now();
  const providers = await catalogProviders(c.env, address);
  if (providers.length === 0) return await failNoCandidate(c.env, address);
  const reported = providers.slice(0, MAX_CATALOG_PROBES);
  // 并发问：几条上游的清单互不相干，串着问只会让 `GET /v1/models` 慢成几条之和。
  const probes = await Promise.all(
    reported.map((provider) => probeProviderModels({ env: c.env, address: provider.address, provider })),
  );

  // 收进数组而不是「记住第一条」：闭包里给 `let` 赋值，读的那一侧看不出赋值发生过。
  const items: ModelInfo[] = [];
  const hosts: string[] = [];
  const unreadable: string[] = [];
  const unreachable: string[] = [];
  const rejected: { status: number; content_type: string; body: string }[] = [];
  probes.forEach((probe, index) => {
    if (probe.ok) {
      items.push(...probe.items);
      hosts.push(hostOf(reported[index].base_url));
      return;
    }
    if (probe.kind === 'local') unreadable.push(probe.message);
    else if (probe.kind === 'unreachable') unreachable.push(probe.message);
    else rejected.push(probe);
  });

  // 一条都没答上来才算这次列不出来：原话原样交回（与单条上游时同一套做法）。
  // 答上来一条就照实答那一条——某条上游的 400 不该让整份清单消失。
  if (items.length === 0) {
    const first = rejected[0];
    if (first !== undefined) {
      return new Response(first.body, {
        status: first.status,
        headers: { 'Content-Type': first.content_type },
      });
    }
    if (unreadable.length > 0) fail(500, 'provider_key_unreadable', unreadable[0]);
    fail(502, 'upstream_unreachable', unreachable[0] ?? '没有一条上游答上了清单');
  }

  return c.json({
    object: 'list',
    data: mergeDeclaredModels(unionModels(items), await enabledProtocols(c.env, address)).map((item) =>
      modelShape(item),
    ),
    norm: zeroReceipt({
      startedAt,
      hosts,
      pool: reported.every((provider) => provider.address !== address),
    }),
  });
});

/** 模型名里可能带斜杠（`meta-llama/Llama-3`），所以这里不能用单段参数。 */
modelRoutes.get('/:model{.+}', async (c: ModelsContext) => {
  const wanted = decodeURIComponent(c.req.param('model') ?? '');
  // 问「这个型号在哪条上游」，就把型号带进选址：没有一条有它时应当直接说没有，
  // 而不是拿一条恰好被挑中的上游的清单来说它不在。
  const resolved = await resolve(c, wanted);
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
  | { ok: true; items: ModelInfo[]; norm: Record<string, unknown> };

/**
 * 认人 → 认上游 → 现解密钥 → 打上游的清单端点。
 *
 * 上游失败时把它的原话原样交回（与转发同一套做法）：改写上游的报错只会让
 * 「为什么列不出来」更难查。
 */
async function resolve(c: ModelsContext, model?: string): Promise<Resolved> {
  const address = c.get('principal').address;
  // 与转发面同一套选址规则，但显式 `readOnly: true` 且不写 `consumers.last_used_at`：
  // 列清单是纯读操作，绝不「读导致写」（不写 affinities、不写 consumers、不计费）。
  const choice = await resolveProvider(c.env, address, affinityKeyOf(c.req.raw.headers), {
    model,
    readOnly: true,
  });
  const provider = choice.provider;

  const startedAt = Date.now();
  // 探测要解封密钥，而密钥的 AAD 绑在持有者身上：池子那条归站点，不归调用方。
  const probe: ModelProbe = await probeProviderModels({ env: c.env, address: provider.address, provider });

  if (!probe.ok) {
    // 本站自己的问题（密钥解不开）没有上游原话可交，只能自己说清楚。
    if (probe.kind === 'local') fail(500, 'provider_key_unreadable', probe.message);
    if (probe.kind === 'unreachable') return { ok: false, upstream: c.json({ error: 'upstream_unreachable', message: probe.message }, 502) };
    return {
      ok: false,
      upstream: new Response(probe.body, {
        status: probe.status,
        headers: { 'Content-Type': probe.content_type },
      }),
    };
  }

  return {
    ok: true,
    items: mergeDeclaredModels(probe.items, await enabledProtocols(c.env, address)),
    norm: zeroReceipt({
      startedAt,
      hosts: [hostOf(provider.base_url)],
      pool: choice.via === 'pool',
    }),
  };
}

/**
 * 一张全是 0 的账单：没有 Gas（没打出去一次生成）、没有 token、也没去读余额。
 *
 * `host` 只在整份清单来自一条上游时给一个名字；并了几条上游的答案时它留空，
 * 由 `hosts` 说清这几行分别来自哪几条——这里编一个「那一条」只会在对账时对不上。
 */
function zeroReceipt({
  startedAt,
  hosts,
  pool,
}: {
  startedAt: number;
  hosts: string[];
  pool: boolean;
}): Record<string, unknown> {
  return {
    request_id: `req_${randomToken(12)}`,
    fee_nanos: 0,
    gas_fee_nanos: 0,
    gas_billed_nanos: 0,
    token_nanos: 0,
    token_billed_nanos: 0,
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    unbilled_nanos: 0,
    balance_nanos: null,
    latency_ms: Date.now() - startedAt,
    host: hosts.length === 1 ? hosts[0] : '',
    hosts,
    pool,
  };
}

/**
 * 账户里启用的那些上游的协议：清单要替它们报出问不出来、只能声明的型号。
 *
 * 纯读：与选址那次读同一张 `providers` 表，不写 `last_used_at`、不动亲和。
 */
async function enabledProtocols(env: Env, address: string): Promise<Protocol[]> {
  const providers = await listProviders(env, address);
  return providers.filter((provider) => provider.enabled === 1).map((provider) => provider.protocol);
}
