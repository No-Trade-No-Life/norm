import type { Bill } from '../types';

/**
 * 合成回的是字节，账单塞不进音频里，所以它挂在响应头上（`docs/api.md`）。
 * 失败时只有 `X-Norm-Request-Id` 与 `X-Norm-Gas-Fee-Nanos`：那一笔没拿到东西，只付了 Gas。
 */
export function billFromHeaders(headers: Headers): Bill | null {
  const requestId = headers.get('X-Norm-Request-Id');
  const fee = numberHeader(headers, 'X-Norm-Fee-Nanos');
  const gas = numberHeader(headers, 'X-Norm-Gas-Billed-Nanos') ?? numberHeader(headers, 'X-Norm-Gas-Fee-Nanos');
  const token = numberHeader(headers, 'X-Norm-Token-Billed-Nanos');

  // 一个头都没有 = 这次拒绝发生在记账之前（例如没配上游、余额不足）：没有账可说。
  if (!requestId && fee === null) return null;
  return {
    request_id: requestId,
    fee_nanos: fee,
    gas_billed_nanos: gas,
    token_billed_nanos: token,
  };
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 字节数：音频文件常在 MiB 量级，只给小数字。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时长：转写按秒计价，所以毫秒要读成「3.4 秒」这种人话。 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '—';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}`;
}
