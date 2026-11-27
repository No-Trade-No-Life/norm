const SIGNIFICANT_DIGITS = 3;

/**
 * 数值 → 十进制文本：三位**有效数字**，至少两位小数，第二位之后的零收掉。
 *
 * 不用 `toPrecision`：它给出 `7.5e-4` 这种指数写法，而账本要的是能一眼读的十进制。
 */
function decimal(value: number): string {
  const abs = Math.abs(value);
  const exponent = abs === 0 ? 0 : Math.floor(Math.log10(abs));
  // 三位有效数字落在小数第几位：0.00075 → 第 6 位；0.08 → 第 4 位；44.66 → 第 2 位。
  const decimals = Math.min(12, Math.max(2, SIGNIFICANT_DIGITS - 1 - exponent));
  const [whole, fraction = ''] = value.toFixed(decimals).split('.');
  return `${whole}.${fraction.slice(0, 2)}${fraction.slice(2).replace(/0+$/, '')}`;
}

/**
 * 纳美元 → 人类可读。1e9 = $1。
 *
 * 按**有效数字**给位数，不按固定小数位：同一个账本里既有 $0.00075 的一次搜索，也有 $0.08
 * 的一张图、$0.95 的余额。固定小数位会让小额只剩一位有效数字（0.00075 → $0.0008，读起来
 * 像多收了 7%）；固定的有效位数让每一档都留三位——量级不同，精度一致。
 *
 * 两条护栏：不小于一分时至少给到分（$44.66 不会被印成 $45），末尾的零只在第二位小数之后
 * 才收掉（$1.50 仍是 $1.50，$0.000750 收成 $0.00075）。
 */
export function usd(nanos: number | null | undefined): string {
  if (nanos === null || nanos === undefined) return '—';
  if (nanos === 0) return '$0';
  return `$${decimal(nanos / 1_000_000_000)}`;
}

/** 带符号：流水里 grant 是正、charge 是负。 */
export function signedUsd(nanos: number): string {
  const body = usd(Math.abs(nanos));
  return nanos < 0 ? `−${body}` : `+${body}`;
}

export function when(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.length <= 20 ? hash : `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

export function latency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function tokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

export function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * 上游在页面上叫什么：有标签用标签，没有就用主机名。
 *
 * 标签是可选的（`null` = 没填），但页面上总得有个能认人的字。主机名是这条上游自己的
 * `base_url` 说了算的那一段，谁看都一样，也不会是空的——所以空标签退回它，而不是
 * 编一个「未命名」出来占位。
 */
export function providerName(label: string | null | undefined, host: string): string {
  const text = label?.trim() ?? '';
  if (text !== '') return text;
  return host.trim() !== '' ? host : '—';
}

/** 占比：`cached / input`。缓存命中率是账本上最值得盯的一个比值。 */
export function percent(part: number | null | undefined, whole: number | null | undefined): string {
  if (!whole || whole <= 0 || part === null || part === undefined) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 官方价：纳美元 / 1M token → 每百万 token 的美元。
 *
 * 与 `usd()` 同一条格式（三位有效数字），只是数值本身是「每百万 token 的价」：价目表里
 * 常有 $0.075 这种单价，四舍五入到分（$0.08）会让「官方价」这个锚点先自己失真。
 */
export function perMillion(nanos: number): string {
  if (nanos === 0) return '$0';
  return `$${decimal(nanos / 1_000_000_000)}`;
}

/**
 * 地址的缩略形态：前 4 位 + … + 后 4 位。
 *
 * 用地址而不是 id，是因为地址（Ed25519 公钥）走到哪儿都能自证是谁；
 * 缩略只是别让一列 44 个字符把表格撑爆，完整值挂在 title 上。
 */
export function shortKey(address: string | null | undefined): string {
  if (!address) return '—';
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
