import { Hono } from 'hono';
import type { Env } from '../env';
import { minBalanceNanos } from '../env';
import { D1_ROW_WRITES, GAS_FLOOR_NANOS, GAS_MARGIN_BPS, GAS_SCHEDULE } from '../gas';
import { AUDIO_RATES, DEFAULT_RATES, IMAGE_RATES, MODEL_RATES } from '../pricing';
import { PROTOCOLS, protocolFor } from '../protocols';

/**
 * 价目表公开：账单要能被用户自己核对。
 *
 * 价格写死在代码里（随代码发布、进构建哈希），这里只是把它读出来。单位是纳美元 /
 * 每百万 token，与账本里的整数单位一致。
 *
 * 四段，回答四个不同的问题：
 *   - `models`：通用价目表，一个型号一个价。谁挂在通用协议上，就按这一张算。
 *   - `protocols`：协议自带的定价模式。目前只有 `deepseek`——同一批型号两档价，按请求
 *     开始的时刻选档。通用表里它只有高峰价（上界），折扣只在这段里发生。
 *   - `audio`：音频价目。单位不是 token（按秒 / 按字符 / 按 token），所以单独一段，
 *     `unit` 由每一行自己说。
 *   - `image`：图像价目。单位是**每张图**，按质量分档——上游的图片 token 不出现在用量里，
 *     一张图的价钱没法从 token 推出来。
 */
export const pricingRoutes = new Hono<{ Bindings: Env }>();

pricingRoutes.get('/', (c) =>
  c.json(
    {
      unit: 'nanos per 1M tokens',
      default: DEFAULT_RATES,
      models: MODEL_RATES.map(({ match, input, cached, output }) => ({ match, input, cached, output })),
      protocols: PROTOCOLS.flatMap((protocol) => {
        const pricing = protocolFor(protocol).pricing;
        if (!pricing) return [];
        return [
          {
            protocol,
            ...pricing.mode,
            models: pricing.tariffs.map(({ match, peak, off_peak }) => ({ match, peak, off_peak })),
          },
        ];
      }),
      audio: AUDIO_RATES,
      image: {
        unit: 'nanos per image',
        note: '每张 1024×1024 的价，按质量分档；更大的尺寸按像素数等比折算。',
        models: IMAGE_RATES,
      },
      gas_fee: {
        nanos: GAS_FLOOR_NANOS,
        base_nanos: GAS_SCHEDULE.worker_invocation,
        floor_nanos: GAS_FLOOR_NANOS,
        min_balance_nanos: minBalanceNanos(c.env),
        margin_bps: GAS_MARGIN_BPS,
        schedule: {
          ...GAS_SCHEDULE,
          d1_writes: D1_ROW_WRITES,
        },
        note: 'Gas 与 Token 分开计费：Gas 从 300 纳美元（Worker 调用）起步，按实际经过的 Cloudflare 资源付费点逐项累加，付给 Norm（当前 1.0× 成本价）；Token 费是用户间价值转移——调用自有上游仅收 Gas（Token 为 0），调用公共池/他人上游时 Token 费转入上游提供方账户（额外含 1,000 纳转账写库 Gas）。',
      },
    },
    200,
    {
      // 价目表与 Gas 操作码表写在代码里，仅随新部署变动，允许缓存 5 分钟压低免费读成本。
      'Cache-Control': 'public, max-age=300',
    },
  ),
);
