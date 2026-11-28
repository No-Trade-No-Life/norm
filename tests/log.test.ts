import { describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/env';
import { describeError, errorSummary, logError } from '../src/log';

describe('结构化错误日志（不吞没具体错误与 cause 链）', () => {
  it('展开 D1 风格的嵌套 cause 链与堆栈，且可完整 JSON 序列化', () => {
    const sqliteErr = new Error('no such column: p.last_nonce: SQLITE_ERROR');
    const d1Err = new Error('D1_ERROR: no such column: p.last_nonce', { cause: sqliteErr });

    const detail = describeError(d1Err);
    expect(detail.name).toBe('Error');
    expect(detail.message).toBe('D1_ERROR: no such column: p.last_nonce');
    expect(detail.stack).toContain('D1_ERROR');
    expect(detail.cause?.message).toBe('no such column: p.last_nonce: SQLITE_ERROR');

    // JSON.stringify 绝不能退化成 `{}`。
    const roundTrip = JSON.parse(JSON.stringify(detail)) as typeof detail;
    expect(roundTrip.message).toBe('D1_ERROR: no such column: p.last_nonce');
    expect(roundTrip.cause?.message).toBe('no such column: p.last_nonce: SQLITE_ERROR');

    expect(errorSummary(d1Err)).toBe(
      'Error: D1_ERROR: no such column: p.last_nonce <- Error: no such column: p.last_nonce: SQLITE_ERROR',
    );
  });

  it('处理循环 cause、AggregateError 与非 Error 抛出值时不崩溃', () => {
    const circular = new Error('loop') as Error & { cause?: unknown };
    circular.cause = circular;
    const described = describeError(circular);
    expect(described.cause?.message).toContain('[circular]');

    const agg = new AggregateError([new Error('first'), 'second'], 'multi');
    const aggDescribed = describeError(agg);
    expect(aggDescribed.errors?.map((e) => e.message)).toEqual(['first', 'second']);

    expect(describeError('plain failure')).toEqual({ name: 'string', message: 'plain failure' });
    expect(describeError({ code: 'E_CUSTOM', message: 'obj failure' })).toEqual({
      name: 'NonError',
      code: 'E_CUSTOM',
      message: 'obj failure',
    });
  });

  it('app.onError 遇到未捕获异常时向 console.error 输出完整结构化错误而非空对象', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const rootCause = new Error('no such column: p.last_nonce: SQLITE_ERROR');
      const d1Failure = new Error('D1_ERROR: query failed', { cause: rootCause });
      const brokenDb = {
        prepare() {
          return {
            bind() {
              return {
                first: async () => {
                  throw d1Failure;
                },
                all: async () => {
                  throw d1Failure;
                },
              };
            },
            first: async () => {
              throw d1Failure;
            },
            all: async () => {
              throw d1Failure;
            },
          };
        },
      } as unknown as Env['DB'];

      const response = await app.fetch(
        new Request('https://norm.ntnl.io/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer sk-norm-testtoken', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
        }),
        { DB: brokenDb } as Env,
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal_error', message: '服务内部错误' });

      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      const json = JSON.stringify(payload);
      expect(json).toContain('D1_ERROR: query failed');
      expect(json).toContain('no such column: p.last_nonce: SQLITE_ERROR');
      expect(payload.event).toBe('unhandled_error');
      expect(payload.method).toBe('POST');
      expect(payload.path).toBe('/v1/chat/completions');
      expect(typeof payload.message).toBe('string');
      expect(payload.message).toContain('no such column: p.last_nonce: SQLITE_ERROR');
    } finally {
      spy.mockRestore();
    }
  });

  it('logError 输出单参数纯对象，字段可被 Workers Logs 直接索引', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logError('stream_error', new Error('upstream reset'), { request_id: 'req_1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.length).toBe(1);
      const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload.level).toBe('error');
      expect(payload.event).toBe('stream_error');
      expect(payload.request_id).toBe('req_1');
      expect(payload.message).toBe('Error: upstream reset');
    } finally {
      spy.mockRestore();
    }
  });
});
