import { describe, expect, it } from 'vitest';

import { perMillion, signedUsd, usd } from '../web/src/lib/format';

/**
 * 金额按**有效数字**给位数（三位），不按固定小数位：同一个账本里既有 $0.00075 的一次搜索、
 * $0.08 的一张图，也有 $44.66 的累计消费。固定小数位会让小额只剩一位有效数字——750,000
 * 纳美元（$0.00075）会被印成 $0.0008，读起来像多收了 7%，而那不是账本里的事实。
 */
describe('usd：三位有效数字', () => {
  it('小额保留三位有效数字，而不是按档位截断', () => {
    expect(usd(750_000)).toBe('$0.00075');
    expect(usd(752_000)).toBe('$0.000752');
    expect(usd(6_566_000)).toBe('$0.00657');
    expect(usd(2_000)).toBe('$0.000002');
    expect(usd(1)).toBe('$0.000000001');
  });

  it('已经是三位以内的值原样呈现：末尾的零是补出来的，收掉', () => {
    expect(usd(6_500_000)).toBe('$0.0065');
    expect(usd(80_000_000)).toBe('$0.08');
    expect(usd(300)).toBe('$0.0000003');
  });

  it('不小于一分时至少给到分：钱不印成整元', () => {
    expect(usd(950_000_000)).toBe('$0.95');
    expect(usd(1_500_000_000)).toBe('$1.50');
    expect(usd(44_660_000_000)).toBe('$44.66');
    expect(usd(1_234_000_000)).toBe('$1.23');
  });

  it('零、缺值与负数：零是 $0，缺值是破折号，符号在 signedUsd 里', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(null)).toBe('—');
    expect(usd(undefined)).toBe('—');
    expect(signedUsd(-750_000)).toBe('−$0.00075');
    expect(signedUsd(750_000)).toBe('+$0.00075');
  });

  it('价目表的单价用同一条格式：$0.075 不会被舍成 $0.08', () => {
    expect(perMillion(75_000_000)).toBe('$0.075');
    expect(perMillion(15_000_000_000)).toBe('$15.00');
    expect(perMillion(400_000)).toBe('$0.0004');
    expect(perMillion(0)).toBe('$0');
  });
});
