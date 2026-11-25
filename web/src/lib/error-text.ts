/**
 * 把任何「错误的形状」压成一句能显示的话。
 *
 * 为什么需要它：上游不是我们说哪句就回哪句。OpenAI 与 DeepSeek 回的是
 * `{"error":{"message":…,"type":…}}`，Norm 自己回的是 `{"error":"code","message":…}`，
 * 有人回纯文本，有人回 HTML。之前 Playground 直接拿 `parsed.error` 当字符串用，
 * 于是把一个**对象**交给了 React——整页白屏，用户看到的就是「点了没反应」。
 *
 * 所以这里的唯一契约是：**永远返回 string**。对象没法显示，就没资格进 JSX。
 */
export function errorText(payload: unknown, fallback = ''): string {
  if (payload === null || payload === undefined) return fallback;
  if (typeof payload === 'string') return payload.trim() || fallback;
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (payload instanceof Error) return payload.message || fallback;

  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    // 先看最像人话的那几个键；`error` 既可能是字符串（我们的 code），也可能是对象。
    for (const key of ['message', 'error', 'detail', 'error_description']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const inner = errorText(nested, '');
      if (inner) return inner;
    }
    // 认不出来的形状：把原文交出去，总比一句「请求失败」更有用。
    try {
      const json = JSON.stringify(payload);
      if (!json || json === '{}') return fallback;
      return json.length > 400 ? `${json.slice(0, 400)}…` : json;
    } catch {
      return fallback;
    }
  }

  return fallback;
}
