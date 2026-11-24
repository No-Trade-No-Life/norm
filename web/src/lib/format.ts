/** 微美元 → 人类可读。1e6 = $1，精度按量级给，避免把 $0.0005 显示成 $0.00。 */
export function usd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return '—';
  const value = micros / 1_000_000;
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  // 分档的意义：余额 $0.98 要读得懂，请求隔离费 $0.0005 也不能被四舍五入成 $0.00。
  if (abs >= 0.01) return `$${value.toFixed(2)}`;
  if (abs >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

/** 带符号：流水里 grant 是正、charge 是负。 */
export function signedUsd(micros: number): string {
  const body = usd(Math.abs(micros));
  return micros < 0 ? `−${body}` : `+${body}`;
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
