import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { Env } from '../src/env';
import { HttpError } from '../src/http';
import { accountRoutes, FAUCET_DAILY_CAP_NANOS, FAUCET_DRIP_NANOS } from '../src/routes/account';
import { availableNanos, type PrincipalCounters } from '../src/store';

/**
 * 测试期领水：钱只能记在不可提现的抵扣券上，日额度按 UTC 自然日封顶。
 * 这三条是「临时接口」唯一值得钉住的东西——测试完就删，但删之前不能把账记错。
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const ALICE = 'alice-faucet';

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

type Bound = { sql: string; params: (string | number | null)[]; run: () => { changes: number } };

/** 够领水用的 D1 适配器：prepare/bind/first/all/batch，跑真 SQLite。 */
function d1(db: DatabaseSync): Env['DB'] {
  const run = (sql: string, params: (string | number | null)[]) =>
    Number(db.prepare(sql).run(...params).changes ?? 0) as number;
  const bound = (sql: string, params: (string | number | null)[]): Bound => ({
    sql,
    params,
    run: () => ({ changes: run(sql, params) }),
  });
  return {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            ...bound(sql, params),
            first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[] }),
          };
        },
      };
    },
    async batch(statements: Bound[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({ meta: statement.run() }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
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
  // 与 src/index.ts 同一条约定：HttpError 变成 `{error, code}` 的 JSON，而不是 500 纯文本。
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.code, message: error.message }, error.status as 400);
    throw error;
  });
  const env = { DB: d1(db) } as unknown as Env;
  return async () => {
    const response = await app.request('https://norm.test/account/faucet', { method: 'POST' }, env);
    return { status: response.status, body: (await response.json()) as any };
  };
}

function countersOf(db: DatabaseSync): PrincipalCounters {
  return db
    .prepare(
      'SELECT recharge_nanos, voucher_nanos, earn_nanos, gas_spend_nanos, token_spend_nanos, withdraw_nanos FROM principals WHERE address = ?',
    )
    .get(ALICE) as PrincipalCounters;
}

function fixture(seed: { voucher?: number; gasSpend?: number; tokenSpend?: number } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO principals (address, created_at, voucher_nanos, gas_spend_nanos, token_spend_nanos) VALUES (?, ?, ?, ?, ?)',
  ).run(ALICE, 1_700_000_000, seed.voucher ?? 0, seed.gasSpend ?? 0, seed.tokenSpend ?? 0);
  return db;
}

describe('测试期领水', () => {
  it('一次 $1 记成抵扣券，流水上的余额与 availableNanos 同口径', async () => {
    // 账户里已经花过一些钱：流水那一列必须写「更新后」的余额，而不是「这次领了多少」。
    const db = fixture({ voucher: 500_000_000, gasSpend: 120_000 });
    const claim = client(db);

    const first = await claim();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      credited_nanos: FAUCET_DRIP_NANOS,
      balance_nanos: 500_000_000 + FAUCET_DRIP_NANOS - 120_000,
      remaining_nanos: FAUCET_DAILY_CAP_NANOS - FAUCET_DRIP_NANOS,
    });
    expect(availableNanos(countersOf(db))).toBe(first.body.balance_nanos);

    const row = db
      .prepare("SELECT kind, amount_nanos, available_after_nanos, id FROM ledger WHERE address = ? AND id LIKE 'faucet-%'")
      .get(ALICE) as { kind: string; amount_nanos: number; available_after_nanos: number; id: string };
    expect(row.kind).toBe('voucher');
    expect(row.amount_nanos).toBe(FAUCET_DRIP_NANOS);
    expect(row.available_after_nanos).toBe(first.body.balance_nanos);
  });

  it('日额度封顶：领满 $20 之后 429，且一分钱不再入账', async () => {
    const db = fixture();
    const claim = client(db);

    const rounds = FAUCET_DAILY_CAP_NANOS / FAUCET_DRIP_NANOS;
    for (let i = 0; i < rounds; i += 1) {
      const response = await claim();
      expect(response.status).toBe(200);
      expect(response.body.remaining_nanos).toBe(FAUCET_DAILY_CAP_NANOS - (i + 1) * FAUCET_DRIP_NANOS);
    }

    const blocked = await claim();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('faucet_exhausted');
    expect(countersOf(db).voucher_nanos).toBe(FAUCET_DAILY_CAP_NANOS);
  });

  it('日额度按 UTC 自然日重置：昨天领满不影响今天', async () => {
    const db = fixture({ voucher: FAUCET_DAILY_CAP_NANOS });
    // 昨天的领水记录（id 前缀相同，created_at 落在昨天）。
    const now = Math.floor(Date.now() / 1000);
    const dayStart = Math.floor(now / 86_400) * 86_400;
    db.prepare(
      'INSERT INTO ledger (id, address, kind, amount_nanos, available_after_nanos, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('faucet-yesterday', ALICE, 'voucher', FAUCET_DAILY_CAP_NANOS, FAUCET_DAILY_CAP_NANOS, dayStart - 1);

    const response = await client(db)();
    expect(response.status).toBe(200);
    expect(response.body.remaining_nanos).toBe(FAUCET_DAILY_CAP_NANOS - FAUCET_DRIP_NANOS);
  });
});
