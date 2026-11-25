/**
 * 计价：账本按 Token 走，外加一次性的 Norm 服务费。
 *
 * 单位是**微美元 / 每百万 token**（micros per 1M tokens）。用整数是因为一整个请求可能
 * 只值几微美元：$2.50/M 的一次 3000 token 调用是 7500 微美元，而 $0.15/M 的一次 40 token
 * 调用是 6 微美元——用分做单位会把它四舍五入成 0。
 *
 * 为什么定价写在代码里而不是 `wrangler.jsonc`：这份表是「公开可复现的转发规则」的一部分。
 * 放在代码里，`pnpm build` 的哈希就覆盖了它；放在部署变量里，同一个 commit 可以跑出不同的
 * 价格，而外部核验者看不见。改价 = 改代码 = 一次可被审查的合并。
 *
 * 三个单价对应三种 token，它们不是同一个东西：
 *   input   未命中缓存的输入 token（真正要重新预填充的那部分）
 *   cached  命中缓存的输入 token（上游会便宜很多）
 *   output  输出 token（最贵，逐字生成）
 */

export type Rates = {
  /** 未命中的输入 token，微美元 / 1M token。 */
  input: number;
  /** 命中缓存的输入 token，微美元 / 1M token。 */
  cached: number;
  /** 输出 token，微美元 / 1M token。 */
  output: number;
};

export type PriceEntry = Rates & {
  /** 模型名前缀（大小写不敏感）。最长匹配优先。 */
  match: string;
};

/** 没有任何一条规则命中时的兜底价。写在这里，是为了「没定价」不会变成「免费」。 */
export const DEFAULT_RATES: Rates = { input: 500_000, cached: 50_000, output: 1_500_000 };

/**
 * 定价表。数值取自各家公开发布的价目（2026-11），只做一件事：
 * 让账本里的钱与上游自己的账单在同一个量级上，而不是凭空发明一个价格。
 * 价格会变，改这里就是改价；`GET /api/v1/pricing` 永远回这张表的当前值。
 */
export const MODEL_RATES: PriceEntry[] = [
  { match: 'deepseek-reasoner', input: 550_000, cached: 140_000, output: 2_190_000 },
  { match: 'deepseek-chat', input: 270_000, cached: 70_000, output: 1_100_000 },
  { match: 'deepseek', input: 270_000, cached: 70_000, output: 1_100_000 },
  { match: 'gpt-4o-mini', input: 150_000, cached: 75_000, output: 600_000 },
  { match: 'gpt-4o', input: 2_500_000, cached: 1_250_000, output: 10_000_000 },
  { match: 'gpt-4.1-mini', input: 400_000, cached: 100_000, output: 1_600_000 },
  { match: 'gpt-4.1', input: 2_000_000, cached: 500_000, output: 8_000_000 },
  { match: 'o4-mini', input: 1_100_000, cached: 275_000, output: 4_400_000 },
  { match: 'claude-3-5-haiku', input: 800_000, cached: 80_000, output: 4_000_000 },
  { match: 'claude-3-5-sonnet', input: 3_000_000, cached: 300_000, output: 15_000_000 },
  { match: 'claude-sonnet', input: 3_000_000, cached: 300_000, output: 15_000_000 },
  { match: 'claude-opus', input: 15_000_000, cached: 1_500_000, output: 75_000_000 },
  { match: 'claude', input: 3_000_000, cached: 300_000, output: 15_000_000 },
  { match: 'gemini-2.0-flash', input: 100_000, cached: 25_000, output: 400_000 },
  { match: 'gemini-2.5-flash', input: 300_000, cached: 75_000, output: 2_500_000 },
  { match: 'gemini-2.5-pro', input: 1_250_000, cached: 125_000, output: 10_000_000 },
  { match: 'gemini', input: 300_000, cached: 75_000, output: 2_500_000 },
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
  input_micros: number;
  cached_micros: number;
  output_micros: number;
  total_micros: number;
};

/** 最长前缀匹配：`gpt-4o-mini` 必须赢过 `gpt-4o`，否则便宜模型按贵模型计价。 */
export function ratesFor(model: string): { rates: Rates; match: string | null } {
  const name = model.trim().toLowerCase();
  // `deepseek/deepseek-chat`、`openai/gpt-4o-mini`：名字常带一层提供者前缀，
  // 去掉前缀再匹配一次，否则这种写法会掉到兜底价上（贵 3 倍且没人看得出来）。
  const bare = name.slice(name.lastIndexOf('/') + 1);

  let best: PriceEntry | null = null;
  for (const entry of MODEL_RATES) {
    if (!name.startsWith(entry.match) && !bare.startsWith(entry.match)) continue;
    if (best === null || entry.match.length > best.match.length) best = entry;
  }
  return best ? { rates: best, match: best.match } : { rates: DEFAULT_RATES, match: null };
}

const micros = (tokens: number, rate: number): number => Math.round((Math.max(tokens, 0) * rate) / 1_000_000);

/**
 * 把三项 token 折成一笔钱。
 *
 * 缓存命中永远不会多于输入总量：上游的计数口径各不相同（有的把缓存算进输入，有的分开），
 * 归一化在 dialects.ts 里做，这里只负责不让一个坏数字变成一笔负账。
 */
export function quote(model: string, usage: Usage): Quote {
  const { rates, match } = ratesFor(model);
  const cached = Math.min(Math.max(usage.cached, 0), Math.max(usage.input, 0));
  const uncached = Math.max(usage.input, 0) - cached;
  const inputMicros = micros(uncached, rates.input);
  const cachedMicros = micros(cached, rates.cached);
  const outputMicros = micros(usage.output, rates.output);
  return {
    match,
    rates,
    uncached_tokens: uncached,
    input_micros: inputMicros,
    cached_micros: cachedMicros,
    output_micros: outputMicros,
    total_micros: inputMicros + cachedMicros + outputMicros,
  };
}
