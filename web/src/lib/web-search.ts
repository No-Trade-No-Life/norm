/** 一条出处：模型引用了哪个页面。`title` 缺省时页面只显示主机名。 */
export type SearchSource = { url: string; title: string | null };

export type SearchOutcome = {
  answer: string;
  /** 上游这一次实际检索的词（web_search_call 里带回来的）。 */
  queries: string[];
  sources: SearchSource[];
};

/**
 * 读 `POST /v1/responses` 带 `web_search` 工具的回包。
 *
 * 直通时这就是上游原样的 Responses 体，所以按它自己的形状读：
 *   - `output[]` 里 `type: "message"` 的条目装着答案，`content[].annotations[]` 里是
 *     `url_citation` 注记（url + title），出处就从这里来；
 *   - `type: "web_search_call"` 的条目带着上游真正发出去的检索词（`action.query`
 *     或 `action.queries`）；
 *   - 少数实现只给一个扁平 `output_text`，那就只有答案、没有出处。
 *
 * 出处按 url 去重、保序：模型常把同一个页面引两次，重复列出来只会让页面变长。
 */
export function readSearchOutcome(payload: unknown): SearchOutcome {
  const body = asRecord(payload);
  const answers: string[] = [];
  const queries: string[] = [];
  const sources: SearchSource[] = [];

  for (const item of recordList(body.output)) {
    const type = stringField(item.type);

    if (type === 'web_search_call') {
      const action = asRecord(item.action);
      for (const query of stringList(action.queries)) queries.push(query);
      const single = stringField(action.query);
      if (single) queries.push(single);
      continue;
    }

    for (const part of recordList(item.content)) {
      const text = stringField(part.text);
      if (text) answers.push(text);
      for (const annotation of recordList(part.annotations)) {
        if (stringField(annotation.type) !== 'url_citation') continue;
        const citation = maybeRecord(annotation.url_citation) ?? annotation;
        const url = stringField(citation.url);
        if (!url) continue;
        sources.push({ url, title: stringField(citation.title) || null });
      }
    }
  }

  const flat = stringField(body.output_text);
  if (!answers.length && flat) answers.push(flat);

  return {
    answer: answers.join('\n\n').trim(),
    queries: unique(queries),
    sources: uniqueBy(sources, (source) => source.url),
  };
}

/** 和 `asRecord` 一样，但「没有」时回 null——`?? fallback` 才真的能生效。 */
function maybeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

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
