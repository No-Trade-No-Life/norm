import { Hono } from 'hono';
import type { Env } from '../env';
import { gasFeeNanos } from '../env';
import { DEFAULT_RATES, MODEL_RATES } from '../pricing';

/**
 * 价目表公开：账单要能被用户自己核对。
 *
 * 价格写死在 `src/pricing.ts`（随代码发布、进构建哈希），这里只是把它读出来。
 * 单位是纳美元 / 每百万 token，与账本里的整数单位一致。
 */
export const pricingRoutes = new Hono<{ Bindings: Env }>();

pricingRoutes.get('/', (c) =>
  c.json({
    unit: 'nanos per 1M tokens',
    default: DEFAULT_RATES,
    // `input / cached / output` 是高峰价；有低谷价的上游多一个 `off_peak`。
    models: MODEL_RATES.map(({ match, input, cached, output, off_peak }) => ({
      match,
      input,
      cached,
      output,
      ...(off_peak ? { off_peak } : {}),
    })),
    gas_fee: {
      nanos: gasFeeNanos(c.env),
      note: '每一次真的打出去的调用固定收一笔，与 token 无关、与成败无关：它摊的是 Worker 调用与 D1 读写的固定成本。',
    },
  }),
);
