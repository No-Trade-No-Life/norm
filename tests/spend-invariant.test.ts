import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/env';
import { settle, type RequestRecord } from '../src/store';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const ADDRESS = 'spend-invariant-fixture';

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

/** 只覆盖 settle / recordRequest 用到的那几个 D1 方法，跑的是真 SQLite。 */
function d1(db: DatabaseSync): Env['DB'] {
  return {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[] }),
            run: async () => {
              db.prepare(sql).run(...params);
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
}

let sequence = 0;

function record(address: string, dueNanos: number): RequestRecord {
  sequence += 1;
  return {
    requestId: `01930000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    address,
    providerId: null,
    providerUser: null,
    consumerUser: null,
    consumerId: null,
    baseUrl: '',
    model: 'fixture-model',
    status: 'ok',
    statusCode: 200,
    latencyMs: 1,
    firstTokenMs: null,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    gasFeeNanos: dueNanos,
    tokenNanos: 0,
    feeNanos: dueNanos,
    unbilledNanos: 0,
    at: 1_700_000_000 + sequence,
  };
}

function sumOf(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { total: number }).total;
}

describe('累计消费与请求费用是同一笔钱', () => {
  it('足够 / 不足 / 余额为零三种扣费下，SUM(spend_nanos) 都等于 SUM(fee_nanos)', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
      ADDRESS,
      1_700_000_000,
      1000,
    );

    const env = { DB: d1(db) } as unknown as Env;
    // 余额 1000：第一笔收满 100，第二笔只收得到剩下的 900，第三笔一分钱也收不到。
    await settle(env, record(ADDRESS, 100));
    await settle(env, record(ADDRESS, 2000));
    await settle(env, record(ADDRESS, 300));

    const fees = sumOf(db, 'SELECT COALESCE(SUM(fee_nanos), 0) AS total FROM requests');
    const spend = sumOf(db, 'SELECT spend_nanos AS total FROM principals WHERE address = ' + `'${ADDRESS}'`);
    expect(fees).toBe(1000);
    expect(spend).toBe(fees);

    // /stats 换掉的就是这一句：两个来源在夹具数据上逐分相等。
    const legacy = sumOf(db, 'SELECT COALESCE(SUM(fee_nanos), 0) AS total FROM requests');
    const rewritten = sumOf(db, 'SELECT COALESCE(SUM(spend_nanos), 0) AS total FROM principals');
    expect(rewritten).toBe(legacy);
  });
});
