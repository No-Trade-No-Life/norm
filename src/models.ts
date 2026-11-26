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
import { audioCodecFor } from './audio';
import { dialectCodecFor, type ModelInfo } from './codecs';
import type { Env } from './env';
import { nowSeconds } from './ids';
import { ratesFor, type Rates } from './pricing';
import { protocolFor, tariffFor, type Protocol } from './protocols';
import { providerCredential } from './credentials';
import { sendUpstream } from './tunnel';
import { recordProviderModels } from './store';

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

/**
 * 打一次清单端点所需要的那几列。
 *
 * 收成结构类型而不是整行 `ProviderRow`：新建一条上游时行才刚写进去，手里只有这几列，
 * 重新查一遍库只为凑齐类型没有意义。
 */
export type ProbeTarget = {
  id: string;
  base_url: string;
  protocol: Protocol;
  sealed_key: string;
  /** 代理密文。清单请求和转发请求得走同一条路，否则配了代理的上游永远抓不到型号。 */
  sealed_proxy: string;
};

export async function probeProviderModels({
  env,
  address,
  provider,
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
}: {
  env: Env;
  address: string;
  provider: ProbeTarget;
  timeoutMs?: number;
}): Promise<ModelProbe> {
  let upstreamKey: string;
  try {
    // 解封 +（OAuth 协议的）换新都在这里：清单端点与转发面用的是同一把新鲜凭据。
    upstreamKey = await providerCredential({ env, address, provider });
  } catch (error) {
    return { ok: false, kind: 'local', message: `上游凭据用不了：${(error as Error).message}` };
  }

  const profile = protocolFor(provider.protocol);
  const codec = dialectCodecFor(profile.dialect);
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await sendUpstream({
      env,
      address,
      provider,
      url: `${baseUrl}${profile.modelsPath()}`,
      init: { method: 'GET', headers: { Accept: 'application/json', ...profile.headers(upstreamKey) } },
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

  // 上游清单 + 协议替它补的型号：Qwen 的兼容层清单只列兼容层型号，转写与合成两条原生
  // 接口不在里面，而它们的型号表在代码里（`qwen.ts`）。不补这一步，音频调用会在选址时
  // 被「清单里没有它」划掉——那条规则本来是用来记住「上游自己承认跑不了」的。
  return { ok: true, items: [...codec.decodeModels(parsed), ...declaredModels(provider.protocol)], latency_ms: Date.now() - startedAt };
}

/** 这条协议替上游补进清单的型号（只有自带音频原生方言的协议才有）。 */
function declaredModels(protocol: Protocol): ModelInfo[] {
  const audio = protocolFor(protocol).audio;
  return audio === undefined ? [] : audioCodecFor(audio).catalog();
}

/** 上游失败时压成一句话：状态码 + 上游原话的前一小段（换行压平，宁短勿长）。 */
export function probeErrorText(probe: ModelProbe): string | null {
  if (probe.ok) return null;
  if (probe.kind !== 'upstream') return probe.message;
  const snippet = probe.body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return snippet ? `上游回 ${probe.status}：${snippet}` : `上游回 ${probe.status}`;
}

/**
 * 一条上游这次回了什么（拿不到就空着，由调用方决定怎么记）。
 *
 * 带着 `protocol`：官方价锚点要按「提供它的这条协议」取——同一批型号挂在不同协议上，
 * 定价模式可能不一样（`deepseek` 分时，通用协议不分时）。
 */
export type CatalogEntry = { provider_id: string; protocol: Protocol; items: ModelInfo[] };

/**
 * 一条模型行：名字、谁有它、以及官方按量付费价这个锚点。
 *
 * `official` 来自与记账同源的那张价目表（纳美元 / 1M token）：协议自带定价模式时
 * （`deepseek` 的高峰 / 低谷）用它的**高峰价**当锚点、低谷价单列；没有就用通用表。
 * 以后做定价撮合，一个上游的报价就是「这张表的 x 倍」，不必再维护第二份价格。
 * 型号没被收录时它是 null —— 不猜。
 */
export type CatalogModelRow = Omit<ModelInfo, 'modalities'> & {
  providers: string[];
  official: (Rates & { match: string; off_peak?: Rates }) | null;
  /**
   * 上游自述的输入 / 输出模态；**谁都没声明就是 null**，不是「只能文本」。
   *
   * `declared` 是这一行有几条上游真的说了，少于 `providers` 的条数时，`input` / `output`
   * 是几条上游的并集：有上游说能读图，不代表随便落到一条上都能读。这个数就是给读的人
   * 判断「全票还是一票」用的，所以它必须跟着数组一起走，不能只留并集。
   */
  modalities: CatalogModalities | null;
};

/** 一份合成的模态：并集 + 有几句上游说过。 */
export type CatalogModalities = {
  input: string[];
  output: string[];
  declared: number;
};

/** 展示次序：常见的几种按固定顺序排，认不得的按字母跟在后面。 */
const MODALITY_ORDER = ['text', 'image', 'audio', 'video', 'file'];

/**
 * 一组模态排成稳定的次序。
 *
 * 不用「上游答话的先后」：同一个模型名下，谁先回清单会把 `图,文` 排成 `文,图`，
 * 而这两行说的是一模一样的事。次序要能被眼睛比出来，所以钉死在这里。
 */
function orderModalities(tokens: ReadonlySet<string>): string[] {
  const known = MODALITY_ORDER.filter((token) => tokens.has(token));
  const rest = [...tokens].filter((token) => !MODALITY_ORDER.includes(token)).sort();
  return [...known, ...rest];
}

/**
 * 一行模型的官方价锚点：先问这条协议有没有自己的定价模式，没有才回通用表。
 *
 * 高峰价当锚点、低谷价单列，是因为撮合要的是**一个确定的数**：拿低谷价去乘倍数会把
 * 折扣算两遍，而高峰价是上界，也是最容易被用户对着官网核出来的那个数。
 */
function anchorOf(protocol: Protocol, model: string): CatalogModelRow['official'] {
  const tariff = tariffFor(protocol, model);
  if (tariff) {
    return { match: tariff.match, ...tariff.peak, ...(tariff.off_peak ? { off_peak: tariff.off_peak } : {}) };
  }
  const flat = ratesFor(model);
  return flat.match === null ? null : { match: flat.match, ...flat.rates };
}

/**
 * 把几条上游的清单并成一张表：一行一个模型名，顺序按名字。
 *
 * 合并规则只有三条：
 *   1. 同名就是同一条模型（Norm 转发时模型名原样透传，叫同一个名字就能打到同一处）；
 *   2. `created` / `owned_by` 先给的不被覆盖，后来的能补空；
 *   3. 模态取并集，并记下有几条上游真的说过——说过的不能被没说的拖回去，没说的也不能
 *      被说过的替它作答。
 *
 * 同一家把同一个模型列两遍（见过）不会让它在 `providers` 里出现两次。
 */
export function mergeCatalog(entries: CatalogEntry[]): CatalogModelRow[] {
  type Draft = Omit<CatalogModelRow, 'modalities'> & {
    input: Set<string>;
    output: Set<string>;
    /** 真的声明了模态的那几条上游 id：同一个名字被几家提供时，只算「有人说过」。 */
    declaring: Set<string>;
  };
  const byId = new Map<string, Draft>();

  for (const entry of entries) {
    for (const item of entry.items) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, {
          id: item.id,
          providers: [entry.provider_id],
          official: anchorOf(entry.protocol, item.id),
          input: new Set(item.modalities?.input ?? []),
          output: new Set(item.modalities?.output ?? []),
          declaring: new Set(item.modalities === undefined ? [] : [entry.provider_id]),
          ...(item.created === undefined ? {} : { created: item.created }),
          ...(item.owned_by === undefined ? {} : { owned_by: item.owned_by }),
        });
        continue;
      }
      existing.providers.push(entry.provider_id);
      // 同一个型号被几家上游提供时，锚点以「带分时价的那一条」为准：官方价是型号的事实，
      // 不该因为先答话的那条上游恰好挂在通用协议上，就把低谷价藏起来。
      if (!existing.official?.off_peak) {
        const anchor = anchorOf(entry.protocol, item.id);
        if (anchor?.off_peak) existing.official = anchor;
      }
      if (item.modalities !== undefined) {
        for (const token of item.modalities.input) existing.input.add(token);
        for (const token of item.modalities.output) existing.output.add(token);
        existing.declaring.add(entry.provider_id);
      }
      if (existing.created === undefined && item.created !== undefined) existing.created = item.created;
      if (existing.owned_by === undefined && item.owned_by !== undefined) existing.owned_by = item.owned_by;
    }
  }

  return [...byId.values()]
    .map(({ input, output, declaring, ...row }) => ({
      ...row,
      providers: [...new Set(row.providers)],
      modalities:
        declaring.size === 0
          ? null
          : { input: orderModalities(input), output: orderModalities(output), declared: declaring.size },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 上游这句话是不是在说「我没有这个型号」。
 *
 * 只认 400 / 404，并且要求错误体里同时出现这次的模型名与 model 这个词：型号拼错的请求、
 * 密钥用光的请求、参数写错的请求同样会拿到 400，凭状态码就划掉清单里的一行，等于让
 * 一次坏请求把一条好上游从路由里删掉。上游原话里点了这次的模型，才算它自己承认跑不了。
 */
export function isModelNotServed(status: number, body: string, model: string): boolean {
  if (model.length === 0) return false;
  if (status !== 400 && status !== 404) return false;
  const text = body.toLowerCase();
  return text.includes(model.toLowerCase()) && text.includes('model');
}

/**
 * 探一次清单，顺手把结果写进 `provider_models`：这是这张表唯一的来源。
 *
 * 「问」与「记」放在一起，是因为两者必须是同一次观察——分开放，读的人迟早会以为
 * 表里的行还能更新。写不进去（比如 D1 临时不可用）不该影响调用方：它只是少了一次刷新，
 * 下一回再补。
 */
export async function syncProviderModels({
  env,
  address,
  provider,
}: {
  env: Env;
  address: string;
  provider: ProbeTarget;
}): Promise<ModelProbe> {
  const probe = await probeProviderModels({ env, address, provider });
  if (probe.ok) {
    try {
      await recordProviderModels(env, provider.id, probe.items, nowSeconds());
    } catch (error) {
      // 写不进清单只说明「这次没刷新到」：路由那边会把这条上游当成清单未知继续用，
      // 读总表这一页也照样能显示它这次探测到的真实清单。一次落库失败不该变成 500。
      console.warn('provider_models 写入失败', provider.id, (error as Error).message);
    }
  }
  return probe;
}
