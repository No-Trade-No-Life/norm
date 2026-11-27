/**
 * 联网搜索：一条独立的转发线缆，不是一次对话。
 *
 * 搜索这件事在 Norm 里没有「宿主模型」这一环。DeepSeek 的 `/v1/tools/search` 就是搜索引擎
 * 本身：一次 JSON 请求进去、一页结构化结果出来，不跑任何模型、没有 tool 循环、没有流，也
 * 没有「模型决定要不要搜」这一步。所以 `/v1/web-search` 是**独立端点**——把它包成一次
 * `/v1/responses` 带 `tools` 的调用，等于让一个模型去替一次确定的 API 调用做决定：多一次
 * 推理、多一份不确定性，而且同一次搜索要按 token 再付一遍钱。
 *
 * 这一层只做三件事：解析下游的搜索请求、换成上游 Search API 的请求体、把结果读回来。没有
 * 「方言」联合类型——上游今天只有一种搜索方言（DeepSeek Search API），多一层抽象只是把一件
 * 一目了然的事说成两句。信封与 DeepSeek LB 的 `/v1/web-search` 同一套（`sources[]`，`url`
 * 必有），于是「官方 API」与「一条 LB」可以互换着用：改一次基址，调用方不必改代码。
 */
import { fail } from './http';

/** 上游 Search API 的路径，拼在协议基址之后（DeepSeek 官方基址是 `https://api.deepseek.com`）。 */
export const SEARCH_PATH = '/v1/tools/search';

/** 下游没指定条数时要几条。 */
export const DEFAULT_MAX_RESULTS = 8;

/** 上游 `count` 的上限，与 Search API 自己的范围一致。 */
export const MAX_MAX_RESULTS = 50;

/** 上游对 `query` 的长度上限（域名操作符也算在内）。 */
const MAX_QUERY_CHARS = 128;

/**
 * 一次搜索的规范请求。
 *
 * `query` 是**折进域名过滤之后**的那一句话：Search API 没有「只在这些域名里搜」的字段，
 * 它只有查询语法里的 `site:` / `-site:`，所以过滤在发出去之前就该落进查询里，而不是留给
 * 上游去猜。
 */
export type SearchAsk = {
  query: string;
  max_results: number;
  need_content: boolean;
};

/**
 * 一条结果。`url` 必有——那是调用方要引用的东西，没有它的一条不是结果，是一条噪声。
 * 其余字段上游给什么就带什么：这里不是翻译层的职责。
 */
export type SearchSource = { url: string } & Record<string, unknown>;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * 读一次 `/v1/web-search` 的请求体。
 *
 * 每一个可选参数都**拒掉而不是忽略**：拼错的 `max_results` 如果被悄悄当作默认值，调用方
 * 会以为「这次只要 3 条」，而实际拿到 8 条——搜索这种一次一页的东西，宁可 400 说清楚。
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

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query === '') fail(400, 'query_required', '搜索请求缺少 query（一个非空字符串）');

  const allowed = optionalDomains(body, 'allowed_domains');
  const blocked = optionalDomains(body, 'blocked_domains');
  if (allowed !== null && blocked !== null) {
    fail(400, 'domains_conflict', 'allowed_domains 与 blocked_domains 不能同时给：只搜这些域名，与只不搜这些域名，是两件事');
  }
  const query_with_domains = withDomainOperators(query, allowed, blocked);
  if ([...query_with_domains].length > MAX_QUERY_CHARS) {
    fail(
      400,
      'query_too_long',
      `带上域名过滤之后 query 必须在 ${MAX_QUERY_CHARS} 个字符以内：上游的查询语句有长度上限，由我们说出来，别让它 400`,
    );
  }

  return {
    query: query_with_domains,
    max_results: boundedInteger(body, 'max_results', DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS),
    need_content: optionalBoolean(body, 'need_content'),
  };
}

/** 上游 Search API 的请求体：查询带着域名操作符，`count` 是结果条数，`need_content` 要正文。 */
export function searchBody(ask: SearchAsk): string {
  return JSON.stringify({ query: ask.query, count: ask.max_results, need_content: ask.need_content });
}

/**
 * 读上游的应答。
 *
 * 一个 200 不等于一次成功的搜索：**没有一条结果的那一次不收钱**（上游按成功的调用计费），
 * 所以这里把它说成一次失败——调用方拿到的是一个明确的错误，而不是一页空白，账上也就没有
 * 一笔不该存在的 Token 费。上游回的不是 JSON 或没有 `results` 数组同理：那是上游违约，
 * 不是「搜不到」。
 */
export async function readSearchAnswer(reply: Response): Promise<SearchSource[]> {
  let payload: unknown;
  try {
    payload = await reply.json();
  } catch {
    fail(502, 'search_data_missing', '联网搜索失败：上游的回答不是 JSON');
  }
  const body = recordOf(payload);
  const results = body === null ? null : body.results;
  if (!Array.isArray(results)) {
    fail(502, 'search_data_missing', '联网搜索失败：上游的回答里没有 results 数组');
  }
  const sources = results
    .map(sourceOf)
    .filter((source): source is SearchSource => source !== null);
  if (sources.length === 0) {
    fail(502, 'search_empty', '联网搜索失败：这次搜索一条结果都没有（上游按成功的调用计费，这一笔不收 Token 费）');
  }
  return sources;
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

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(400, `${field}_invalid`, `${field} 必须是 true 或 false`);
  return value;
}

function boundedInteger(
  body: Record<string, unknown>,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const value = body[field];
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
function optionalDomains(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
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
