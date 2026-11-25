/**
 * 选上游的三条规则：自有优先、会话粘住、rendezvous 摊开。
 *
 * 这些是纯函数，所以能在没有 D1 的地方单测——「候选里谁赢」不该只能靠起一个数据库才验证得了。
 * D1 那一层（亲和表的读写与过期）由 scripts/e2e.mjs 端到端覆盖。
 */
import { describe, expect, it } from 'vitest';

import {
  affinityFresh,
  affinityHash,
  affinityKeyOf,
  narrowToOwned,
  narrowToServingModel,
  pickByRendezvous,
} from '../src/routing';

const headers = (pairs: Record<string, string>) => ({
  get: (name: string) => pairs[name] ?? null,
});

type Candidate = { id: string; address: string };

const mine: Candidate = { id: 'p-mine', address: 'addr-a' };
const alsoMine: Candidate = { id: 'p-mine-2', address: 'addr-a' };
const pooled: Candidate = { id: 'p-pool', address: 'addr-site' };

describe('affinityKeyOf', () => {
  it('thread-id 压过 session-id', () => {
    expect(affinityKeyOf(headers({ 'thread-id': 't-1', 'session-id': 's-1' }))).toEqual({
      source: 'thread-id',
      value: 't-1',
    });
  });

  it('没有 thread-id 时用 session-id', () => {
    expect(affinityKeyOf(headers({ 'session-id': 's-1' }))).toEqual({ source: 'session-id', value: 's-1' });
  });

  it('空串与空白等于没带', () => {
    expect(affinityKeyOf(headers({ 'thread-id': '   ', 'session-id': 's-1' }))).toEqual({
      source: 'session-id',
      value: 's-1',
    });
    expect(affinityKeyOf(headers({}))).toBeNull();
  });

  it('两个头都不认大小写以外的东西：这里只做 trim，不改写值', () => {
    expect(affinityKeyOf(headers({ 'thread-id': '  ABC  ' }))?.value).toBe('ABC');
  });
});

describe('affinityHash', () => {
  it('同一账户同一会话稳定', () => {
    expect(affinityHash('addr-a', 's-1')).toBe(affinityHash('addr-a', 's-1'));
  });

  it('按账户隔离：两个用户撞同一个 session-id 也各有各的一行', () => {
    expect(affinityHash('addr-a', 's-1')).not.toBe(affinityHash('addr-b', 's-1'));
  });

  it('键不落明文', () => {
    expect(affinityHash('addr-a', 'my-session')).not.toContain('my-session');
  });
});

describe('affinityFresh', () => {
  it('没过期就是还记着', () => {
    expect(affinityFresh(1001, 1000)).toBe(true);
  });

  it('到期那一刻算过期：到期就该重挑，不该多粘一秒', () => {
    expect(affinityFresh(1000, 1000)).toBe(false);
    expect(affinityFresh(999, 1000)).toBe(false);
  });
});

describe('narrowToOwned', () => {
  it('有自有候选时池子整批退出', () => {
    expect(narrowToOwned([pooled, mine, alsoMine], 'addr-a')).toEqual([mine, alsoMine]);
  });

  it('一条自有都没有时原样留下池子', () => {
    expect(narrowToOwned([pooled], 'addr-a')).toEqual([pooled]);
  });

  it('候选为空时保持为空（由调用方去报 provider_missing）', () => {
    expect(narrowToOwned([], 'addr-a')).toEqual([]);
  });
});

describe('pickByRendezvous', () => {
  it('同一个 seed 在候选不变时永远选中同一条', () => {
    const candidates = [mine, alsoMine, pooled];
    const first = pickByRendezvous(candidates, 'hash-1');
    for (let round = 0; round < 50; round += 1) {
      expect(pickByRendezvous(candidates, 'hash-1')).toBe(first);
    }
  });

  it('候选顺序不影响结果', () => {
    const forward = pickByRendezvous([mine, alsoMine, pooled], 'hash-2');
    const backward = pickByRendezvous([pooled, alsoMine, mine], 'hash-2');
    expect(forward).toBe(backward);
  });

  it('不同 seed 会分到不同上游（否则粘性就退化成「永远第一台」）', () => {
    const candidates = [mine, alsoMine, pooled];
    const picked = new Set(
      Array.from({ length: 60 }, (_, index) => pickByRendezvous(candidates, `seed-${index}`).id),
    );
    expect(picked.size).toBe(candidates.length);
  });

  it('候选减少时只搬走落在被删那条上的会话（rendezvous 的性质）', () => {
    const full = [mine, alsoMine, pooled];
    const reduced = [mine, alsoMine];
    for (let index = 0; index < 40; index += 1) {
      const seed = `seed-${index}`;
      const before = pickByRendezvous(full, seed);
      const after = pickByRendezvous(reduced, seed);
      if (before.id !== pooled.id) expect(after.id).toBe(before.id);
    }
  });

  it('单条候选就是它自己', () => {
    expect(pickByRendezvous([pooled], 'anything')).toBe(pooled);
  });
});

/**
 * 按模型筛候选：模型是硬约束，自有优先是偏好。三条处境必须能分开——
 * 有它 / 抓过清单但没它 / 清单从没抓过。
 */
describe('narrowToServingModel', () => {
  const p1 = { id: 'p-1' };
  const p2 = { id: 'p-2' };
  const ids = (...values: string[]) => new Set(values);

  it('清单里有它的，就只留它', () => {
    const out = narrowToServingModel([p1, p2], { known: ids('p-1', 'p-2'), serving: ids('p-2') });
    expect(out).toEqual([p2]);
  });

  it('清单抓过、里面没有它 → 这条这次不参与（不是优先级低，是跑不了）', () => {
    const out = narrowToServingModel([p1, p2], { known: ids('p-1', 'p-2'), serving: ids('p-2') });
    expect(out.map((candidate) => candidate.id)).not.toContain('p-1');
  });

  it('清单从没抓过的留着：没有证据不等于有证据说没有', () => {
    const out = narrowToServingModel([p1, p2], { known: ids('p-1'), serving: ids() });
    expect(out).toEqual([p2]);
  });

  it('抓过清单的一条都不认它 → 空，由调用方说出「没有上游提供这个模型」', () => {
    expect(narrowToServingModel([p1, p2], { known: ids('p-1', 'p-2'), serving: ids() })).toEqual([]);
  });

  it('全都还没抓过清单时原样留下（新加的上游不该被一张空表判死刑）', () => {
    expect(narrowToServingModel([p1, p2], { known: ids(), serving: ids() })).toEqual([p1, p2]);
  });
});
