import { describe, expect, it } from 'vitest';

import { DEFAULT_RATES, quote, ratesFor } from '../src/pricing';

/**
 * 通用价目表只有平档价：一个型号一个价。DeepSeek 的高峰 / 低谷属于那条协议自己的
 * 定价模式（见 `tests/deepseek.test.ts`），表里只留它的高峰价当上界。
 */
describe('ratesFor（通用价目表）', () => {
  it('v4-pro 走自己那一档，不是 generic 的 flash 价', () => {
    const got = ratesFor('deepseek-v4-pro');
    expect(got.match).toBe('deepseek-v4-pro');
    expect(got.rates).toEqual({ input: 1_320_000_000, cached: 44_000_000, output: 3_960_000_000 });
  });

  it('DeepSeek 在通用表里是高峰价，没有 off_peak 这一说', () => {
    const got = ratesFor('deepseek-flash');
    expect(got.match).toBe('deepseek-flash');
    expect(got.rates).toEqual({ input: 300_000_000, cached: 6_000_000, output: 1_200_000_000 });
    expect(got).not.toHaveProperty('off_peak');
  });

  it('带提供者前缀的名字也锚得上', () => {
    expect(ratesFor('deepseek/deepseek-v4-pro').match).toBe('deepseek-v4-pro');
  });

  it('退役的旧型号落到 generic deepseek，不再按旧价表算', () => {
    const got = ratesFor('deepseek-chat');
    expect(got.match).toBe('deepseek');
    expect(got.rates.input).toBe(300_000_000);
  });

  it('没收录的型号回兜底价，match 是 null', () => {
    expect(ratesFor('acme-secret-model')).toEqual({ rates: DEFAULT_RATES, match: null });
  });
});

describe('quote', () => {
  it('不传档位就按通用表算', () => {
    expect(quote('deepseek-flash', { input: 1_000_000, cached: 0, output: 0 }).total_nanos).toBe(300_000_000);
  });

  // 档位由协议在请求开始时选好传进来：低谷时段的 100 万输入 token 是 $0.15，不是 $0.30。
  it('传了档位就按那一档算', () => {
    const got = quote(
      'deepseek-flash',
      { input: 1_000_000, cached: 0, output: 0 },
      { match: 'deepseek-flash', rates: { input: 150_000_000, cached: 3_000_000, output: 600_000_000 } },
    );
    expect(got.match).toBe('deepseek-flash');
    expect(got.total_nanos).toBe(150_000_000);
  });

  it('传 null 与不传一样：退回通用表', () => {
    expect(quote('deepseek-flash', { input: 0, cached: 0, output: 1_000_000 }, null).total_nanos).toBe(1_200_000_000);
  });
});
