/**
 * 纳美元 → 人类可读。1e9 = $1。
 *
 * 分档按「这一档还有信息」来定：余额要读到分，一次调用的账单要读到 9 位小数——
 * 300 纳美元的服务费就是 $0.0000003，四舍五入到 6 位会显示成 $0.000000，
 * 而那不是「零」，是一笔真收了钱的账。
 */
export function usd(nanos: number | null | undefined): string {
  if (nanos === null || nanos === undefined) return '—';
  const value = nanos / 1_000_000_000;
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 0.01) return `$${value.toFixed(2)}`;
  if (abs >= 0.0001) return `$${value.toFixed(4)}`;
  if (abs >= 0.000001) return `$${value.toFixed(6)}`;
  // 更小的量级：给到 9 位，并把尾随的 0 收掉，免得一排 $0.000000300 读起来像噪声。
  return `$${value.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')}`;
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

/** 占比：`cached / input`。缓存命中率是账本上最值得盯的一个比值。 */
export function percent(part: number | null | undefined, whole: number | null | undefined): string {
  if (!whole || whole <= 0 || part === null || part === undefined) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 官方价：纳美元 / 1M token → 每百万 token 的美元。
 *
 * 与 usd() 分家的原因：价目表里常有 $0.075 这种三位小数的单价，
 * 四舍五入到分（$0.08）会让「官方价」这个锚点先自己失真。
 */
export function perMillion(nanos: number): string {
  const value = nanos / 1_000_000_000;
  if (value === 0) return '$0';
  // 至少两位小数（$1.10 而不是 $1.1），再多则保留有效位：$0.075 不能被舍成 $0.08。
  const [whole, fraction = ''] = value.toFixed(4).replace(/0+$/, '').split('.');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
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
