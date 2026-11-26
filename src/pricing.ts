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
 *
 * 这张表只管**平档价**：一个型号一个价。随请求时刻变价的（DeepSeek 的高峰 / 低谷）不是
 * 通用定价，而是某条上游协议自带的定价模式，写在 `src/deepseek.ts` 与 `protocols.ts` 的
 * `pricing` 里；表里的 DeepSeek 条目只取它的高峰价——上界，宁高估不漏收。
 */
import { DEEPSEEK_TARIFFS } from './deepseek';

export type Rates = {
  /** 未命中的输入 token，纳美元 / 1M token。 */
  input: number;
  /** 命中缓存的输入 token，纳美元 / 1M token。 */
  cached: number;
  /** 输出 token，纳美元 / 1M token。 */
  output: number;
};

/** 通用价目表的一行：一个模型名前缀，一个价。 */
export type PriceEntry = Rates & {
  /** 模型名前缀（大小写不敏感）。最长匹配优先。 */
  match: string;
};

/**
 * 某条协议自带的官方价目：同一批型号两档价，外加「这个时刻算哪一档」。
 *
 * 与 `PriceEntry` 的区别就是「价随时刻变」：通用表回答不了「现在多少钱」，
 * 所以只有真有分时计价的上游才需要它（见 `protocols.ts` 的 `ProtocolProfile.pricing`）。
 */
export type Tariff = {
  /** 模型名前缀，与通用表同一套匹配规则。 */
  match: string;
  /** 高峰价：报价与账本的上界。 */
  peak: Rates;
  /** 低谷价：只有分时的协议有。 */
  off_peak?: Rates;
  /** 这个时刻算哪一档；不给 = 不分时，恒按 `peak`。 */
  tier?: (utcSeconds: number) => 'peak' | 'off_peak';
};

/** 算一笔账用的那一档价（`match` 说明它是按哪条规则来的）。 */
export type PriceAnchor = { match: string; rates: Rates };

/** 没有任何一条规则命中时的兜底价。写在这里，是为了「没定价」不会变成「免费」。 */
export const DEFAULT_RATES: Rates = { input: 500_000_000, cached: 50_000_000, output: 1_500_000_000 };

/**
 * 定价表。数值取自各家公开发布的价目（2026-11），只做一件事：
 * 让账本里的钱与上游提供商自己的账单在同一个量级上，而不是凭空发明一个价格。
 * 价格会变，改这里就是改价；`GET /api/v1/pricing` 永远回这张表的当前值。
 */
export const MODEL_RATES: PriceEntry[] = [
  // DeepSeek 分时计价（高峰 / 低谷）只在 `deepseek` 协议里生效，价目也在那张表里
  // （`src/deepseek.ts`）。这里只取它的高峰价：把 DeepSeek 挂在通用协议上的上游
  // 不该享受低谷折扣，宁可高估。
  ...DEEPSEEK_TARIFFS.map(({ match, peak }) => ({ match, ...peak })),
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

/**
 * 最长前缀匹配：`gpt-4o-mini` 必须赢过 `gpt-4o`，否则便宜模型按贵模型计价。
 *
 * 名字常带一层提供者前缀（`deepseek/deepseek-chat`、`openai/gpt-4o-mini`）：去掉前缀再
 * 匹配一次，否则这种写法会掉到兜底价上（贵 3 倍且没人看得出来）。通用价目表与协议自带的
 * 分时价目表共用这一条规则，所以「哪一行命中」在两处是同一个答案。
 */
export function longestMatch<T extends { match: string }>(entries: readonly T[], model: string): T | null {
  const name = model.trim().toLowerCase();
  const bare = name.slice(name.lastIndexOf('/') + 1);

  let best: T | null = null;
  for (const entry of entries) {
    if (!name.startsWith(entry.match) && !bare.startsWith(entry.match)) continue;
    if (best === null || entry.match.length > best.match.length) best = entry;
  }
  return best;
}

/** 通用价目表对一个型号的报价；没命中就是兜底价（`match: null`）。 */
export function ratesFor(model: string): { rates: Rates; match: string | null } {
  const best = longestMatch(MODEL_RATES, model);
  if (best === null) return { rates: DEFAULT_RATES, match: null };
  return { rates: { input: best.input, cached: best.cached, output: best.output }, match: best.match };
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
 * `anchor` 是这一笔按哪一档价算：协议自带分时价时由调用方在请求开始时选好档传进来
 * （见 `protocols.ts` 的 `rateAt`），不传就走通用价目表。
 *
 * 缓存命中永远不会多于输入总量：上游提供商的计数口径各不相同（有的把缓存算进输入，有的分开），
 * 归一化在 dialects.ts 里做，这里只负责不让一个坏数字变成一笔负账。
 */
export function quote(model: string, usage: Usage, anchor?: PriceAnchor | null): Quote {
  const { rates, match } = anchor ?? ratesFor(model);
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

/* ── 音频：按秒、按字符、按 token ──────────────────────────────────────
 *
 * 音频没有「每百万 token」这一种单位。转写卖的是时长，多数合成卖的是字符，少数合成模型
 * 按 token 卖——三种单位互不可比，所以音频价目单独一张表，`unit` 由表自己说。
 *
 * 音频**没有兜底价**：认不出的型号在转发之前就拒（`audio_model_unpriced`）。文本那一侧
 * 的兜底价是「贵三倍的上界」，因为三种 token 是同一个单位；音频猜错方向能差几个数量级，
 * 而一笔按秒计的价乘到字符数上，账单会变成一句谎话。
 */

/** 一次音频调用的用量事实。转写只有时长，合成只有字符或 token。 */
export type AudioUsage = {
  /** 上游报告的音频时长（毫秒，整数）。转写按它计费。 */
  milliseconds: number;
  /** 合成输入的字符数。按字符计价的型号按它计费。 */
  characters: number;
  /** 按 token 计价的合成型号的上游用量（转写恒为 0）。 */
  input: number;
  output: number;
};

/** 没有任何用量的一笔（失败的调用、文本调用都用它）。 */
export const ZERO_AUDIO_USAGE: AudioUsage = { milliseconds: 0, characters: 0, input: 0, output: 0 };

/** 音频价目的一行：一个型号前缀，一种单位，一个价。 */
export type AudioRate =
  | { match: string; unit: 'second'; nanos: number }
  | { match: string; unit: 'character'; nanos: number }
  | { match: string; unit: 'token'; input: number; output: number };

/**
 * 音频价目表。数值与 Qwen LB 的「语音计价」页同一组（人民币价目按 7.2 折成纳美元），
 * OpenAI 的几行取官网公开价（$0.006/min 转写、$15/1M 字符合成）。
 */
export const AUDIO_RATES: AudioRate[] = [
  // Qwen：转写按秒，合成按字符或按 token。
  { match: 'qwen-audio-3.0-asr-flash', unit: 'second', nanos: 30_556 },
  { match: 'qwen3-tts-flash', unit: 'character', nanos: 11_111 },
  { match: 'qwen-audio-3.1-tts-flash', unit: 'token', input: 208_333_333, output: 1_666_666_667 },
  { match: 'cosyvoice-v3.5-flash', unit: 'character', nanos: 11_111 },
  { match: 'cosyvoice-v3.5-plus', unit: 'character', nanos: 20_833 },
  // OpenAI：同一批型号也可能挂在 `openai-audio` 这条通用协议上。
  { match: 'gpt-4o-mini-transcribe', unit: 'second', nanos: 50_000 },
  { match: 'gpt-4o-transcribe', unit: 'second', nanos: 100_000 },
  { match: 'whisper-1', unit: 'second', nanos: 100_000 },
  { match: 'tts-1-hd', unit: 'character', nanos: 30_000 },
  { match: 'tts-1', unit: 'character', nanos: 15_000 },
  { match: 'gpt-4o-mini-tts', unit: 'character', nanos: 15_000 },
];

/** 一个型号的音频价；没收录就是 null（不是兜底价）。 */
export function audioRateFor(model: string): AudioRate | null {
  return longestMatch(AUDIO_RATES, model);
}

/** 一笔音频账：按哪条规则、哪种单位、收多少纳美元。 */
export type AudioQuote = {
  match: string;
  unit: AudioRate['unit'];
  nanos: number;
};

/**
 * 把一次音频调用的用量折成钱。型号没有音频价目就是 null——调用方在转发之前就该拒掉，
 * 这里再回一次 null 是让「先拒后算」这条路各自独立成立。
 */
export function quoteAudio(model: string, usage: AudioUsage): AudioQuote | null {
  const rate = audioRateFor(model);
  if (rate === null) return null;
  if (rate.unit === 'second') {
    return { match: rate.match, unit: rate.unit, nanos: Math.round((Math.max(usage.milliseconds, 0) * rate.nanos) / 1000) };
  }
  if (rate.unit === 'character') {
    return { match: rate.match, unit: rate.unit, nanos: Math.max(usage.characters, 0) * rate.nanos };
  }
  return {
    match: rate.match,
    unit: rate.unit,
    nanos: nanos(Math.max(usage.input, 0), rate.input) + nanos(Math.max(usage.output, 0), rate.output),
  };
}
