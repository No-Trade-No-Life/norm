import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/env';
import { minBalanceNanos } from '../src/env';
import {
  D1_ROW_WRITES,
  DEFAULT_MIN_BALANCE_NANOS,
  GAS_AFFINITY_UPSERT_NANOS,
  GAS_CONSUMER_TOUCH_NANOS,
  GAS_ENTRY_BASE_NANOS,
  GAS_FLOOR_NANOS,
  GAS_MARGIN_BPS,
  GAS_SCHEDULE,
  GAS_SETTLE_NANOS,
  GasMeter,
  applyGasMargin,
} from '../src/gas';
import {
  consumerKeyHash,
  needsConsumerTouch,
  newConsumerKey,
  principalFromConsumerKey,
  touchConsumer,
} from '../src/consumers';
import { HttpError } from '../src/http';
import {
  dropProviderModel,
  forgetAffinity,
  recordProviderModels,
  rememberAffinity,
  resolveProvider,
} from '../src/store';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

/** 轻量 D1 适配器：跑真 SQLite，同时记录读/写语句次数以验证零计费 Overhead。 */
function spyD1(db: DatabaseSync) {
  let reads = 0;
  let writes = 0;

  type Bound = {
    sql: string;
    params: (string | number | null)[];
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  };

  const makeBound = (sql: string, params: (string | number | null)[]): Bound => ({
    sql,
    params,
    first: async <T>() => {
      reads += 1;
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async <T>() => {
      reads += 1;
      return { results: db.prepare(sql).all(...params) as T[] };
    },
    run: async () => {
      writes += 1;
      const result = db.prepare(sql).run(...params) as { changes?: number | bigint } | undefined;
      return { success: true, meta: { changes: Number(result?.changes ?? 0) } };
    },
  });

  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return makeBound(sql, params);
        },
      };
    },
    async batch(statements: Bound[]) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  } as unknown as Env['DB'];

  return {
    DB,
    counts: () => ({ reads, writes }),
    resetCounts: () => {
      reads = 0;
      writes = 0;
    },
  };
}

describe('GasMeter 动态累加与四条硬约束', () => {
  it('起步价与稳态/当日首次/跨方言/流式/写亲和各路径金额精确匹配列表价', () => {
    expect(GAS_SCHEDULE.worker_invocation).toBe(300);
    expect(GAS_SCHEDULE.log_event).toBe(10);
    expect(GAS_SCHEDULE.read_subsidy).toBe(0);
    expect(GAS_MARGIN_BPS).toBe(0);
    expect(GAS_ENTRY_BASE_NANOS).toBe(420);
    expect(GAS_SETTLE_NANOS).toBe(2_000);
    expect(GAS_AFFINITY_UPSERT_NANOS).toBe(1_000);
    expect(GAS_FLOOR_NANOS).toBe(2_420);
    expect(DEFAULT_MIN_BALANCE_NANOS).toBe(10_000);

    // 1. 稳态同日直通、非流式、无写亲和：420 + 2,000 = 2,420
    const steady = new GasMeter({ availableNanos: 100_000 });
    expect(steady.finalizeForSettlement()).toBe(2_420);
    expect(steady.finalTotal()).toBe(2_420);

    // 2. 同日直通 + 流式：2,420 + 60 = 2,480
    const steadyStream = new GasMeter({ availableNanos: 100_000 });
    steadyStream.charge(GAS_SCHEDULE.cpu_stream);
    expect(steadyStream.finalizeForSettlement()).toBe(2_480);

    // 3. 同日跨方言桥接 + 非流式：2,420 + 100 = 2,520
    const bridge = new GasMeter({ availableNanos: 100_000 });
    bridge.charge(GAS_SCHEDULE.cpu_bridge);
    expect(bridge.finalizeForSettlement()).toBe(2_520);

    // 4. 跨方言桥接 + 流式 + 当日首次 touch（1 行）+ 首次写亲和（WITHOUT ROWID 1 行）：
    //    420 + 1,000 + 100 + 60 + 1,000 + 2,000 = 4,580
    const fullFirst = new GasMeter({ availableNanos: 10_000 });
    expect(fullFirst.canStart()).toBe(true);
    fullFirst.chargeD1Writes(D1_ROW_WRITES.affinity_upsert);
    fullFirst.charge(GAS_SCHEDULE.cpu_bridge + GAS_SCHEDULE.cpu_stream);
    fullFirst.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    expect(fullFirst.finalizeForSettlement()).toBe(4_580);
  });

  it('约束 1：结算冻结后禁止再追加计费或重复结算，未冻结前禁止读最终值', () => {
    const gas = new GasMeter({ availableNanos: 50_000 });
    expect(() => gas.finalTotal()).toThrow();

    const total = gas.finalizeForSettlement();
    expect(total).toBe(GAS_FLOOR_NANOS);
    expect(gas.isFinalized).toBe(true);

    expect(() => gas.charge(100)).toThrow();
    expect(() => gas.chargeD1Writes(1)).toThrow();
    expect(() => gas.finalizeForSettlement()).toThrow();
  });

  it('约束 2：毛利倍数向上取整，绝不向下截断少收', () => {
    expect(applyGasMargin(2_420, 0)).toBe(2_420);
    // +10%（1,000 bps）：2,420 × 1.1 = 2,662
    expect(applyGasMargin(2_420, 1_000)).toBe(2_662);
    // 出现小数时向上取整：1 × 1.0001 = 1.0001 → 2
    expect(applyGasMargin(1, 1)).toBe(2);
  });

  it('约束 3：入口安全阈值（闸门 A）与预算检查（闸门 B/C）提前拒绝省费', () => {
    const low = new GasMeter({ availableNanos: 9_999 });
    expect(low.canStart()).toBe(false);

    // 即使部署变量把 MIN_BALANCE_NANOS 设得比最低执行 Gas 还低，也会被抬到 GAS_FLOOR_NANOS
    expect(minBalanceNanos({ MIN_BALANCE_NANOS: '500' } as Env)).toBe(GAS_FLOOR_NANOS);
    expect(minBalanceNanos({ MIN_BALANCE_NANOS: '15000' } as Env)).toBe(15_000);
    expect(minBalanceNanos({} as Env)).toBe(DEFAULT_MIN_BALANCE_NANOS);

    // 闸门 C：余额不够覆盖「删模型(3行) + 删亲和(1行) + 二次 CPU + 结算(2行)」时放弃重试
    const tight = new GasMeter({ availableNanos: 6_000 });
    tight.chargeD1Writes(D1_ROW_WRITES.consumer_touch); // 420 + 1,000 = 1,420
    const retryEstimate =
      (D1_ROW_WRITES.provider_model_delete + D1_ROW_WRITES.affinity_delete) * GAS_SCHEDULE.d1_row_write +
      GAS_SCHEDULE.cpu_base +
      GAS_SETTLE_NANOS;
    // 1,420 + 4,000 + 100 + 2,000 = 7,520 > 6,000 → 放弃重试
    expect(tight.canAfford(retryEstimate)).toBe(false);
    // 结算本次第 1 次失败（1,420 + 2,000 = 3,420 <= 6,000）完全付得起
    expect(tight.canAfford(GAS_SETTLE_NANOS)).toBe(true);
  });

  it('consumers.last_used_at 按 UTC 自然日节流：从未用过或跨日才写', () => {
    const dayStart = 20_000 * 86_400; // 某个 UTC 00:00:00
    expect(needsConsumerTouch(null, dayStart)).toBe(true);
    expect(needsConsumerTouch(dayStart, dayStart + 1)).toBe(false);
    expect(needsConsumerTouch(dayStart, dayStart + 86_399)).toBe(false);
    expect(needsConsumerTouch(dayStart, dayStart + 86_400)).toBe(true);
  });
});

describe('D1 WITHOUT ROWID、零额外 Overhead 与集合 diff 验证', () => {
  it('迁移 0022：requests 与 affinities 均为 WITHOUT ROWID 且 0 二级索引，查询直走聚簇主键', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);

    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('requests', 'affinities')")
      .all() as Array<{ name: string; sql: string }>;
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.sql.toUpperCase()).toContain('WITHOUT ROWID');
    }

    // 显式二级索引必须为 0（sqlite_autoindex_ 不会在 WITHOUT ROWID 上产生额外二级索引）
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('requests', 'affinities')")
      .all() as Array<{ name: string }>;
    expect(indexes).toEqual([]);

    const reqPlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM requests WHERE address = ? AND id < ? ORDER BY id DESC LIMIT 50')
      .all('addr', '019') as Array<{ detail: string }>;
    expect(reqPlan.some((row) => row.detail.includes('USING PRIMARY KEY'))).toBe(true);

    const affPlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT provider_id, expires_at FROM affinities WHERE address = ? AND affinity_hash = ?')
      .all('addr', 'hash') as Array<{ detail: string }>;
    expect(affPlan.some((row) => row.detail.includes('USING PRIMARY KEY'))).toBe(true);
  });

  it('鉴权单次 JOIN 读余额与 last_used_at 且 0 D1 写；确认执行时 touchConsumer 才写 1 行', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB } as unknown as Env;

    const address = 'gas-auth-fixture';
    const key = newConsumerKey();
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos) VALUES (?, ?, ?)').run(
      address,
      1_700_000_000,
      25_000,
    );
    db.prepare(
      'INSERT INTO consumers (id, address, name, key_sha256, key_hint, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('con_1', address, 'bot', consumerKeyHash(key), 'sk-norm-1…1', 1_700_000_000);

    spy.resetCounts();
    const principal = await principalFromConsumerKey(env, key);
    expect(principal).toEqual({
      address,
      consumerId: 'con_1',
      balanceNanos: 25_000,
      consumerLastUsedAt: null,
    });
    expect(spy.counts()).toEqual({ reads: 1, writes: 0 });

    await touchConsumer(env, 'con_1');
    expect(spy.counts()).toEqual({ reads: 1, writes: 1 });
    const after = await principalFromConsumerKey(env, key);
    expect(typeof after.consumerLastUsedAt).toBe('number');
  });

  it('闸门 B：余额不够写亲和 + 后续必经成本时直接 402 中止且 0 行写入 affinities', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB, AFFINITY_TTL_SECONDS: '3600' } as unknown as Env;

    const address = 'gas-affinity-gate';
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos) VALUES (?, ?, ?)').run(
      address,
      1_700_000_000,
      3_000,
    );
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 1, ?)`,
    ).run('prv_1', address, 'p1', 'https://api.openai.com/v1', 'sk-a…z', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);

    // 余额 3,000：虽大于稳态最低 Gas 2,420，但写亲和(1,000) + touch(1,000) + settle(2,000) = 4,420 > 3,000
    const gas = new GasMeter({ availableNanos: 3_000, minBalanceNanos: GAS_FLOOR_NANOS });
    spy.resetCounts();
    let caught: unknown;
    try {
      await resolveProvider(env, address, { source: 'thread-id', value: 'thread-abc' }, {
        gas,
        pendingRequiredNanos: GAS_CONSUMER_TOUCH_NANOS + GAS_SETTLE_NANOS,
        abortOnInsufficientBalance: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(402);
    expect((caught as HttpError).code).toBe('insufficient_balance');
    expect(spy.counts().writes).toBe(0);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM affinities').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('rememberAffinity 单次 1 行写（不顺手删过期行），forgetAffinity 与 dropProviderModel 准确返回 changes', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB, AFFINITY_TTL_SECONDS: '3600' } as unknown as Env;

    const address = 'gas-affinity-without-rowid';
    const now = 1_700_010_000;
    db.prepare(
      'INSERT INTO affinities (address, affinity_hash, provider_id, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(address, 'expired_0', 'prv_1', now - 100, now - 200);

    spy.resetCounts();
    await rememberAffinity(env, address, 'fresh_hash', 'prv_1', now);
    // 严格 1 条写入语句，不顺手扫删旧过期行
    expect(spy.counts()).toEqual({ reads: 0, writes: 1 });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM affinities WHERE address = ?').get(address) as { n: number }).n;
    expect(count).toBe(2);

    db.prepare('INSERT INTO provider_models (provider_id, model, fetched_at) VALUES (?, ?, ?)').run('prv_1', 'gpt-test', now);
    expect(await dropProviderModel(env, 'prv_1', 'gpt-test')).toBe(1);
    expect(await dropProviderModel(env, 'prv_1', 'gpt-test')).toBe(0);
    expect(await forgetAffinity(env, address, 'fresh_hash')).toBe(1);
    expect(await forgetAffinity(env, address, 'fresh_hash')).toBe(0);
  });

  it('recordProviderModels 按集合 diff 更新：清单未变时 0 次 D1 写，仅变更增删行', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB } as unknown as Env;

    const address = 'model-diff-fixture';
    db.prepare('INSERT INTO principals (address, created_at) VALUES (?, ?)').run(address, 1_700_000_000);
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 1, ?)`,
    ).run('prv_m', address, 'p', 'https://api.openai.com/v1', 'sk-a…z', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);

    // 首次同步：3 个模型全部写入
    spy.resetCounts();
    const first = await recordProviderModels(env, 'prv_m', ['m-a', 'm-b', 'm-c'], 1_700_000_100);
    expect(first).toEqual({ added: 3, removed: 0 });
    expect(spy.counts().writes).toBe(2); // 1 batch INSERT + 1 UPDATE models_fetched_at

    // 清单未变再次同步：严格 0 次 D1 写
    spy.resetCounts();
    const same = await recordProviderModels(env, 'prv_m', ['m-c', 'm-a', 'm-b'], 1_700_000_200);
    expect(same).toEqual({ added: 0, removed: 0 });
    expect(spy.counts().writes).toBe(0);

    // 下线 m-b、新增 m-d：只删 1、只插 1
    spy.resetCounts();
    const changed = await recordProviderModels(env, 'prv_m', ['m-a', 'm-c', 'm-d'], 1_700_000_300);
    expect(changed).toEqual({ added: 1, removed: 1 });
    const stored = (
      db.prepare('SELECT model FROM provider_models WHERE provider_id = ? ORDER BY model').all('prv_m') as Array<{
        model: string;
      }>
    ).map((r) => r.model);
    expect(stored).toEqual(['m-a', 'm-c', 'm-d']);
  });

  it('纯读模式（readOnly: true）绝不「读导致写」：命中亲和沿用，未命中不写 affinities', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB, AFFINITY_TTL_SECONDS: '3600' } as unknown as Env;

    const address = 'pure-read-fixture';
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos) VALUES (?, ?, ?)').run(
      address,
      1_700_000_000,
      100_000,
    );
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 1, ?)`,
    ).run('prv_ro', address, 'p1', 'https://api.openai.com/v1', 'sk-a…z', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);

    spy.resetCounts();
    const choice = await resolveProvider(env, address, { source: 'thread-id', value: 'thread-readonly' }, {
      readOnly: true,
    });
    expect(choice.provider.id).toBe('prv_ro');
    expect(choice.sticky).toBe(false);
    expect(spy.counts().writes).toBe(0);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM affinities').get() as { n: number }).n;
    expect(rows).toBe(0);
  });
});
