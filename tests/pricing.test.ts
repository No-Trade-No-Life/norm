import { describe, expect, it } from 'vitest';

import { quote, ratesFor } from '../src/pricing';

/**
 * DeepSeek 两档价钉在这里：表里 \`input / cached / output\` 是**高峰价**，
 * 低谷价放 \`off_peak\`。高估一档只是报价保守，低估一档是真的漏收。
 */
describe('ratesFor（DeepSeek 高峰 / 低谷）', () => {
  it('v4-pro 走自己那一档，不是 generic 的 flash 价', () => {
    const got = ratesFor('deepseek-v4-pro');
    expect(got.match).toBe('deepseek-v4-pro');
    expect(got.rates).toEqual({ input: 1_320_000_000, cached: 44_000_000, output: 3_960_000_000 });
    expect(got.off_peak).toEqual({ input: 660_000_000, cached: 22_000_000, output: 1_980_000_000 });
  });

  it('flash 在收盘价上是 $0.30 / $1.20，低谷 $0.15 / $0.60', () => {
    const got = ratesFor('deepseek-flash');
    expect(got.match).toBe('deepseek-flash');
    expect(got.rates.input).toBe(300_000_000);
    expect(got.rates.output).toBe(1_200_000_000);
    expect(got.off_peak?.input).toBe(150_000_000);
  });

  it('带提供者前缀的名字也锚得上', () => {
    expect(ratesFor('deepseek/deepseek-v4-pro').match).toBe('deepseek-v4-pro');
  });

  it('退役的旧型号落到 generic deepseek，不再按旧价表算', () => {
    const got = ratesFor('deepseek-chat');
    expect(got.match).toBe('deepseek');
    expect(got.rates.input).toBe(300_000_000);
  });

  it('账本按高峰价算，低谷价不参与一次性计费', () => {
    // 100 万未命中缓存的输入 token × $0.30 / 1M
    expect(quote('deepseek-flash', { input: 1_000_000, cached: 0, output: 0 }).total_nanos).toBe(300_000_000);
  });
});
