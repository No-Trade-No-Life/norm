/**
 * 问一条上游提供商「你现在有哪些模型」。
 *
 * 两个面问的是同一个问题，只是出口不同：
 *
 *   数据面 `GET /v1/models`        → 照 OpenAI 的清单形状回给客户端（一次一条上游）
 *   管理面 `GET /api/v1/models`    → 把账户里所有上游的答案并成一张表
 *
 * 所以「解封密钥 → 打清单端点 → 归一成 ModelInfo」只写在这一个地方，免得两边
 * 对「什么算一条模型」各有各的说法。
 *
 * 它不扣费：列清单不是一次生成，没有 token，也没有人去改写它。
 */
import type { Env } from './env';
import { ratesFor } from './pricing';
import { adapterFor, type ModelInfo } from './protocols';
import { unsealProviderKey } from './seal';
import type { ProviderRow } from './store';

export type ModelProbe =
  | { ok: true; items: ModelInfo[]; latency_ms: number }
  /**
   * 打不出去：DNS、超时、TLS。这里没有上游原话可以交回，只有我们自己的一句说明。
   * 超时单独成句——「6 秒没动静」与「域名解析不了」是两种完全不同的坏法。
   */
  | { ok: false; kind: 'unreachable'; message: string }
  /** 密钥解不开（master key 轮换过、密文坏了）。这是本站的问题，不是上游的。 */
  | { ok: false; kind: 'local'; message: string }
  /** 上游自己拒了：状态码与响应体原样带回，怎么呈现由调用方决定。 */
  | { ok: false; kind: 'upstream'; status: number; content_type: string; body: string };

/** 清单端点是「顺手问一句」，不该拖住整页：6 秒没有结果就当这条这次没答。 */
export const MODEL_PROBE_TIMEOUT_MS = 6000;

export async function probeProviderModels({
  env,
  address,
  provider,
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
}: {
  env: Env;
  address: string;
  provider: ProviderRow;
  timeoutMs?: number;
}): Promise<ModelProbe> {
  let upstreamKey: string;
  try {
    upstreamKey = await unsealProviderKey({
      env,
      address,
      providerId: provider.id,
      sealed: provider.sealed_key,
    });
  } catch (error) {
    return { ok: false, kind: 'local', message: `上游密钥解不开：${(error as Error).message}` };
  }

  const adapter = adapterFor(provider.protocol);
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${adapter.modelsPath()}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...adapter.headers(upstreamKey) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError';
    return {
      ok: false,
      kind: 'unreachable',
      message: timedOut
        ? `上游在那 ${Math.round(timeoutMs / 1000)} 秒里没有回清单`
        : `上游不可达：${(error as Error).message}`,
    };
  }

  if (!upstream.ok) {
    return {
      ok: false,
      kind: 'upstream',
      status: upstream.status,
      content_type: upstream.headers.get('Content-Type') ?? 'application/json',
      body: await upstream.text(),
    };
  }

  // 清单没人读、也没人改写：形状不认识就当空清单，不猜。
  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    parsed = {};
  }

  return { ok: true, items: adapter.readModels(parsed), latency_ms: Date.now() - startedAt };
}

/** 上游失败时压成一句话：状态码 + 上游原话的前一小段（换行压平，宁短勿长）。 */
export function probeErrorText(probe: ModelProbe): string | null {
  if (probe.ok) return null;
  if (probe.kind !== 'upstream') return probe.message;
  const snippet = probe.body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return snippet ? `上游回 ${probe.status}：${snippet}` : `上游回 ${probe.status}`;
}

/** 一条上游这次回了什么（拿不到就空着，由调用方决定怎么记）。 */
export type CatalogEntry = { provider_id: string; items: ModelInfo[] };

/**
 * 一条模型行：名字、谁有它、以及官方按量付费价这个锚点。
 *
 * `official` 来自 `pricing.ts` 里与记账同源的那张价目表（纳美元 / 1M token）。
 * 以后做定价撮合，一个上游的报价就是「这张表的 x 倍」，不必再维护第二份价格。
 * 型号没被收录时它是 null —— 不猜。
 */
export type CatalogModelRow = ModelInfo & {
  providers: string[];
  official: { match: string; input: number; cached: number; output: number } | null;
};

/**
 * 把几条上游的清单并成一张表：一行一个模型名，顺序按名字。
 *
 * 合并规则只有两条：
 *   1. 同名就是同一条模型（Norm 转发时模型名原样透传，叫同一个名字就能打到同一处）；
 *   2. `created` / `owned_by` 谁先给就留谁给的，后来的能补空，不能覆盖。
 *
 * 同一家把同一个模型列两遍（见过）不会让它在 `providers` 里出现两次。
 */
export function mergeCatalog(entries: CatalogEntry[]): CatalogModelRow[] {
  const byId = new Map<string, CatalogModelRow>();

  for (const entry of entries) {
    for (const item of entry.items) {
      const existing = byId.get(item.id);
      if (!existing) {
        const anchor = ratesFor(item.id);
        byId.set(item.id, {
          id: item.id,
          providers: [entry.provider_id],
          official: anchor.match === null ? null : { match: anchor.match, ...anchor.rates },
          ...(item.created === undefined ? {} : { created: item.created }),
          ...(item.owned_by === undefined ? {} : { owned_by: item.owned_by }),
        });
        continue;
      }
      existing.providers.push(entry.provider_id);
      if (existing.created === undefined && item.created !== undefined) existing.created = item.created;
      if (existing.owned_by === undefined && item.owned_by !== undefined) existing.owned_by = item.owned_by;
    }
  }

  return [...byId.values()]
    .map((row) => ({ ...row, providers: [...new Set(row.providers)] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
