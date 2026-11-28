import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { Env } from '../src/env';
import { uuidv7 } from '../src/ids';
import { accountRoutes } from '../src/routes/account';

/**
 * 账本拆页之后，每一页各查各的：明细页要顺带拿到上游名字（不再为几个名字拉一次全量聚合），
 * 聚合页要能吃时间窗（不再每次把整个历史扫一遍）。这两条都属于「查询边界」，只能靠对着真
 * SQLite 跑一次才看得见——本地 mock 会把 SQL 写错这件事瞒过去。
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const ALICE = 'alice-ledger-pages';
const DAY_MS = 86_400_000;

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

/** 跑真 SQLite 的最小 D1 适配器：账本路由只用到 prepare/bind/first/all。 */
function d1(db: DatabaseSync): Env['DB'] {
  return {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[] }),
          };
        },
      };
    },
  } as unknown as Env['DB'];
}

function client(db: DatabaseSync) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: { address: string } } }>();
  app.use('*', async (c, next) => {
    c.set('principal', { address: ALICE });
    await next();
  });
  app.route('/account', accountRoutes);
  const env = { DB: d1(db) } as unknown as Env;
  return async (path: string) => (await app.request(`https://norm.test${path}`, {}, env)).json() as Promise<any>;
}

function insertRequest(
  db: DatabaseSync,
  options: { id: string; providerId: string; providerUser: string; fee: number; at: number },
): void {
  db.prepare(
    `INSERT INTO requests
       (id, address, provider_id, provider_user, consumer_id, consumer_user, base_url, model, status, status_code, latency_ms,
        input_tokens, cached_tokens, output_tokens, gas_fee_nanos, gas_billed_nanos, token_nanos, token_billed_nanos,
        fee_nanos, unbilled_nanos, spend_before_nanos, spend_after_nanos, created_at)
     VALUES (?, ?, ?, ?, 'con_1', ?, 'https://api.example.com/v1', 'gpt-4o-mini', 'ok', 200, 100,
             100, 0, 20, ?, ?, 0, 0, ?, 0, 0, ?, ?)`,
  ).run(
    options.id,
    ALICE,
    options.providerId,
    options.providerUser,
    ALICE,
    options.fee,
    options.fee,
    options.fee,
    options.fee,
    Math.floor(options.at / 1000),
  );
}

function fixture(): { db: DatabaseSync; recentId: string; oldId: string } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const now = Date.now();
  db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
    ALICE,
    1_700_000_000,
    10_000_000,
  );
  for (const [id, label] of [
    ['prv_recent', '主力上游'],
    ['prv_old', '旧上游'],
  ] as const) {
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 1, ?)`,
    ).run(id, ALICE, label, 'https://api.example.com/v1', 'sk-a…z', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);
  }

  const recentId = uuidv7(now - 60_000);
  const oldId = uuidv7(now - 20 * DAY_MS);
  insertRequest(db, { id: recentId, providerId: 'prv_recent', providerUser: ALICE, fee: 4_000, at: now - 60_000 });
  insertRequest(db, { id: oldId, providerId: 'prv_old', providerUser: ALICE, fee: 2_000, at: now - 20 * DAY_MS });
  return { db, recentId, oldId };
}

describe('账本拆页后的查询边界', () => {
  it('明细页一次拿齐上游名字：provider_label 跟着请求行回来，不用再拉聚合', async () => {
    const { db } = fixture();
    const get = client(db);

    const feed = await get('/account/usage?limit=50');
    expect(feed.items.map((row: any) => row.provider_label)).toEqual(['主力上游', '旧上游']);
    // 面板要用的字段仍然齐全（明细页不依赖任何聚合端点）。
    expect(feed.items[0]).toMatchObject({ model: 'gpt-4o-mini', fee_nanos: 4_000, gas_billed_nanos: 4_000 });
  });

  it('聚合页吃时间窗：days=7 只数最近的行，缺省/0 才是全部', async () => {
    const { db } = fixture();
    const get = client(db);

    const recent = await get('/account/usage/by-provider?days=7');
    expect(recent.items).toHaveLength(1);
    expect(recent.items[0]).toMatchObject({ provider_id: 'prv_recent', provider_label: '主力上游', requests: 1 });

    const all = await get('/account/usage/by-provider');
    expect(all.items.map((row: any) => row.provider_id).sort()).toEqual(['prv_old', 'prv_recent']);

    const explicitAll = await get('/account/usage/by-provider?days=0');
    expect(explicitAll.items).toHaveLength(2);

    const byConsumer = await get('/account/usage/by-consumer?days=7');
    expect(byConsumer.items).toEqual([
      expect.objectContaining({ consumer_id: 'con_1', consumer_name: null, requests: 1, fee_nanos: 4_000 }),
    ]);
  });

  it('时间窗按 UUID v7 主键切，不是把整段历史读出来再过滤', async () => {
    const { db, recentId, oldId } = fixture();
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM requests WHERE requests.address = ? AND requests.id > ?')
      .all(ALICE, uuidv7(Date.now() - 7 * DAY_MS - 1)) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('USING PRIMARY KEY'))).toBe(true);
    // 边界本身：20 天前的行落在窗外，刚发生的那条落在窗内。
    expect(oldId < uuidv7(Date.now() - 7 * DAY_MS)).toBe(true);
    expect(recentId > uuidv7(Date.now() - 7 * DAY_MS - 1)).toBe(true);
  });
});
