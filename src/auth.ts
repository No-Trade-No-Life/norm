import type { Env } from './env';
import { signatureWindowSeconds } from './env';
import { fail } from './http';
import { nowSeconds } from './ids';
import { sha256Hex, signingMessage, verifySignature } from './crypto';
import { ensurePrincipal, principalExists } from './store';
import { principalFromConsumerKey } from './consumers';

export type Principal = {
  address: string;
  /**
   * 这次调用由哪把下游消费者密钥发起，只用于记账（账本要能回答「谁花的钱」）。
   * 签名直连时为空：那是一个人，不是一把程序凭据。
   */
  consumerId?: string;
};

/**
 * 下游密钥可能出现在三个不同的头里，因为那是各家 SDK 的硬编码习惯，不是我们选的：
 *
 *   Authorization: Bearer sk-norm-…    OpenAI SDK / Codex CLI / curl
 *   x-api-key: sk-norm-…               Anthropic SDK / Claude Code
 *   x-goog-api-key: sk-norm-…          Google SDK
 *
 * 只认带 `sk-norm-` 前缀的值——没有前缀的 api key 不是我们的身份，交给签名那条路去失败，
 * 免得把「上游密钥错放进请求头」误报成「身份无效」。
 */
function bearerOf(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;
  const [scheme, value] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !value) fail(401, 'authorization_invalid', 'Authorization 只支持 Bearer 消费者密钥');
  return value;
}

/**
 * 一个请求只有两种身份：消费者密钥，或 Ed25519 签名。
 * 三个 api key 头都没有 `sk-norm-` 值时就当成签名请求——它会带着缺失头部的说明失败。
 */
export async function resolvePrincipal(request: Request, env: Env): Promise<Principal> {
  const candidates = [
    bearerOf(request),
    request.headers.get('x-api-key'),
    request.headers.get('x-goog-api-key'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const key = candidates.find((value) => value.startsWith('sk-norm-'));
  if (key) return principalFromConsumerKey(env, key);
  return authenticate(request, env);
}

/**
 * 读取并校验签名请求。校验顺序是刻意的：先把便宜的检查（头部、时间窗）跑完，
 * 再花一次 D1 写去占用 nonce，最后才做验签的椭圆曲线运算。
 */
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const address = request.headers.get('X-Norm-Address');
  const timestamp = request.headers.get('X-Norm-Timestamp');
  const nonce = request.headers.get('X-Norm-Nonce');
  const signature = request.headers.get('X-Norm-Signature');
  if (!address || !timestamp || !nonce || !signature) {
    fail(401, 'signature_required', '缺少 X-Norm-Address / Timestamp / Nonce / Signature');
  }

  const skew = Math.abs(nowSeconds() - Number(timestamp));
  if (!Number.isInteger(Number(timestamp)) || skew > signatureWindowSeconds(env)) {
    fail(401, 'timestamp_out_of_window', `时间戳超出自适应窗口 ${signatureWindowSeconds(env)}s`);
  }

  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const message = signingMessage({
    method: request.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodySha256Hex: sha256Hex(body),
  });

  if (!verifySignature({ address, signature, message })) {
    fail(401, 'signature_invalid', '签名不匹配');
  }

  // 先占位再放行：nonce 的唯一键就是重放防护本身。
  const seenAt = nowSeconds();
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO nonces (address, nonce, seen_at) VALUES (?, ?, ?)',
  )
    .bind(address, nonce, seenAt)
    .run();
  if (inserted.meta.changes === 0) {
    fail(401, 'nonce_replayed', 'nonce 已经用过了');
  }

  // 老地址不为每次请求付一次写入：只有第一次见到这个公钥时才落库开户。
  if (!(await principalExists(env, address))) await ensurePrincipal(env, address, seenAt);
  return { address };
}
