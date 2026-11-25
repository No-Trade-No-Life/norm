import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

import { errorText } from './lib/error-text';
import { loadStoredIdentity, sign } from './identity';

/** docs/api.md 的错误形状：{ error, message }。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 待签名串：docs/crypto.md 第 2 节。签名与发送必须共用同一串 body 字节。 */
export function signingMessage({
  method,
  path,
  timestamp,
  nonce,
  bodySha256Hex,
}: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): Uint8Array {
  return encoder.encode(
    `norm-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodySha256Hex}`,
  );
}

function randomNonce(): string {
  // 16 字节随机 → base58，约 22 字符。nonce 一经落库即作废。
  return base58.encode(crypto.getRandomValues(new Uint8Array(16)));
}

export type SignedRequest = {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  /** 已序列化好的字符串；不传就是无 body。序列化只发生一次，签名与发送同源。 */
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * 带签名的 fetch。
 *
 * 关键点（最容易踩的坑）：body 只序列化一次。调用方把 `JSON.stringify(x)` 的结果
 * 交进来，签名算它、发送也发它——绝不能在签名后再重新 stringify 一次对象，
 * 否则键序或空格变了，服务端验签必然失败。
 */
export async function signedFetch({ path, method = 'GET', body, headers, signal }: SignedRequest): Promise<Response> {
  const stored = loadStoredIdentity(localStorage);
  if (!stored) throw new ApiError(0, 'no_identity', '本地没有身份密钥');

  const bodyBytes = body === undefined ? new Uint8Array(0) : encoder.encode(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonce();
  // docs/crypto.md：PATH 取的是 URL 的 pathname，**不含 query**。
  // 签名用 pathname，请求用带 query 的完整路径，两者不能混。
  const message = signingMessage({
    method,
    path: path.split('?')[0],
    timestamp,
    nonce,
    bodySha256Hex: sha256Hex(bodyBytes),
  });
  const signature = base58.encode(sign(stored.keypair, message));
  // 地址取密钥里自带的那 32 字节公钥，不现场再派生一次。
  const address = base58.encode(stored.keypair.subarray(32));

  return fetch(path, {
    method,
    body: body === undefined ? undefined : bodyBytes,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Norm-Address': address,
      'X-Norm-Timestamp': timestamp,
      'X-Norm-Nonce': nonce,
      'X-Norm-Signature': signature,
      ...headers,
    },
    signal,
  });
}

/**
 * 非 2xx 一律变成 ApiError。文案统一过 `errorText`：上游提供商的错误体是各家方言，
 * 里面常嵌着对象，直接当字符串用的结果就是白屏。
 */
async function readError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `${response.status} ${response.statusText}`;
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error) code = data.error;
    message = errorText(data, message);
  } catch {
    // 不是 JSON：保持默认文案
  }
  return new ApiError(response.status, code, message);
}

/** 签名请求 + 解析 JSON。非 2xx 统一抛 ApiError，页面只处理一种错误形状。 */
export async function requestJson<T>(req: SignedRequest): Promise<T> {
  const response = await signedFetch(req);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

/* ── 转发面：只带下游消费者 Token ─────────────────────────────────────
 *
 * 推理接口不认签名（见 docs/api.md）：一条 `Authorization: Bearer sk-norm-…`
 * 就是全部凭据。三个 api key 头里我们只发 Authorization——另外两个是给别家 SDK 留的。
 */
export type ConsumerRequest = {
  path: string;
  consumerKey: string;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export function consumerFetch({ path, consumerKey, method = 'GET', body, headers, signal }: ConsumerRequest): Promise<Response> {
  return fetch(path, {
    method,
    body,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${consumerKey}`,
      ...headers,
    },
    signal,
  });
}

/** 消费者请求 + 解析 JSON。401 的处置（换钥匙重试）在 `./consumer-key` 里。 */
export async function consumerJson<T>(req: ConsumerRequest): Promise<T> {
  const response = await consumerFetch(req);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

export async function publicJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}
