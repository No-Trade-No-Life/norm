import { describe, expect, it } from 'vitest';
import { DEFAULT_RATES, quote, ratesFor } from '../src/pricing';

/**
 * 计价是这个产品的钱袋子：一个 «四舍五入方向错了» 或 «前缀匹配短了» 的 bug
 * 不会让任何页面白屏，只会安静地把账单算错。所以这里按「谁赢哪条规则」与
 * «三项 token 各自怎么折钱» 两类来钉住它。
 */
describe('ratesFor：最长前缀匹配', () => {
  it('gpt-4o-mini 不会被 gpt-4o 抢走', () => {
    expect(ratesFor('gpt-4o-mini').match).toBe('gpt-4o-mini');
    expect(ratesFor('gpt-4o').match).toBe('gpt-4o');
  });

  it('带上游前缀的模型名也能命中（deepseek/deepseek-chat）', () => {
    expect(ratesFor('deepseek/deepseek-chat').match).toBe('deepseek-chat');
  });

  it('大小写与空白无关', () => {
    expect(ratesFor('  Claude-3-5-Sonnet  ').match).toBe('claude-3-5-sonnet');
  });

  it('没见过的模型走兜底价，而不是免费', () => {
    const { rates, match } = ratesFor('some-unknown-model');
    expect(match).toBeNull();
    expect(rates).toEqual(DEFAULT_RATES);
    expect(DEFAULT_RATES.input).toBeGreaterThan(0);
  });
});

describe('quote：三项 token 各自折钱', () => {
  it('缓存命中的输入按 cached 价，未命中的按 input 价', () => {
    // 100 万 token 的输入里 60 万命中缓存：40 万 × 2.50 + 60 万 × 1.25。
    const q = quote('gpt-4o', { input: 1_000_000, cached: 600_000, output: 0 });
    expect(q.uncached_tokens).toBe(400_000);
    expect(q.input_micros).toBe(1_000_000);
    expect(q.cached_micros).toBe(750_000);
    expect(q.total_micros).toBe(1_750_000);
  });

  it('输出按 output 价，与输入互不相干', () => {
    const q = quote('gpt-4o-mini', { input: 0, cached: 0, output: 1_000_000 });
    expect(q.total_micros).toBe(600_000);
  });

  it('小额调用不会被四舍五入抹成 0', () => {
    // 40 token × $0.15/M ≈ 6 微美元：用分做单位就会变成 0，用微美元不会。
    const q = quote('gpt-4o-mini', { input: 40, cached: 0, output: 0 });
    expect(q.total_micros).toBe(6);
  });

  it('缓存数大于输入数时不为负（上游口径坏掉也不会倒扣钱）', () => {
    const q = quote('gpt-4o', { input: 100, cached: 500, output: 0 });
    expect(q.uncached_tokens).toBe(0);
    expect(q.cached_micros).toBeGreaterThanOrEqual(0);
    expect(q.total_micros).toBeGreaterThanOrEqual(0);
  });

  it('负 token 视同 0', () => {
    const q = quote('gpt-4o', { input: -10, cached: -5, output: -1 });
    expect(q.total_micros).toBe(0);
  });

  it('三项全为 0 就是 0 元（失败路径依赖这一点）', () => {
    expect(quote('claude-opus', { input: 0, cached: 0, output: 0 }).total_micros).toBe(0);
  });
});
