/**
 * 结构化错误日志：把异常本身、嵌套 cause 链与堆栈展开成纯对象再交给 console.error / console.warn。
 *
 * 为什么不能直接 `console.error('norm error', error)`：
 * Error 的 name / message / stack / cause 都是不可枚举属性，Cloudflare Workers Observability
 * 日志在序列化多参数或 Error 实例时容易把它们吞成 `{}`，尤其是 D1 把真正的 SQLite 报错
 * （例如 `no such column: p.last_nonce`）套在 `error.cause` 里时，只留一句 `norm error` 根本查不到根因。
 *
 * ZDR 约束：日志只记录事件名、路径、错误自身和不含内容的元信息，绝不记录请求体、响应体、请求头或任何密钥。
 */

export type SerializedError = {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  stack?: string;
  cause?: SerializedError;
  errors?: SerializedError[];
};

const MAX_CAUSE_DEPTH = 5;

/** 把任意抛出的值安全展开成可 JSON 序列化的纯对象，保留完整 cause 链与堆栈。 */
export function describeError(error: unknown, depth = 0, seen = new WeakSet<object>()): SerializedError {
  if (depth > MAX_CAUSE_DEPTH) {
    return { name: 'Error', message: '[max cause depth reached]' };
  }
  if (error instanceof Error) {
    if (seen.has(error)) {
      return { name: error.name || 'Error', message: `${error.message} [circular]` };
    }
    seen.add(error);
    const out: SerializedError = {
      name: error.name || 'Error',
      message: error.message || '',
    };
    const extras = error as unknown as Record<string, unknown>;
    if (typeof extras.code === 'string' || typeof extras.code === 'number') out.code = extras.code;
    if (typeof extras.status === 'number') out.status = extras.status;
    if (error.stack) out.stack = error.stack;
    if (error.cause !== undefined) out.cause = describeError(error.cause, depth + 1, seen);
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      out.errors = error.errors.map((item) => describeError(item, depth + 1, seen));
    }
    return out;
  }
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'NonError';
    let message: string;
    if (typeof record.message === 'string' && record.message.length > 0) {
      message = record.message;
    } else {
      try {
        message = JSON.stringify(error);
      } catch {
        message = String(error);
      }
    }
    const out: SerializedError = { name, message };
    if (typeof record.code === 'string' || typeof record.code === 'number') out.code = record.code;
    if (typeof record.status === 'number') out.status = record.status;
    if (typeof record.stack === 'string') out.stack = record.stack;
    if (record.cause !== undefined && !seen.has(error)) {
      seen.add(error);
      out.cause = describeError(record.cause, depth + 1, seen);
    }
    return out;
  }
  return { name: typeof error, message: String(error) };
}

function summarize(detail: SerializedError): string {
  const parts: string[] = [];
  let cursor: SerializedError | undefined = detail;
  while (cursor) {
    const label = cursor.code !== undefined ? `${cursor.name}[${cursor.code}]` : cursor.name;
    parts.push(cursor.message ? `${label}: ${cursor.message}` : label);
    cursor = cursor.cause;
  }
  return parts.join(' <- ');
}

/** 拼出包含整条 cause 链的单行摘要，便于在日志列表和 wrangler tail 里一眼看到根因。 */
export function errorSummary(error: unknown): string {
  return summarize(describeError(error));
}

export function logError(event: string, error: unknown, context: Record<string, unknown> = {}): void {
  const detail = describeError(error);
  console.error({
    level: 'error',
    event,
    message: summarize(detail),
    ...context,
    error: detail,
  });
}

export function logWarn(event: string, error: unknown, context: Record<string, unknown> = {}): void {
  const detail = describeError(error);
  console.warn({
    level: 'warn',
    event,
    message: summarize(detail),
    ...context,
    error: detail,
  });
}
