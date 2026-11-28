import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/env';
import { requestQueryRoutes } from '../src/routes/requests';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const ALICE = 'alice-requests-query';
const BOB = 'bob-requests-query';

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

function d1(db: DatabaseSync): Env['DB'] {
  return {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[], meta: { rows_read: 0, rows_written: 0 } }),
            run: async () => {
              db.prepare(sql).run(...params);
              return { success: true, meta: { changes: 0, rows_written: 0 } };
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
}

function seed(db: DatabaseSync, address: string): void {
  db.prepare('INSERT INTO principals (address, created_at) VALUES (?, ?)').run(address, 1);
  db.prepare("INSERT INTO consumers (id, address, name, key_sha256, key_hint, created_at) VALUES (?, ?, 'c', ?, 'hint', 1)").run(
    `con_${address}`,
    address,
    `sha_${address}`,
  );
}

/**
 * 写一行请求记录。列在这里只写这条契约要读的那几列，别的用默认值——
 * 这条测试关心的是「金额与归属」，不是结算本身（那是 spend-invariant 的事）。
 */
function request(
  db: DatabaseSync,
  address: string,
  id: string,
  options: { consumerId?: string | null; feeNanos?: number; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO requests (id, address, provider_id, provider_user, consumer_id, consumer_user, base_url, model,
                           status, status_code, latency_ms, input_tokens, cached_tokens, output_tokens,
                           gas_fee_nanos, token_nanos, fee_nanos, created_at)
     VALUES (?, ?, 'prv_1', ?, ?, ?, 'https://up.example/v1', 'model-1', ?, 200, 5, 10, 2, 3, 1, ?, ?, 100)`,
  ).run(
    id,
    address,
    address,
    options.consumerId === undefined ? `con_${address}` : options.consumerId,
    address,
    options.status ?? 'ok',
    options.feeNanos ?? 7,
    options.feeNanos ?? 7,
  );
}

async function query(db: DatabaseSync, address: string, body: unknown): Promise<Response> {
  const { Hono } = await import('hono');
  const { HttpError } = await import('../src/http');
  const app = new Hono<{ Bindings: Env; Variables: { principal: { address: string; consumerId: string } } }>();
  app.use('*', async (c, next) => {
    c.set('principal', { address, consumerId: `con_${address}` });
    await next();
  });
  app.route('/', requestQueryRoutes);
  // 与真实 Worker 同一套错误映射：`fail()` 抛的 HttpError 变成它的状态码，
  // 少了这一段，断言看到的是脚手架的 500 而不是接口自己的 400。
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message }, error.status as 400);
    }
    return c.json({ error: 'internal_error', message: '服务内部错误' }, 500);
  });
  const env = { DB: d1(db) } as unknown as Env;
  return app.request(
    'https://norm.test/requests/query',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  seed(db, ALICE);
  seed(db, BOB);
  return db;
}

describe('请求费用查询契约', () => {
  it('按请求 ID 回金额，账目字段与网关读的那一份同形', async () => {
    const db = fixture();
    request(db, ALICE, 'req_1', { feeNanos: 8_039 });
    const body = (await (await query(db, ALICE, { ids: ['req_1'] })).json()) as Record<string, any>;

    expect(body.missing).toEqual([]);
    expect(body.requests).toEqual([
      {
        request_id: 'req_1',
        status: 'ok',
        model: 'model-1',
        input_tokens: 10,
        cached_tokens: 2,
        output_tokens: 3,
        cost_usd_nanos: 8_039,
        // Norm 在回响应之前就结完了账，所以不存在「还没算完」的那一态。
        settlement_pending: false,
        created_at: 100,
      },
    ]);
  });

  it('没记录过的 ID 归进 missing，而不是猜一个 0', async () => {
    const db = fixture();
    request(db, ALICE, 'req_known', { feeNanos: 5 });
    const body = (await (await query(db, ALICE, { ids: ['req_known', 'req_unknown'] })).json()) as Record<string, any>;

    expect(body.requests.map((record: { request_id: string }) => record.request_id)).toEqual(['req_known']);
    expect(body.missing).toEqual(['req_unknown']);
  });

  it('别人的请求 ID 读不到：同一个 ID 在另一个账户下就是 missing', async () => {
    const db = fixture();
    request(db, BOB, 'req_bob', { feeNanos: 999 });
    const body = (await (await query(db, ALICE, { ids: ['req_bob'] })).json()) as Record<string, any>;

    expect(body.requests).toEqual([]);
    expect(body.missing).toEqual(['req_bob']);
  });

  it('同一账户的别人那把 Token 的记录也读不到', async () => {
    const db = fixture();
    // 同一个账户下换一把消费者密钥发起的调用：钱是这个账户花的，但不属于这把 Token。
    request(db, ALICE, 'req_other_token', { consumerId: 'con_someone_else' });
    const body = (await (await query(db, ALICE, { ids: ['req_other_token'] })).json()) as Record<string, any>;

    expect(body.missing).toEqual(['req_other_token']);
  });

  it('重复的 ID 只回答一次，且按调用方给的顺序回', async () => {
    const db = fixture();
    request(db, ALICE, 'req_a', { feeNanos: 1 });
    request(db, ALICE, 'req_b', { feeNanos: 2 });
    const body = (await (await query(db, ALICE, { ids: ['req_b', 'req_a', 'req_b'] })).json()) as Record<string, any>;

    expect(body.requests.map((record: { request_id: string }) => record.request_id)).toEqual(['req_b', 'req_a']);
    expect(body.missing).toEqual([]);
  });

  it('超过分批上限的批量也全部答上（分段查询后合并）', async () => {
    const db = fixture();
    const ids = Array.from({ length: 120 }, (_, index) => `req_${index}`);
    for (const id of ids) request(db, ALICE, id, { feeNanos: 3 });
    const body = (await (await query(db, ALICE, { ids })).json()) as Record<string, any>;

    expect(body.requests).toHaveLength(120);
    expect(body.missing).toEqual([]);
  });

  it('空 ids 与缺 ids 都是 400，静默回空表会让调用方以为结完了账', async () => {
    const db = fixture();
    expect((await query(db, ALICE, { ids: [] })).status).toBe(400);
    expect((await query(db, ALICE, {})).status).toBe(400);
    expect((await query(db, ALICE, { ids: 'req_1' })).status).toBe(400);
  });
});
