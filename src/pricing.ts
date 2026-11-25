/**
 * 计价：账本按 Token 走，外加一次性的 Norm 服务费。
 *
 * 单位是**纳美元 / 每百万 token**（nanos per 1M tokens）。用整数、且精确到纳美元，
 * 是因为一整个请求可能只值几十纳美元：$2.50/M 的一次 3000 token 调用是 7500 纳美元，而 $0.15/M 的一次 40 token
 * 调用是 6 纳美元——用分做单位会把它四舍五入成 0。
 *
 * 为什么定价写在代码里而不是 `wrangler.jsonc`：这份表是「公开可复现的转发规则」的一部分。
 * 放在代码里，`pnpm build` 的哈希就覆盖了它；放在部署变量里，同一个 commit 可以跑出不同的
 * 价格，而外部核验者看不见。改价 = 改代码 = 一次可被审查的合并。
 *
 * 三个单价对应三种 token，它们不是同一个东西：
 *   input   未命中缓存的输入 token（真正要重新预填充的那部分）
 *   cached  命中缓存的输入 token（上游提供商会便宜很多）
 *   output  输出 token（最贵，逐字生成）
 */

export type Rates = {
  /** 未命中的输入 token，纳美元 / 1M token。 */
  input: number;
  /** 命中缓存的输入 token，纳美元 / 1M token。 */
  cached: number;
  /** 输出 token，纳美元 / 1M token。 */
  output: number;
};

export type PriceEntry = Rates & {
  /** 模型名前缀（大小写不敏感）。最长匹配优先。 */
  match: string;
  /**
   * 低谷价：有的上游按时段折价（DeepSeek 的低谷价约为高峰价的一半）。
   * `Rates` 只放**高峰价**——它是报价的上界，也是账本用的那一档；
   * 低谷价单列在这里，页面自己决定怎么展示，`quote()` 不看它。
   */
  off_peak?: Rates;
};

/** 没有任何一条规则命中时的兜底价。写在这里，是为了「没定价」不会变成「免费」。 */
export const DEFAULT_RATES: Rates = { input: 500_000_000, cached: 50_000_000, output: 1_500_000_000 };

/**
 * 定价表。数值取自各家公开发布的价目（2026-11），只做一件事：
 * 让账本里的钱与上游提供商自己的账单在同一个量级上，而不是凭空发明一个价格。
 * 价格会变，改这里就是改价；`GET /api/v1/pricing` 永远回这张表的当前值。
 */
export const MODEL_RATES: PriceEntry[] = [
  // DeepSeek：2026-11-25 按其官网 Model Details 核对，型号是 flash 与 v4-pro，
  // 两个都有高峰 / 低谷两档（低谷约为高峰的一半）。这里写高峰价，低谷放进 off_peak。
  { match: 'deepseek-v4-pro', input: 1_320_000_000, cached: 44_000_000, output: 3_960_000_000, off_peak: { input: 660_000_000, cached: 22_000_000, output: 1_980_000_000 } },
  { match: 'deepseek-flash', input: 300_000_000, cached: 6_000_000, output: 1_200_000_000, off_peak: { input: 150_000_000, cached: 3_000_000, output: 600_000_000 } },
  // 没点名型号的 deepseek 落到 mainstream 那档（flash 高峰价）：宁可高估，不按更便宜的一档漏收。
  { match: 'deepseek', input: 300_000_000, cached: 6_000_000, output: 1_200_000_000, off_peak: { input: 150_000_000, cached: 3_000_000, output: 600_000_000 } },
  { match: 'gpt-4o-mini', input: 150_000_000, cached: 75_000_000, output: 600_000_000 },
  { match: 'gpt-4o', input: 2_500_000_000, cached: 1_250_000_000, output: 10_000_000_000 },
  { match: 'gpt-4.1-mini', input: 400_000_000, cached: 100_000_000, output: 1_600_000_000 },
  { match: 'gpt-4.1', input: 2_000_000_000, cached: 500_000_000, output: 8_000_000_000 },
  { match: 'o4-mini', input: 1_100_000_000, cached: 275_000_000, output: 4_400_000_000 },
  { match: 'claude-3-5-haiku', input: 800_000_000, cached: 80_000_000, output: 4_000_000_000 },
  { match: 'claude-3-5-sonnet', input: 3_000_000_000, cached: 300_000_000, output: 15_000_000_000 },
  { match: 'claude-sonnet', input: 3_000_000_000, cached: 300_000_000, output: 15_000_000_000 },
  { match: 'claude-opus', input: 15_000_000_000, cached: 1_500_000_000, output: 75_000_000_000 },
  { match: 'claude', input: 3_000_000_000, cached: 300_000_000, output: 15_000_000_000 },
  { match: 'gemini-2.0-flash', input: 100_000_000, cached: 25_000_000, output: 400_000_000 },
  { match: 'gemini-2.5-flash', input: 300_000_000, cached: 75_000_000, output: 2_500_000_000 },
  { match: 'gemini-2.5-pro', input: 1_250_000_000, cached: 125_000_000, output: 10_000_000_000 },
  { match: 'gemini', input: 300_000_000, cached: 75_000_000, output: 2_500_000_000 },
];

/** 一个请求的 token 事实：输入总量（含缓存命中）、其中命中缓存的、输出。 */
export type Usage = {
  input: number;
  cached: number;
  output: number;
};

export type Quote = {
  /** 用的哪条规则（null = 兜底价），要能回答「为什么是这个价」。 */
  match: string | null;
  rates: Rates;
  /** 未命中缓存的输入 token（= input − cached，不为负）。 */
  uncached_tokens: number;
  input_nanos: number;
  cached_nanos: number;
  output_nanos: number;
  total_nanos: number;
};

/** 最长前缀匹配：`gpt-4o-mini` 必须赢过 `gpt-4o`，否则便宜模型按贵模型计价。 */
export function ratesFor(model: string): { rates: Rates; match: string | null; off_peak?: Rates } {
  const name = model.trim().toLowerCase();
  // `deepseek/deepseek-chat`、`openai/gpt-4o-mini`：名字常带一层提供者前缀，
  // 去掉前缀再匹配一次，否则这种写法会掉到兜底价上（贵 3 倍且没人看得出来）。
  const bare = name.slice(name.lastIndexOf('/') + 1);

  let best: PriceEntry | null = null;
  for (const entry of MODEL_RATES) {
    if (!name.startsWith(entry.match) && !bare.startsWith(entry.match)) continue;
    if (best === null || entry.match.length > best.match.length) best = entry;
  }
  return best
    ? {
        rates: { input: best.input, cached: best.cached, output: best.output },
        match: best.match,
        ...(best.off_peak ? { off_peak: best.off_peak } : {}),
      }
    : { rates: DEFAULT_RATES, match: null };
}

/**
 * token 数 × 单价（纳美元 / 1M token）→ 纳美元。
 *
 * 不能写成 `tokens * rate / 1e6`：大模型一次能吐上百万 token，乘出来的中间值
 * 会越过 2^53，浮点先丢精度再取整。所以先把单价拆成「每 token 的整数部分」与
 * 「余数部分」，各自乘都留在安全整数内，最后一次取整。
 */
const nanos = (tokens: number, rate: number): number => {
  const count = Math.max(tokens, 0);
  const whole = Math.floor(rate / 1_000_000);
  const rest = rate - whole * 1_000_000;
  return count * whole + Math.round((count * rest) / 1_000_000);
};

/**
 * 把三项 token 折成一笔钱。
 *
 * 缓存命中永远不会多于输入总量：上游提供商的计数口径各不相同（有的把缓存算进输入，有的分开），
 * 归一化在 dialects.ts 里做，这里只负责不让一个坏数字变成一笔负账。
 */
export function quote(model: string, usage: Usage): Quote {
  const { rates, match } = ratesFor(model);
  const cached = Math.min(Math.max(usage.cached, 0), Math.max(usage.input, 0));
  const uncached = Math.max(usage.input, 0) - cached;
  const inputNanos = nanos(uncached, rates.input);
  const cachedNanos = nanos(cached, rates.cached);
  const outputNanos = nanos(usage.output, rates.output);
  return {
    match,
    rates,
    uncached_tokens: uncached,
    input_nanos: inputNanos,
    cached_nanos: cachedNanos,
    output_nanos: outputNanos,
    total_nanos: inputNanos + cachedNanos + outputNanos,
  };
}
