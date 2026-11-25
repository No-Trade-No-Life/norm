/**
 * DeepSeek 官方 API 的定价：同一批型号两档价，按请求落在哪一段时段决定。
 *
 * 这是**协议层**的知识，不是通用价目表的一部分：`pricing.ts` 只管「一个型号一个价」，
 * 而 DeepSeek 的价随请求时刻变。挂到 `deepseek` 这条协议上，通用表就不必为一家上游
 * 多出一个字段，别的上游也不必假装自己有低谷价——分时计价是这一条上游契约的属性。
 *
 * 数值与规则抄自 DeepSeek LB（`~/Projects/DeepSeek-LB/src/pricing.rs`），那是这套计价
 * 的权威实现：时段、节假日、四个型号的单价都与它一致，改价时两边一起改。
 */
import type { Rates, Tariff } from './pricing';

/**
 * 高峰时段：UTC 的 01:00–04:00 与 06:00–10:00，半开区间。
 *
 * 04:00 与 10:00 整已经算低谷：边界那一两个请求的差价不到一分钱，与其猜一个精确到秒的
 * 约定，不如选一个能说清的。
 */
const PEAK_WINDOWS_MINUTES: Array<[number, number]> = [
  [60, 240],
  [360, 600],
];

/** 高峰只落在这些星期（ISO：1 = 周一 … 7 = 周日）。周末全天低谷。 */
export const DEEPSEEK_PEAK_WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * 中国法定节假日的放假日（2026，国务院放假安排；只列放假日，周末本来就全天低谷）。
 *
 * DeepSeek 在节假日的任何时刻都按低谷计费。国务院公布下一年的安排时往这里加一条；
 * 缺一条只会把那一天的高峰时段误判成高峰（少给折扣），不会凭空造出一个假期。
 */
export const DEEPSEEK_HOLIDAYS: string[] = [
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', // 春节
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', // 国庆
  '2026-10-05', '2026-10-06', '2026-10-07',
];

const HOLIDAYS = new Set(DEEPSEEK_HOLIDAYS);

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** 高峰时段的可读形式：进 `GET /api/v1/pricing`，也进注释。 */
export const DEEPSEEK_PEAK_WINDOWS_UTC: string[] = PEAK_WINDOWS_MINUTES.map(
  ([from, to]) => `${clock(from)}-${clock(to)}`,
);

/**
 * 这个时刻 DeepSeek 收高峰价吗？
 *
 * 高峰 = 周一到周五、不是法定节假日、且落在高峰时段里；其余全算低谷（含周末与节假日
 * 整天）。与 LB 的 `is_peak(utc_seconds)` 同义，包括「按请求开始的时刻选档」这个假设：
 * 一个请求跨过档位边界时，按它的起点算，不按收尾算。
 */
export function isDeepSeekPeak(utcSeconds: number): boolean {
  const at = new Date(utcSeconds * 1000);
  if (Number.isNaN(at.getTime())) return false;
  const weekday = at.getUTCDay() || 7; // getUTCDay: 0 = 周日，换成 ISO 的 7
  if (!DEEPSEEK_PEAK_WEEKDAYS.includes(weekday)) return false;
  // 节假日表按 UTC 日历日写：用本地时区读会把它挪一天。
  if (HOLIDAYS.has(at.toISOString().slice(0, 10))) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return PEAK_WINDOWS_MINUTES.some(([from, to]) => minutes >= from && minutes < to);
}

/** 纳美元 / 1M token。同一个数只写一次：通用价目表也从这张表取高峰价。 */
const FLASH_PEAK: Rates = { input: 300_000_000, cached: 6_000_000, output: 1_200_000_000 };
const PRO_PEAK: Rates = { input: 1_320_000_000, cached: 44_000_000, output: 3_960_000_000 };

/** 低谷价恒为高峰价的一半（2026-11 官网核对）；哪天不再是一半，就在这里写死两档。 */
const half = (rates: Rates): Rates => ({
  input: rates.input / 2,
  cached: rates.cached / 2,
  output: rates.output / 2,
});

const tierAt = (utcSeconds: number): 'peak' | 'off_peak' =>
  isDeepSeekPeak(utcSeconds) ? 'peak' : 'off_peak';

const tariff = (match: string, peak: Rates): Tariff => ({ match, peak, off_peak: half(peak), tier: tierAt });

/**
 * 四个型号的价目（与 LB 的 `TOKEN_PRICING` 同一组数）：`deepseek-v4-flash` 与
 * `deepseek-v4-flash-vision-exp` 是退役名，但 DeepSeek 仍接受并按 flash 计费；
 * `deepseek-v4-pro` 自己一档。没点名型号的 `deepseek-*` 落到 flash 那档——
 * 宁可高估，不按更便宜的一档漏收。
 */
export const DEEPSEEK_TARIFFS: Tariff[] = [
  tariff('deepseek-flash', FLASH_PEAK),
  tariff('deepseek-v4-flash', FLASH_PEAK),
  tariff('deepseek-v4-flash-vision-exp', FLASH_PEAK),
  tariff('deepseek-v4-pro', PRO_PEAK),
  tariff('deepseek', FLASH_PEAK),
];
