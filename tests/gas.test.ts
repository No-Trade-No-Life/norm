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
import { consumerKeyHash, newConsumerKey, principalFromConsumerKey, touchConsumer } from '../src/consumers';
import { HttpError } from '../src/http';
import { dropProviderModel, forgetAffinity, rememberAffinity, resolveProvider } from '../src/store';

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
  it('起步价与稳态/跨方言/流式/写亲和各路径金额精确匹配列表价', () => {
    expect(GAS_SCHEDULE.worker_invocation).toBe(300);
    expect(GAS_MARGIN_BPS).toBe(0);
    expect(GAS_ENTRY_BASE_NANOS).toBe(1_730);
    expect(GAS_FLOOR_NANOS).toBe(6_730);
    expect(DEFAULT_MIN_BALANCE_NANOS).toBe(10_000);

    // 1. 普通同方言直通、非流式、无写亲和：1,730 + 1,000 + 4,000 = 6,730
    const passthrough = new GasMeter({ availableNanos: 100_000 });
    passthrough.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    expect(passthrough.finalizeForSettlement()).toBe(6_730);
    expect(passthrough.finalTotal()).toBe(6_730);

    // 2. 同方言直通 + 流式：6,730 + 60 = 6,790
    const passthroughStream = new GasMeter({ availableNanos: 100_000 });
    passthroughStream.charge(GAS_SCHEDULE.cpu_stream);
    passthroughStream.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    expect(passthroughStream.finalizeForSettlement()).toBe(6_790);

    // 3. 跨方言桥接 + 非流式：6,730 + 100 = 6,830
    const bridge = new GasMeter({ availableNanos: 100_000 });
    bridge.charge(GAS_SCHEDULE.cpu_bridge);
    bridge.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    expect(bridge.finalizeForSettlement()).toBe(6_830);

    // 4. 跨方言桥接 + 流式 + 首次写亲和（3 行写）：6,890 + 3,000 = 9,890（刚好 <= 10,000）
    const bridgeStreamAffinity = new GasMeter({ availableNanos: 10_000 });
    expect(bridgeStreamAffinity.canStart()).toBe(true);
    bridgeStreamAffinity.chargeD1Writes(D1_ROW_WRITES.affinity_upsert);
    bridgeStreamAffinity.charge(GAS_SCHEDULE.cpu_bridge + GAS_SCHEDULE.cpu_stream);
    bridgeStreamAffinity.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    expect(bridgeStreamAffinity.finalizeForSettlement()).toBe(9_890);
  });

  it('约束 1：结算冻结后禁止再追加计费或重复结算，未冻结前禁止读最终值', () => {
    const gas = new GasMeter({ availableNanos: 50_000 });
    expect(() => gas.finalTotal()).toThrow();

    gas.chargeD1Writes(D1_ROW_WRITES.consumer_touch);
    const total = gas.finalizeForSettlement();
    expect(total).toBe(GAS_FLOOR_NANOS);
    expect(gas.isFinalized).toBe(true);

    expect(() => gas.charge(100)).toThrow();
    expect(() => gas.chargeD1Writes(1)).toThrow();
    expect(() => gas.finalizeForSettlement()).toThrow();
  });

  it('约束 2：毛利倍数向上取整，绝不向下截断少收', () => {
    expect(applyGasMargin(6_730, 0)).toBe(6_730);
    // +10%（1,000 bps）：6,730 × 1.1 = 7,403
    expect(applyGasMargin(6_730, 1_000)).toBe(7_403);
    // 出现小数时向上取整：1 × 1.0001 = 1.0001 → 2
    expect(applyGasMargin(1, 1)).toBe(2);
  });

  it('约束 3：入口安全阈值（闸门 A）与预算检查（闸门 B/C）提前拒绝省费', () => {
    // 余额 9,999 < 10,000 → 闸门 A 直接拒绝
    const low = new GasMeter({ availableNanos: 9_999 });
    expect(low.canStart()).toBe(false);

    // 即使部署变量把 MIN_BALANCE_NANOS 设得比最低执行 Gas 还低，也会被抬到 GAS_FLOOR_NANOS
    expect(minBalanceNanos({ MIN_BALANCE_NANOS: '500' } as Env)).toBe(GAS_FLOOR_NANOS);
    expect(minBalanceNanos({ MIN_BALANCE_NANOS: '15000' } as Env)).toBe(15_000);
    expect(minBalanceNanos({} as Env)).toBe(DEFAULT_MIN_BALANCE_NANOS);

    // 闸门 C：第 1 次执行后余钱不够覆盖「删模型 + 删亲和 + 二次 CPU + 结算」则拒绝重试
    const tight = new GasMeter({ availableNanos: 10_000 });
    tight.chargeD1Writes(D1_ROW_WRITES.consumer_touch); // 1,730 + 1,000 = 2,730
    const retryEstimate =
      (D1_ROW_WRITES.provider_model_delete + D1_ROW_WRITES.affinity_delete) * GAS_SCHEDULE.d1_row_write +
      GAS_SCHEDULE.cpu_base +
      GAS_SETTLE_NANOS;
    // 2,730 + 6,000 + 100 + 4,000 = 12,830 > 10,000 → 放弃重试
    expect(tight.canAfford(retryEstimate)).toBe(false);
    // 但结算本次第 1 次失败（2,730 + 4,000 = 6,730 <= 10,000）完全付得起
    expect(tight.canAfford(GAS_SETTLE_NANOS)).toBe(true);
  });
});

describe('D1 零额外 Overhead 与写亲和/重试真实行写计量', () => {
  it('鉴权单次 JOIN 读余额且 0 D1 写；确认执行时 touchConsumer 才写 1 行', async () => {
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
    expect(principal).toEqual({ address, consumerId: 'con_1', balanceNanos: 25_000 });
    // 1 次 JOIN 读、0 次写：被拒请求不再白写 last_used_at
    expect(spy.counts()).toEqual({ reads: 1, writes: 0 });
    const untouched = db.prepare('SELECT last_used_at FROM consumers WHERE id = ?').get('con_1') as {
      last_used_at: number | null;
    };
    expect(untouched.last_used_at).toBeNull();

    await touchConsumer(env, 'con_1');
    expect(spy.counts()).toEqual({ reads: 1, writes: 1 });
    const touched = db.prepare('SELECT last_used_at FROM consumers WHERE id = ?').get('con_1') as {
      last_used_at: number | null;
    };
    expect(typeof touched.last_used_at).toBe('number');
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
      8_000,
    );
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 1, ?)`,
    ).run('prv_1', address, 'p1', 'https://api.openai.com/v1', 'sk-a…z', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);

    // 余额 8,000：虽大于最低 Gas 6,730，但写亲和后需要 1,730 + 3,000 + 1,000 + 4,000 = 9,730 > 8,000
    const gas = new GasMeter({ availableNanos: 8_000, minBalanceNanos: GAS_FLOOR_NANOS });
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
    // 提前中止：0 次写入，affinities 表仍为空
    expect(spy.counts().writes).toBe(0);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM affinities').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('rememberAffinity 单次最多清理 2 条过期行并准确返回删除行数供 GasMeter 入账', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const spy = spyD1(db);
    const env = { DB: spy.DB, AFFINITY_TTL_SECONDS: '3600' } as unknown as Env;

    const address = 'gas-affinity-gc';
    const now = 1_700_010_000;
    for (let i = 0; i < 5; i += 1) {
      db.prepare(
        'INSERT INTO affinities (affinity_hash, address, provider_id, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(`expired_${i}`, address, 'prv_1', now - 100, now - 200);
    }

    const deleted = await rememberAffinity(env, address, 'fresh_hash', 'prv_1', now);
    expect(deleted).toBe(2);
    // 原本 5 条过期，删 2 条 + 新增 1 条 = 4 条
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM affinities WHERE address = ?').get(address) as { n: number }).n;
    expect(remaining).toBe(4);

    // 验证 dropProviderModel 与 forgetAffinity 准确回传 changes（有删 1、无删 0）
    db.prepare('INSERT INTO provider_models (provider_id, model, fetched_at) VALUES (?, ?, ?)').run('prv_1', 'gpt-test', now);
    expect(await dropProviderModel(env, 'prv_1', 'gpt-test')).toBe(1);
    expect(await dropProviderModel(env, 'prv_1', 'gpt-test')).toBe(0);
    expect(await forgetAffinity(env, address, 'fresh_hash')).toBe(1);
    expect(await forgetAffinity(env, address, 'fresh_hash')).toBe(0);

    // 对应 Gas 增量检查
    expect(GAS_AFFINITY_UPSERT_NANOS).toBe(3_000);
    expect(GAS_SCHEDULE.read_subsidy).toBe(0);
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
    // 严格 0 次写库：GET /v1/models 即使带了 thread-id 也绝不写 affinities
    expect(spy.counts().writes).toBe(0);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM affinities').get() as { n: number }).n;
    expect(rows).toBe(0);
  });
});
