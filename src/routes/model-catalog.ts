import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { hostOf } from '../base-urls';
import { nowSeconds } from '../ids';
import { mergeCatalog, probeErrorText, probeProviderModels, type CatalogEntry, type CatalogModelRow } from '../models';
import type { ModelInfo, Protocol, Visibility } from '../protocols';
import { listProviders, type ProviderView } from '../store';

/**
 * 账户的模型总表：`GET /api/v1/models`（签名）。
 *
 * 数据面的 `/v1/models` 一次只回答一条上游，还要一把下游 Token。这张表回答的是
 * 另一个问题：**这个账户现在到底能调哪些模型** —— 把每条启用中的上游的清单并成
 * 一份，同名模型合成一行，并记下它是被哪几条上游提供的。
 *
 * 三个决定：
 *   - 只问启用中的上游：禁用意味着「不参与选址」，一个调不动的名字不该出现在「可用」里。
 *     禁用的那几条仍然出现在 `providers` 里，标着 `probed: false`，不假装问过。
 *   - 一条上游一次问一句，问不到就如实记下它的答复（`ok: false` + `error`），
 *     不因为一条坏掉就整张表 500。
 *   - 一次最多问 `MAX_PROBES` 条：Worker 每条请求的子请求数有上限。问不完的
 *     老实说没问，不截断成一张看起来完整的表。
 *
 * 不扣费：列清单不是一次生成（与数据面同一套理由）。
 */
const MAX_PROBES = 24;

type CatalogProvider = {
  id: string;
  label: string;
  base_url: string;
  host: string;
  protocol: Protocol;
  visibility: Visibility;
  public_listed: number;
  trusted: boolean;
  /** 1 = 启用中。0 的那条不参与探测，也不会出现在任何模型行的 `providers` 里。 */
  enabled: number;
  /** 这次有没有真的去问它。false 时 `ok` 是 null——没问不等于失败。 */
  probed: boolean;
  ok: boolean | null;
  count: number;
  latency_ms: number | null;
  error: string | null;
};

type CatalogContext = Context<{ Bindings: Env; Variables: { principal: Principal } }>;

export const modelCatalogRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

modelCatalogRoutes.get('/', async (c: CatalogContext) => {
  const address = c.get('principal').address;
  // 已撤销的不在里面；禁用的在里面，由我们自己标出来。
  const providers = await listProviders(c.env, address);

  const enabled = providers.filter((provider) => provider.enabled === 1);
  const asked = enabled.slice(0, MAX_PROBES);
  const overflow = enabled.slice(MAX_PROBES);

  const probes = await Promise.all(
    asked.map((provider) => probeProviderModels({ env: c.env, address, provider })),
  );

  // 同一台主机上的两条上游（两个 key）常常是一模一样的清单：按模型名合并，
  // 把「谁有它」记成一列。合并规则只写在 mergeCatalog 里，好单独测。
  const catalogs: CatalogProvider[] = [];
  const merged: CatalogEntry[] = [];

  asked.forEach((provider, index) => {
    const probe = probes[index];
    catalogs.push({
      id: provider.id,
      label: provider.label,
      base_url: provider.base_url,
      host: hostOf(provider.base_url),
      protocol: provider.protocol,
      visibility: provider.visibility,
      public_listed: provider.public_listed,
      trusted: provider.trusted,
      enabled: provider.enabled,
      probed: true,
      ok: probe.ok,
      count: probe.ok ? probe.items.length : 0,
      latency_ms: probe.ok ? probe.latency_ms : null,
      error: probeErrorText(probe),
    });
    if (probe.ok) merged.push({ provider_id: provider.id, protocol: provider.protocol, items: probe.items });
  });

  const items = mergeCatalog(merged);

  // 没问的那几条也要有一行：禁用的、以及这次超出上限的。
  const rest: CatalogProvider[] = [];
  for (const provider of overflow) {
    rest.push(noProbe(provider, `一次最多问 ${MAX_PROBES} 条上游提供商，这条这次没问`));
  }
  for (const provider of providers.filter((entry) => entry.enabled === 0)) {
    rest.push(noProbe(provider, null));
  }

  return c.json({
    fetched_at: nowSeconds(),
    providers: [...catalogs, ...rest],
    models: items,
  });
});

/** 没去问的一行：`ok: null`，并说明为什么没问（禁用是有意的，超限是无意的）。 */
function noProbe(provider: ProviderView, error: string | null): CatalogProvider {
  return {
    id: provider.id,
    label: provider.label,
    base_url: provider.base_url,
    host: hostOf(provider.base_url),
    protocol: provider.protocol,
    visibility: provider.visibility,
    public_listed: provider.public_listed,
    trusted: provider.trusted,
    enabled: provider.enabled,
    probed: false,
    ok: null,
    count: 0,
    latency_ms: null,
    error,
  };
}
