import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/env';
import { accountRoutes } from '../src/routes/account';
import {
  availableNanos,
  chargeSettlement,
  totalSpendNanos,
  writeSettlement,
  type PrincipalCounters,
  type RequestRecord,
  type Settled,
} from '../src/store';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const ALICE = 'alice-spend-invariant';
const BOB = 'bob-upstream-provider';

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

/** 只覆盖结算两段用到的那几个 D1 方法，跑的是真 SQLite；`meta` 用 SQLite 自己的计数。 */
function d1(db: DatabaseSync): Env['DB'] {
  const written = () => {
    const row = db.prepare('SELECT changes() AS n').get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  };
  return {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({
              results: db.prepare(sql).all(...params) as T[],
              meta: { rows_read: 0, rows_written: written() },
            }),
            run: async () => {
              db.prepare(sql).run(...params);
              return { success: true, meta: { changes: written(), rows_written: written() } };
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
}

/**
 * 结算两段连起来：先扣钱（这一段的行数由 meta 给出），再写请求行。
 *
 * 默认按「不欠费」结算（`allowOverdraft = false`）：下面这些用例验证的是「扣不满就少扣、
 * 绝不凭空增发」这条不变量。测试期线上跑的是 `ALLOW_OVERDRAFT = true`，那条路的用例单列。
 */
async function settle(env: Env, row: RequestRecord, allowOverdraft = false): Promise<Settled> {
  const charge = await chargeSettlement(env, row, allowOverdraft);
  return writeSettlement(env, row, charge);
}

let sequence = 0;

function record(
  address: string,
  options: { gasFeeNanos: number; tokenNanos?: number; providerUser?: string | null },
): RequestRecord {
  sequence += 1;
  const tokenNanos = options.tokenNanos ?? 0;
  return {
    requestId: `01930000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    address,
    providerId: 'prv_fixture',
    providerUser: options.providerUser === undefined ? address : options.providerUser,
    consumerUser: address,
    consumerId: 'con_fixture',
    baseUrl: 'https://api.example.com/v1',
    model: 'fixture-model',
    status: 'ok',
    statusCode: 200,
    latencyMs: 1,
    firstTokenMs: null,
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 50,
    audioMs: 0,
    audioCharacters: 0,
    imageCount: 0,
    imagePixels: 0,
    gasFeeNanos: options.gasFeeNanos,
    tokenNanos,
    feeNanos: 0,
    unbilledNanos: 0,
    at: 1_700_000_000 + sequence,
  };
}

function sumOf(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { total: number }).total;
}

function countersOf(db: DatabaseSync, address: string): PrincipalCounters {
  return db
    .prepare(
      'SELECT recharge_nanos, voucher_nanos, earn_nanos, gas_spend_nanos, token_spend_nanos, withdraw_nanos FROM principals WHERE address = ?',
    )
    .get(address) as PrincipalCounters;
}

describe('Gas 与 Token 分开结算及价值守恒不变量', () => {
  it('调用自己的上游：Token 费按真价记成自转自，余额只减 Gas', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
      ALICE,
      1_700_000_000,
      10_000,
    );

    const env = { DB: d1(db) } as unknown as Env;
    // 调用自有上游不是免费：Token 费按真价记进两本账（自己转给上游=自己），
    // 余额净额只减 Gas——这里传 50,000 纳的 Token 价值，账本必须留下它。
    const settled = await settle(env, record(ALICE, { gasFeeNanos: 2_420, tokenNanos: 50_000, providerUser: ALICE }));
    expect(settled).toEqual({
      billedNanos: 52_420,
      gasBilledNanos: 2_420,
      tokenBilledNanos: 50_000,
      unbilledNanos: 0,
      balanceNanos: 7_580,
    });

    const alice = countersOf(db, ALICE);
    expect(alice.gas_spend_nanos).toBe(2_420);
    // 自转自：花掉的 Token 价值与记回的 Upstream 收入同额，余额里互相抵消。
    expect(alice.token_spend_nanos).toBe(50_000);
    expect(alice.earn_nanos).toBe(50_000);
    expect(totalSpendNanos(alice)).toBe(52_420);
    // 余额只减 Gas：10,000 − 2,420。
    expect(availableNanos(alice)).toBe(7_580);

    const row = db
      .prepare('SELECT gas_fee_nanos, gas_billed_nanos, token_nanos, token_billed_nanos, fee_nanos, unbilled_nanos, earn_before_nanos, earn_after_nanos FROM requests WHERE address = ?')
      .get(ALICE) as Record<string, number>;
    expect(row).toEqual({
      gas_fee_nanos: 2_420,
      gas_billed_nanos: 2_420,
      token_nanos: 50_000,
      token_billed_nanos: 50_000,
      fee_nanos: 52_420,
      unbilled_nanos: 0,
      earn_before_nanos: 0,
      earn_after_nanos: 50_000,
    });
  });

  it('自有上游的 Token 费不占用余额：余额为 0 也照样按真价记满', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    // 一个一分钱都没有的账户：Gas 收不上来（如实记 unbilled），但自转自的 Token 价值照记。
    db.prepare('INSERT INTO principals (address, created_at) VALUES (?, ?)').run(ALICE, 1_700_000_000);

    const env = { DB: d1(db) } as unknown as Env;
    const settled = await settle(env, record(ALICE, { gasFeeNanos: 2_420, tokenNanos: 30_000, providerUser: ALICE }));
    expect(settled).toEqual({
      billedNanos: 30_000,
      gasBilledNanos: 0,
      tokenBilledNanos: 30_000,
      unbilledNanos: 2_420,
      balanceNanos: 0,
    });

    const alice = countersOf(db, ALICE);
    expect(alice.token_spend_nanos).toBe(30_000);
    expect(alice.earn_nanos).toBe(30_000);
    expect(availableNanos(alice)).toBe(0);
  });

  it('调用他人上游：Gas 付给 Norm，Token 等额转入上游提供方的 earn_nanos', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
      ALICE,
      1_700_000_000,
      100_000,
    );
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos) VALUES (?, ?, ?)').run(
      BOB,
      1_700_000_000,
      50_000,
    );

    const env = { DB: d1(db) } as unknown as Env;
    const first = await settle(env, record(ALICE, { gasFeeNanos: 3_420, tokenNanos: 12_000, providerUser: BOB }));
    expect(first).toEqual({
      billedNanos: 15_420,
      gasBilledNanos: 3_420,
      tokenBilledNanos: 12_000,
      unbilledNanos: 0,
      balanceNanos: 84_580,
    });

    const second = await settle(env, record(ALICE, { gasFeeNanos: 3_420, tokenNanos: 8_000, providerUser: BOB }));
    expect(second).toEqual({
      billedNanos: 11_420,
      gasBilledNanos: 3_420,
      tokenBilledNanos: 8_000,
      unbilledNanos: 0,
      balanceNanos: 73_160,
    });

    // 失败调用（tokenNanos = 0）：只扣 Gas，Bob 收入不变。
    const failed = await settle(env, record(ALICE, { gasFeeNanos: 2_420, tokenNanos: 0, providerUser: BOB }));
    expect(failed.gasBilledNanos).toBe(2_420);
    expect(failed.tokenBilledNanos).toBe(0);

    const alice = countersOf(db, ALICE);
    const bob = countersOf(db, BOB);
    expect(alice.gas_spend_nanos).toBe(3_420 + 3_420 + 2_420);
    expect(alice.token_spend_nanos).toBe(20_000);
    expect(bob.earn_nanos).toBe(20_000);
    expect(availableNanos(bob)).toBe(50_000 + 20_000);

    // 验证 Bob 的 earn_before / earn_after 收入链连续且无断层
    const earnRows = db
      .prepare('SELECT token_billed_nanos, earn_before_nanos, earn_after_nanos FROM requests WHERE provider_user = ? AND token_billed_nanos > 0 ORDER BY id ASC')
      .all(BOB) as Array<{ token_billed_nanos: number; earn_before_nanos: number; earn_after_nanos: number }>;
    expect(earnRows).toEqual([
      { token_billed_nanos: 12_000, earn_before_nanos: 0, earn_after_nanos: 12_000 },
      { token_billed_nanos: 8_000, earn_before_nanos: 12_000, earn_after_nanos: 20_000 },
    ]);

    // 全站价值守恒：总投入 − 总剩余余额 = Norm 实收 Gas，Token 净流失为 0！
    const totalIn = alice.recharge_nanos + alice.voucher_nanos + bob.recharge_nanos + bob.voucher_nanos;
    const totalAvail = availableNanos(alice) + availableNanos(bob);
    const totalGas = alice.gas_spend_nanos + bob.gas_spend_nanos;
    expect(totalIn - totalAvail).toBe(totalGas);
    expect(sumOf(db, 'SELECT COALESCE(SUM(earn_nanos), 0) AS total FROM principals')).toBe(
      sumOf(db, 'SELECT COALESCE(SUM(token_spend_nanos), 0) AS total FROM principals'),
    );
  });

  it('余额不足时优先扣 Gas、余下扣 Token，上游只收到实扣额（绝不凭空增发）', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
      ALICE,
      1_700_000_000,
      5_000,
    );
    db.prepare('INSERT INTO principals (address, created_at) VALUES (?, ?)').run(BOB, 1_700_000_000);

    const env = { DB: d1(db) } as unknown as Env;
    // 余额 5,000：Gas 3,420 优先全扣，剩下 1,580 扣作 Token 并转给 Bob，差额 8,420 记 unbilled。
    const partial = await settle(env, record(ALICE, { gasFeeNanos: 3_420, tokenNanos: 10_000, providerUser: BOB }));
    expect(partial).toEqual({
      billedNanos: 5_000,
      gasBilledNanos: 3_420,
      tokenBilledNanos: 1_580,
      unbilledNanos: 8_420,
      balanceNanos: 0,
    });

    // 余额归零后再来一笔：实扣 0、Bob 收到 0，余额不为负。
    const zero = await settle(env, record(ALICE, { gasFeeNanos: 3_420, tokenNanos: 2_000, providerUser: BOB }));
    expect(zero).toEqual({
      billedNanos: 0,
      gasBilledNanos: 0,
      tokenBilledNanos: 0,
      unbilledNanos: 5_420,
      balanceNanos: 0,
    });

    const alice = countersOf(db, ALICE);
    const bob = countersOf(db, BOB);
    expect(availableNanos(alice)).toBe(0);
    expect(totalSpendNanos(alice)).toBe(5_000);
    expect(bob.earn_nanos).toBe(1_580);
    expect(availableNanos(bob)).toBe(1_580);

    // /stats 与 requests 逐纳对齐
    expect(sumOf(db, 'SELECT COALESCE(SUM(fee_nanos), 0) AS total FROM requests')).toBe(5_000);
    expect(sumOf(db, 'SELECT COALESCE(SUM(gas_spend_nanos + token_spend_nanos), 0) AS total FROM principals')).toBe(5_000);
    expect(sumOf(db, 'SELECT COALESCE(SUM(gas_spend_nanos), 0) AS total FROM principals')).toBe(
      sumOf(db, 'SELECT COALESCE(SUM(gas_billed_nanos), 0) AS total FROM requests'),
    );
    expect(sumOf(db, 'SELECT COALESCE(SUM(token_spend_nanos), 0) AS total FROM principals')).toBe(
      sumOf(db, 'SELECT COALESCE(SUM(token_billed_nanos), 0) AS total FROM requests'),
    );
    expect(sumOf(db, 'SELECT COALESCE(SUM(earn_nanos), 0) AS total FROM principals')).toBe(
      sumOf(db, 'SELECT COALESCE(SUM(token_billed_nanos), 0) AS total FROM requests WHERE provider_user <> address'),
    );
  });

  it('测试期允许欠费：余额不足也全额扣，余额变负、上游照收全额', async () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare('INSERT INTO principals (address, created_at, recharge_nanos) VALUES (?, ?, ?)').run(
      ALICE,
      1_700_000_000,
      5_000,
    );
    db.prepare('INSERT INTO principals (address, created_at) VALUES (?, ?)').run(BOB, 1_700_000_000);

    const env = { DB: d1(db) } as unknown as Env;
    // 欠费打开：Gas 3,420 与 Token 10,000 全额记账，余额 5,000 → −8,420，unbilled 恒为 0。
    const overdrawn = await settle(env, record(ALICE, { gasFeeNanos: 3_420, tokenNanos: 10_000, providerUser: BOB }), true);
    expect(overdrawn).toEqual({
      billedNanos: 13_420,
      gasBilledNanos: 3_420,
      tokenBilledNanos: 10_000,
      unbilledNanos: 0,
      balanceNanos: -8_420,
    });

    const alice = countersOf(db, ALICE);
    const bob = countersOf(db, BOB);
    expect(availableNanos(alice)).toBe(-8_420);
    // 价值守恒仍然成立：扣到的 Token 费一分不少地转给了上游。
    expect(bob.earn_nanos).toBe(10_000);
  });

  it('迁移 0023 对历史数据回填准确，且 account 路由准确分开展示 Gas、Token 与上游收入', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
    const before0023 = files.filter((name) => name < '0023_');
    const migration0023 = files.find((name) => name.startsWith('0023_'));
    expect(migration0023).toBeDefined();

    for (const file of before0023) {
      db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }

    // 构造 0022 时代的历史账户与历史跨用户请求（含一笔余额不足部分扣费）
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos, spend_nanos) VALUES (?, ?, ?, ?)').run(
      ALICE,
      1_700_000_000,
      1_000_000,
      17_420,
    );
    db.prepare('INSERT INTO principals (address, created_at, voucher_nanos, spend_nanos) VALUES (?, ?, ?, ?)').run(
      BOB,
      1_700_000_000,
      1_000_000,
      0,
    );
    db.prepare(
      `INSERT INTO providers (id, address, label, base_url, key_hint, sealed_key, kdf, protocol, scope, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pool', 1, ?)`,
    ).run('prv_bob_pool', BOB, 'Bob Pool', 'https://api.openai.com/v1', 'sk-b…ob', 'sealed', 'aes-256-gcm', 'openai-chat', 1_700_000_000);
    db.prepare(
      `INSERT INTO requests
         (id, address, provider_id, provider_user, consumer_id, consumer_user, base_url, model, status, status_code, latency_ms,
          input_tokens, cached_tokens, output_tokens, gas_fee_nanos, token_nanos, fee_nanos, unbilled_nanos,
          spend_before_nanos, spend_after_nanos, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', 200, 100, 100, 20, 50, 2420, 10000, 12420, 0, 0, 12420, 1700000001),
              (?, ?, ?, ?, ?, ?, ?, ?, 'ok', 200, 120, 80, 0, 40, 2420, 8000, 5000, 5420, 12420, 17420, 1700000002)`,
    ).run(
      '01930000-0000-7000-8000-000000000001',
      ALICE,
      'prv_bob_pool',
      BOB,
      null,
      null,
      'https://api.openai.com/v1',
      'gpt-4o-mini',
      '01930000-0000-7000-8000-000000000002',
      ALICE,
      'prv_bob_pool',
      BOB,
      null,
      null,
      'https://api.openai.com/v1',
      'gpt-4o-mini',
    );

    // 应用迁移 0023
    db.exec(readFileSync(join(MIGRATIONS, migration0023!), 'utf8'));

    const alice = countersOf(db, ALICE);
    const bob = countersOf(db, BOB);
    // 第 1 笔全额：gas 2420 + token 10000；第 2 笔余额不足：先扣 gas 2420，剩下 2580 扣作 token。
    expect(alice.gas_spend_nanos).toBe(4_840);
    expect(alice.token_spend_nanos).toBe(12_580);
    expect(totalSpendNanos(alice)).toBe(17_420);
    expect(bob.earn_nanos).toBe(12_580);
    expect(availableNanos(bob)).toBe(1_012_580);

    // 通过 Hono accountRoutes 验证 /me、/earnings 与 /usage/by-provider 返回结构
    const { Hono } = await import('hono');
    const makeApp = (address: string) => {
      const app = new Hono<{ Bindings: Env; Variables: { principal: { address: string; opened: boolean } } }>();
      app.use('*', async (c, next) => {
        c.set('principal', { address, opened: false });
        await next();
      });
      app.route('/account', accountRoutes);
      return app;
    };

    const env = { DB: d1(db) } as unknown as Env;
    const bobMe = await (await makeApp(BOB).request('https://norm.test/account/me', {}, env)).json() as Record<string, unknown>;
    expect(bobMe.earn_nanos).toBe(12_580);
    expect(bobMe.balance_nanos).toBe(1_012_580);
    expect(bobMe.earned).toEqual({
      requests: 2,
      input_tokens: 180,
      cached_tokens: 20,
      output_tokens: 90,
      token_nanos: 12_580,
    });

    const bobEarnings = await (await makeApp(BOB).request('https://norm.test/account/earnings', {}, env)).json() as {
      items: Array<Record<string, unknown>>;
    };
    expect(bobEarnings.items).toHaveLength(2);
    // 倒序：最新一笔是第 2 笔（token_billed = 2580, earn 10000 -> 12580）
    expect(bobEarnings.items[0]).toMatchObject({
      consumer_address: ALICE,
      provider_label: 'Bob Pool',
      token_billed_nanos: 2_580,
      earn_before_nanos: 10_000,
      earn_after_nanos: 12_580,
    });
    expect(bobEarnings.items[1]).toMatchObject({
      consumer_address: ALICE,
      token_billed_nanos: 10_000,
      earn_before_nanos: 0,
      earn_after_nanos: 10_000,
    });

    const aliceByProvider = await (await makeApp(ALICE).request('https://norm.test/account/usage/by-provider', {}, env)).json() as {
      items: Array<Record<string, unknown>>;
    };
    expect(aliceByProvider.items[0]).toMatchObject({
      provider_id: 'prv_bob_pool',
      is_own: 0,
      gas_fee_nanos: 4_840,
      token_nanos: 12_580,
      fee_nanos: 17_420,
    });
  });
});
