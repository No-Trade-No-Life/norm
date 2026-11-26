import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { publicRoutes } from '../src/routes/public';

const STATS = { principals: 3, providers: 2, requests: 7, spend_nanos: 1_234_567 };

/** 缓存语义只在边缘存在；这里用一张 Map 把「命中 / 未命中」变成可断言的事实。 */
class FakeCache {
  store = new Map<string, Response>();
  writes = 0;

  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.writes += 1;
    this.store.set(request.url, response.clone());
  }
}

function fakeEnv(seen: string[]): Env {
  return {
    DB: {
      prepare(sql: string) {
        seen.push(sql);
        return { first: async () => STATS };
      },
    },
  } as unknown as Env;
}

function executionCtx(): { ctx: ExecutionContext; settled: () => Promise<unknown[]> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => {} } as unknown as ExecutionContext,
    settled: () => Promise.all(pending),
  };
}

describe('/api/v1/stats 的缓存', () => {
  let cache: FakeCache;

  beforeEach(() => {
    cache = new FakeCache();
    (globalThis as unknown as { caches: { default: FakeCache } }).caches = { default: cache };
  });

  afterEach(() => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
  });

  it('同一个 TTL 内第二次请求命中缓存，不再扫库', async () => {
    const seen: string[] = [];
    const env = fakeEnv(seen);
    const { ctx, settled } = executionCtx();

    const first = await publicRoutes.request('https://norm.ntnl.io/stats', {}, env, ctx);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    // 累计消费读 principals，请求表只数行数——不再对 requests 求 SUM。
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('SUM(spend_nanos)');
    expect(seen[0]).toContain('FROM principals');
    expect(seen[0]).not.toContain('SUM(fee_nanos)');
    const body = await first.clone().json();
    await settled();
    expect(cache.writes).toBe(1);

    // 查询串不同也命中同一个键：缓存键是规范 URL，参数不参与。
    const second = await publicRoutes.request('https://norm.ntnl.io/stats?t=1', {}, env, ctx);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(seen).toHaveLength(1);
  });
});
