import { describe, expect, it } from 'vitest';

import { dialectCodecFor } from '../src/codecs';
import { DEEPSEEK_TARIFFS, isDeepSeekPeak } from '../src/deepseek';
import { protocolFor, rateAt, tariffFor } from '../src/protocols';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * 分时价是 DeepSeek 一家的事，所以它既不在通用价目表里，也不该有一条「所有协议共用」
 * 的规则。这里钉住三件东西：时段怎么算、价目长什么样、挂到协议上之后怎么选档。
 *
 * 数值与规则以 DeepSeek LB（`~/Projects/DeepSeek-LB/src/pricing.rs`）为准。
 */
describe('isDeepSeekPeak（时段规则）', () => {
  it('工作日的高峰区间是 UTC 01:00–04:00 与 06:00–10:00', () => {
    expect(isDeepSeekPeak(at('2026-11-25T01:00:00Z'))).toBe(true);
    expect(isDeepSeekPeak(at('2026-11-25T03:59:00Z'))).toBe(true);
    expect(isDeepSeekPeak(at('2026-11-25T06:00:00Z'))).toBe(true);
    expect(isDeepSeekPeak(at('2026-11-25T09:59:00Z'))).toBe(true);
  });

  it('半开区间：04:00 与 10:00 整已经算低谷，00:59 也是低谷', () => {
    expect(isDeepSeekPeak(at('2026-11-25T04:00:00Z'))).toBe(false);
    expect(isDeepSeekPeak(at('2026-11-25T10:00:00Z'))).toBe(false);
    expect(isDeepSeekPeak(at('2026-11-25T00:59:00Z'))).toBe(false);
  });

  it('周末全天低谷，哪怕落在高峰时段里', () => {
    expect(isDeepSeekPeak(at('2026-11-28T02:00:00Z'))).toBe(false); // 周六
    expect(isDeepSeekPeak(at('2026-11-29T07:00:00Z'))).toBe(false); // 周日
  });

  it('法定节假日整天低谷', () => {
    expect(isDeepSeekPeak(at('2026-10-01T02:00:00Z'))).toBe(false); // 国庆，周四
  });

  it('节假日表没覆盖的年份退回「工作日 + 时段」，不猜假期', () => {
    expect(isDeepSeekPeak(at('2027-01-06T02:00:00Z'))).toBe(true); // 周三
  });

  it('看不懂的时刻不算高峰：不因为一个坏数字收贵价', () => {
    expect(isDeepSeekPeak(Number.NaN)).toBe(false);
  });
});

describe('DEEPSEEK_TARIFFS（两档价目）', () => {
  it('低谷价恒为高峰价的一半', () => {
    for (const tariff of DEEPSEEK_TARIFFS) {
      expect(tariff.off_peak).toEqual({
        input: tariff.peak.input / 2,
        cached: tariff.peak.cached / 2,
        output: tariff.peak.output / 2,
      });
    }
  });

  it('四个型号的价格与 LB 的 TOKEN_PRICING 一致', () => {
    const peakOf = new Map(DEEPSEEK_TARIFFS.map((tariff) => [tariff.match, tariff.peak]));
    expect(peakOf.get('deepseek-v4-pro')).toEqual({
      input: 1_320_000_000,
      cached: 44_000_000,
      output: 3_960_000_000,
    });
    expect(peakOf.get('deepseek-flash')).toEqual({ input: 300_000_000, cached: 6_000_000, output: 1_200_000_000 });
    // 退役名仍按 flash 计费。
    expect(peakOf.get('deepseek-v4-flash')).toEqual(peakOf.get('deepseek-flash'));
    expect(peakOf.get('deepseek-v4-flash-vision-exp')).toEqual(peakOf.get('deepseek-flash'));
  });
});

describe('deepseek 协议', () => {
  it('复用 Responses 方言：路径、编解码与清单都与 openai-responses 同一份', () => {
    const deepseek = protocolFor('deepseek');
    const responses = protocolFor('openai-responses');
    const body = { messages: [{ role: 'user', content: '你好' }] };

    expect(deepseek.dialect).toBe('openai-responses');
    expect(deepseek.path('m')).toBe(responses.path('m'));
    expect(dialectCodecFor(deepseek.dialect)).toBe(dialectCodecFor('openai-responses'));
    expect(dialectCodecFor(deepseek.dialect).encodeRequest(body, 'm')).toEqual(
      dialectCodecFor(responses.dialect).encodeRequest(body, 'm'),
    );
    expect(deepseek.modelsPath()).toBe(responses.modelsPath());
  });

  it('分时价只挂在 deepseek 这一条协议上', () => {
    expect(protocolFor('deepseek').pricing?.mode.kind).toBe('time-tiered');
    expect(protocolFor('openai-responses').pricing).toBeUndefined();
    expect(tariffFor('openai-chat', 'deepseek-v4-pro')).toBeNull();
  });

  it('选档：高峰按 peak，低谷按 off_peak', () => {
    expect(rateAt('deepseek', 'deepseek-v4-pro', at('2026-11-25T02:00:00Z'))).toEqual({
      match: 'deepseek-v4-pro',
      rates: { input: 1_320_000_000, cached: 44_000_000, output: 3_960_000_000 },
    });
    expect(rateAt('deepseek', 'deepseek-v4-pro', at('2026-11-25T12:00:00Z'))?.rates.input).toBe(660_000_000);
  });

  it('带提供者前缀的名字也锚得上，没收录的型号交回通用表', () => {
    expect(rateAt('deepseek', 'deepseek/deepseek-flash', at('2026-11-25T02:00:00Z'))?.match).toBe('deepseek-flash');
    expect(rateAt('deepseek', 'gpt-4o', at('2026-11-25T02:00:00Z'))).toBeNull();
  });
});
