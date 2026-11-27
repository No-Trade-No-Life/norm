/**
 * 联网搜索：一条独立的转发线缆，不是一次对话。
 *
 * 搜索这件事在 Norm 里没有「宿主模型」这一环可选。DeepSeek 的 `/v1/tools/search` 就是搜索
 * 引擎本身：一次 JSON 请求进去、一页结构化结果出来，不跑任何模型、没有 tool 循环、没有流。
 * 所以 `/v1/web-search` 是**独立端点**——把它包成一次 `/v1/responses` 带 `tools` 的调用，
 * 等于让一个模型去替一次确定的 API 调用做决定：多一次推理、多一份不确定性，而且同一次搜索
 * 还要按 token 再付一遍钱。
 *
 * 下游只选**搜索协议**，不选模型：`source` 说 `deepseek` 还是 `openai`。两条协议的区别在
 * 上游怎么把搜索做出来，而不在「用哪个型号」——
 *
 *   deepseek-search  DeepSeek 的 Search API：搜索引擎直连，没有模型，按成功的调用计费。
 *   openai-search    OpenAI 那条路：上游把**宿主模型 + `web_search` 工具**包成同一条搜索
 *                    信封（OpenAI LB 的 `/v1/web-search` 就是这么做的）。宿主模型是那条上游
 *                    的部署设置，不是调用方的参数——所以这里同样没有模型选项，只有用量：
 *                    上游报多少 token，就按 token 记多少。
 *
 * 信封是下游的一件事：`sources[]`，`url` 必有。两条协议都把它说成同一个形状，于是调用方
 * 换一次 `source` 就能换一条路，代码不必改。
 */
import { DEEPSEEK_SEARCH_CALL_NANOS } from './deepseek';
import { fail } from './http';
import { quote, type Usage } from './pricing';

/** 下游能选的搜索协议。 */
export type SearchProtocol = 'deepseek' | 'openai';

/** 全部搜索协议，按文档顺序。 */
export const SEARCH_PROTOCOLS: SearchProtocol[] = ['deepseek', 'openai'];

const isSearchProtocol = (value: string): value is SearchProtocol =>
  (SEARCH_PROTOCOLS as string[]).includes(value);

/** 上游说哪一种搜索方言。 */
export type SearchDialect = 'deepseek-search' | 'openai-search';

/**
 * 下游的一次搜索：选哪条**协议**、问什么，其余参数是那条协议自己的语言。
 *
 * 没有 `model` 这个字段，也不该有：搜索不挑型号——`deepseek-search` 根本不跑模型，
 * `openai-search` 的宿主模型由上游部署时定下。调用方能选的是「走哪条搜索协议」。
 */
export type SearchAsk = {
  protocol: SearchProtocol;
  query: string;
  /** `source` 与 `query` 之外的参数，交给方言去解释（每一条只认自己的那几种）。 */
  params: Record<string, unknown>;
};

/**
 * 一条结果。`url` 必有——那是调用方要引用的东西，没有它的一条不是结果，是一条噪声。
 * 其余字段上游给什么就带什么：这里不是翻译层的职责。
 */
export type SearchSource = { url: string } & Record<string, unknown>;

/** 一次成功搜索的答案：一页结果 + 上游报的 token 用量（直连搜索的方言全零）。 */
export type SearchAnswer = {
  sources: SearchSource[];
  usage: Usage;
};

/**
 * 一种上游搜索方言：打到哪个路径、请求体怎么说、结果怎么读、这次值多少钱。
 *
 * 与 `AudioCodec` 同一个形状、同一条纪律：方言名进协议（`ProtocolProfile.search`），编解码
 * 只活在这一份文件里。报价是一句 `quote` 而不是一个常数，因为两条方言的记价方式本来就不同：
 * 一条按**成功的调用**，一条按上游报的 **token**。
 */
export type SearchCodec = {
  dialect: SearchDialect;
  /** 下游点的那条协议。 */
  protocol: SearchProtocol;
  /** 上游搜索路径，拼在协议基址之后。 */
  path: string;
  /** 规范化、校验这条协议自己的参数，并给出上游请求体（JSON 文本）。 */
  encode: (ask: SearchAsk) => string;
  /** 上游的成功应答 → 一页结果；没有结果的那一次按失败处理，不收钱。 */
  read: (reply: Response) => Promise<SearchAnswer>;
  /** 这一次成功的搜索报多少 Token 费（纳美元）。 */
  quote: (answer: SearchAnswer) => number;
};

const NO_USAGE: Usage = { input: 0, cached: 0, output: 0 };

/**
 * 读一次 `/v1/web-search` 的请求体：只有 `source` 与 `query` 是公共的。
 *
 * 其余参数一律先收下、再由方言逐个认领：不认识的**拒掉而不是忽略**——一个拼错的
 * `max_results` 如果被悄悄丢掉，调用方会以为「这次只要 3 条」，而实际拿到上游的默认页。
 */
export function readSearchAsk(raw: string): SearchAsk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(400, 'body_invalid', '搜索请求必须是一个 JSON 对象');
  }
  const body = recordOf(parsed);
  if (body === null) fail(400, 'body_invalid', '搜索请求必须是一个 JSON 对象');

  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!isSearchProtocol(source)) {
    fail(400, 'source_invalid', `source 必须是 ${SEARCH_PROTOCOLS.join(' 或 ')}：这两条是搜索协议，不是模型`);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query === '') fail(400, 'query_required', '搜索请求缺少 query（一个非空字符串）');

  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'source' || key === 'query') continue;
    params[key] = value;
  }
  return { protocol: source, query, params };
}

/** 按方言名取 codec（协议里存的是方言名，编解码在这里取）。 */
export function searchCodecFor(dialect: SearchDialect): SearchCodec {
  return SEARCH_CODECS[dialect];
}

/** 按下游选的协议取 codec。 */
export function searchCodecForProtocol(protocol: SearchProtocol): SearchCodec {
  return SEARCH_CODECS[SEARCH_PROTOCOLS_TO_DIALECT[protocol]];
}

// ─────────────────────────── deepseek-search ───────────────────────────

/** 下游没指定条数时要几条。 */
export const DEFAULT_MAX_RESULTS = 8;

/** 上游 `count` 的上限，与 Search API 自己的范围一致。 */
export const MAX_MAX_RESULTS = 50;

/** 上游对 `query` 的长度上限（域名操作符也算在内）。 */
const MAX_QUERY_CHARS = 128;

const DEEPSEEK_PARAMS = ['max_results', 'need_content', 'allowed_domains', 'blocked_domains'];

/**
 * DeepSeek 的搜索方言：官方 Search API 直连，没有模型，按成功的调用计费。
 *
 * DeepSeek 没有「只在这些域名里搜」这个字段，只有查询语法里的 `site:` / `-site:`，所以
 * 过滤在发出去之前就落进查询里，而不是留给上游去猜。
 */
const DEEPSEEK_SEARCH: SearchCodec = {
  dialect: 'deepseek-search',
  protocol: 'deepseek',
  path: '/v1/tools/search',
  encode: (ask) => {
    const params = onlyKnown(ask, DEEPSEEK_PARAMS, 'search_context_size / filters / user_location 是 openai 那条协议的语言');
    const allowed = optionalDomains(params, 'allowed_domains');
    const blocked = optionalDomains(params, 'blocked_domains');
    if (allowed !== null && blocked !== null) {
      fail(400, 'domains_conflict', 'allowed_domains 与 blocked_domains 不能同时给：只搜这些域名，与只不搜这些域名，是两件事');
    }
    const query = withDomainOperators(ask.query, allowed, blocked);
    if ([...query].length > MAX_QUERY_CHARS) {
      fail(
        400,
        'query_too_long',
        `带上域名过滤之后 query 必须在 ${MAX_QUERY_CHARS} 个字符以内：上游的查询语句有长度上限，由我们说出来，别让它 400`,
      );
    }
    return JSON.stringify({
      query,
      count: boundedInteger(params, 'max_results', DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS),
      need_content: optionalBoolean(params, 'need_content'),
    });
  },
  read: async (reply) => {
    const body = recordOf(await jsonOf(reply));
    const results = body === null ? null : body.results;
    if (!Array.isArray(results)) {
      fail(502, 'search_data_missing', '联网搜索失败：上游的回答里没有 results 数组');
    }
    const sources = results.map(sourceOf).filter((source): source is SearchSource => source !== null);
    requireOneSource(sources);
    return { sources, usage: NO_USAGE };
  },
  // 上游按**成功调用**计费：一次 750,000 纳美元（每 1,000 次 0.75 美元），与搜到什么无关。
  quote: () => DEEPSEEK_SEARCH_CALL_NANOS,
};

// ─────────────────────────── openai-search ───────────────────────────

const OPENAI_PARAMS = ['search_context_size', 'filters', 'user_location'];

/**
 * OpenAI 那条路：上游把**宿主模型 + `web_search` 工具**包成同一条搜索信封。
 *
 * 请求参数是 OpenAI 的三个：`search_context_size`（搜多深）、`filters.allowed_domains`
 * （来源域名）、`user_location`（人在哪）。宿主模型由那条上游部署时定下（OpenAI LB 的
 * `web_search_host_model`），这里既不传也不认——调用方选的是搜索协议，不是型号。
 *
 * 计价按上游报的 **token**：一次搜索在那边就是一次模型回合，Norm 看不到那条上游用的是哪个
 * 宿主模型，所以按通用价目表折价（`pricing.ts` 的 `DEFAULT_RATES`）——这是这条方言唯一
 * 诚实的记法：账本不去猜上游的部署设置，改价只改价目表。
 */
const OPENAI_SEARCH: SearchCodec = {
  dialect: 'openai-search',
  protocol: 'openai',
  path: '/v1/web-search',
  encode: (ask) => {
    const params = onlyKnown(ask, OPENAI_PARAMS, 'max_results / need_content / allowed_domains / blocked_domains 是 deepseek 那条协议的语言');
    return JSON.stringify({ query: ask.query, ...params });
  },
  read: async (reply) => {
    const body = recordOf(await jsonOf(reply));
    const sources = collectOpenAiSources(body);
    requireOneSource(sources);
    const usage = recordOf(body?.usage);
    return {
      sources,
      usage: {
        input: numberOrZero(usage?.input_tokens),
        cached: numberOrZero(usage?.cached_tokens),
        output: numberOrZero(usage?.output_tokens),
      },
    };
  },
  quote: (answer) => quote('', answer.usage).total_nanos,
};

const SEARCH_CODECS: Record<SearchDialect, SearchCodec> = {
  'deepseek-search': DEEPSEEK_SEARCH,
  'openai-search': OPENAI_SEARCH,
};

const SEARCH_PROTOCOLS_TO_DIALECT: Record<SearchProtocol, SearchDialect> = {
  deepseek: 'deepseek-search',
  openai: 'openai-search',
};

// ─────────────────────────── 共用的小工具 ───────────────────────────

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0;

async function jsonOf(reply: Response): Promise<unknown> {
  try {
    return await reply.json();
  } catch {
    fail(502, 'search_data_missing', '联网搜索失败：上游的回答不是 JSON');
  }
}

/** 一条结果都没有 = 这次搜索不算成功：上游按成功计费，账本不能比发票贵。 */
function requireOneSource(sources: SearchSource[]): void {
  if (sources.length === 0) {
    fail(502, 'search_empty', '联网搜索失败：这次搜索一条结果都没有（上游按成功的调用计费，这一笔不收 Token 费）');
  }
}

/**
 * 只留下这条方言认识的参数；不认识的当场拒，并在话里点出它属于另一条协议。
 *
 * 静默忽略是最坏的一种：调用方以为过滤生效了，拿到的是没过滤的一页。
 */
function onlyKnown(
  ask: SearchAsk,
  known: readonly string[],
  elsewhere: string,
): Record<string, unknown> {
  for (const key of Object.keys(ask.params)) {
    if (!known.includes(key)) {
      fail(
        400,
        'param_unsupported',
        `${ask.protocol} 这条搜索协议不认 ${key}：它认 ${known.join(' / ')}${elsewhere === '' ? '' : `（${elsewhere}）`}`,
      );
    }
  }
  return ask.params;
}

function optionalBoolean(params: Record<string, unknown>, field: string): boolean {
  const value = params[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(400, `${field}_invalid`, `${field} 必须是 true 或 false`);
  return value;
}

function boundedInteger(
  params: Record<string, unknown>,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const value = params[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    fail(400, `${field}_invalid`, `${field} 必须是 1 到 ${maximum} 之间的整数`);
  }
  return value;
}

/**
 * 域名过滤：只接受裸域名。
 *
 * 带协议、带路径、带空白的「域名」到了上游只会变成一句搜不到东西的查询，而调用方会以为
 * 自己过滤对了——所以这里直接拒。
 */
function optionalDomains(params: Record<string, unknown>, field: string): string[] | null {
  const value = params[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, `${field}_invalid`, `${field} 必须是一个非空数组`);
  }
  return value.map((domain) => {
    const text = typeof domain === 'string' ? domain.trim() : '';
    if (text === '' || /[/\\]/.test(text) || /\s/.test(text)) {
      fail(400, `${field}_invalid`, `${field} 只能放裸域名，例如 example.com`);
    }
    return text;
  });
}

/** 域名过滤落进查询语法：允许多个是 OR，屏蔽的每一个都排除。 */
function withDomainOperators(
  query: string,
  allowed: string[] | null,
  blocked: string[] | null,
): string {
  if (allowed !== null) return `${query} ${allowed.map((domain) => `site:${domain}`).join(' OR ')}`;
  if (blocked !== null) return `${query} ${blocked.map((domain) => `-site:${domain}`).join(' ')}`;
  return query;
}

/**
 * 一条 `results[]` 折成一条 source：字段名用信封那一套（`date` 说成 `published_at`），
 * 空串与 null 不带。`url` 缺失的那条直接丢掉——它没法被引用。
 */
function sourceOf(item: unknown): SearchSource | null {
  const entry = recordOf(item);
  if (entry === null) return null;
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (url === '') return null;
  const source: SearchSource = { url };
  for (const [field, output] of [
    ['title', 'title'],
    ['snippet', 'snippet'],
    ['summary', 'summary'],
    ['content', 'content'],
    ['date', 'published_at'],
    ['site_name', 'site_name'],
    ['authority', 'authority'],
    ['rerank_score', 'rerank_score'],
  ] as const) {
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    source[output] = value;
  }
  return source;
}

/**
 * OpenAI 那条路的信封里有两种放来源的地方：
 *
 *   `data[].action.sources[]`  Responses 里的 `web_search_call` 调用项（OpenAI LB 走这条，
 *                              它给上游带上 `include: web_search_call.action.sources`）；
 *   顶层 `sources[]`            已经归一过的搜索服务。
 *
 * 两处都读，读到的合成一页：这是「同一条信封」的两个写法，不是两种契约。
 */
function collectOpenAiSources(body: Record<string, unknown> | null): SearchSource[] {
  if (body === null) return [];
  const collected: SearchSource[] = [];
  const push = (item: unknown) => {
    const source = sourceOf(item);
    if (source !== null) collected.push(source);
  };
  for (const item of arrayOf(body.data)) {
    const action = recordOf(recordOf(item)?.action);
    for (const source of arrayOf(action?.sources)) push(source);
  }
  for (const item of arrayOf(body.sources)) push(item);
  return collected;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
