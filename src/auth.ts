import type { Env } from './env';
import { signatureWindowSeconds } from './env';
import { fail } from './http';
import { nowSeconds } from './ids';
import { sha256Hex, signingMessage, verifySignature } from './crypto';
import { ensurePrincipal, principalExists } from './store';

export type Principal = {
  address: string;
};

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
