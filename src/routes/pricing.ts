import { Hono } from 'hono';
import type { Env } from '../env';
import { DEFAULT_RATES, MODEL_RATES } from '../pricing';

/**
 * 价目表公开：账单要能被用户自己核对。
 *
 * 价格写死在 `src/pricing.ts`（随代码发布、进构建哈希），这里只是把它读出来。
 * 单位是微美元 / 每百万 token，与账本里的整数单位一致。
 */
export const pricingRoutes = new Hono<{ Bindings: Env }>();

pricingRoutes.get('/', (c) =>
  c.json({
    unit: 'micros per 1M tokens',
    default: DEFAULT_RATES,
    models: MODEL_RATES.map(({ match, input, cached, output }) => ({ match, input, cached, output })),
    service_fee: {
      micros: Number(c.env.SERVICE_FEE_MICROS),
      note: '每次被隔离执行的调用固定收一笔，与 token 无关：它摊的是 Cloudflare 侧的固定成本。',
    },
  }),
);
