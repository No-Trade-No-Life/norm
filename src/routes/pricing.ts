import { Hono } from 'hono';
import type { Env } from '../env';
import { gasFeeNanos } from '../env';
import { DEFAULT_RATES, MODEL_RATES } from '../pricing';
import { PROTOCOLS, adapterFor } from '../protocols';

/**
 * 价目表公开：账单要能被用户自己核对。
 *
 * 价格写死在代码里（随代码发布、进构建哈希），这里只是把它读出来。单位是纳美元 /
 * 每百万 token，与账本里的整数单位一致。
 *
 * 两段，回答两个不同的问题：
 *   - `models`：通用价目表，一个型号一个价。谁挂在通用协议上，就按这一张算。
 *   - `protocols`：协议自带的定价模式。目前只有 `deepseek`——同一批型号两档价，按请求
 *     开始的时刻选档。通用表里它只有高峰价（上界），折扣只在这段里发生。
 */
export const pricingRoutes = new Hono<{ Bindings: Env }>();

pricingRoutes.get('/', (c) =>
  c.json({
    unit: 'nanos per 1M tokens',
    default: DEFAULT_RATES,
    models: MODEL_RATES.map(({ match, input, cached, output }) => ({ match, input, cached, output })),
    protocols: PROTOCOLS.flatMap((protocol) => {
      const pricing = adapterFor(protocol).pricing;
      if (!pricing) return [];
      return [
        {
          protocol,
          ...pricing.mode,
          models: pricing.tariffs.map(({ match, peak, off_peak }) => ({ match, peak, off_peak })),
        },
      ];
    }),
    gas_fee: {
      nanos: gasFeeNanos(c.env),
      note: '每一次真的打出去的调用固定收一笔，与 token 无关、与成败无关：它摊的是 Worker 调用与 D1 读写的固定成本。',
    },
  }),
);
