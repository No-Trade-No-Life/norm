/** 一条出处：这次搜索命中的哪个页面。`title` 缺省时页面只显示主机名。 */
export type SearchSource = {
  url: string;
  title: string | null;
  snippet: string | null;
};

/** 一次搜索的回包：走的是哪条搜索协议，命中了哪几页。 */
export type SearchOutcome = {
  source: string;
  sources: SearchSource[];
};

/**
 * 读 `POST /v1/web-search` 的回包。
 *
 * 这是 **Norm 自己的信封**，不是某家上游的原话——两条搜索协议（deepseek 直连 Search API、
 * openai 走"宿主模型 + web_search"那条）都说这一个形状，页面因此只有一份读法：
 *
 *   - `source`  这一次走的是哪条协议；
 *   - `sources[]` 命中的页面：`url` 必有，`title` / `snippet`（没有就试 `summary`）有就带；
 *   - `norm`     账单，页面读它画底下那条。
 *
 * 上游多给的字段一概不猜：页面只画它说得清的那几样，剩下的调用方自己去读原始 JSON。
 */
export function readSearchOutcome(payload: unknown): SearchOutcome {
  const body = asRecord(payload);
  const sources: SearchSource[] = [];
  for (const item of recordList(body.sources)) {
    const url = stringField(item.url).trim();
    if (url === '') continue;
    sources.push({
      url,
      title: stringField(item.title).trim() || null,
      snippet: stringField(item.snippet).trim() || stringField(item.summary).trim() || null,
    });
  }
  return { source: stringField(body.source), sources: uniqueBy(sources, (source) => source.url) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 同一个页面被命中两次时只留第一次：重复列出来只会让页面变长。 */
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** 出处的主机名：标题缺省时显示它，让一行字仍然说得清这是哪儿。 */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
