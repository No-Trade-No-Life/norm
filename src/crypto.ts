import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from './ids';

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 待签名串：docs/crypto.md 第 2 节。签名与验签都必须用这一个函数生成。 */
export function signingMessage({
  method,
  path,
  timestamp,
  bodySha256Hex,
}: {
  method: string;
  path: string;
  timestamp: string;
  bodySha256Hex: string;
}): Uint8Array {
  return utf8(`norm-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodySha256Hex}`);
}

/**
 * 验签。
 *
 * `ed25519.verify` 本身对「全零公钥 + 全零签名」返回 true（小阶/恒等点退化情形），
 * 而 Norm 的地址是用户自报的，所以这条退化路径等于"任何人都能声称自己是零地址"。
 * 因此在验签之前先做两项拒绝：公钥必须是曲线上的合法点，签名不能是零串。
 */
export function verifySignature({
  address,
  signature,
  message,
}: {
  address: string;
  signature: string;
  message: Uint8Array;
}): boolean {
  let publicKey: Uint8Array;
  let sig: Uint8Array;
  try {
    publicKey = base58.decode(address);
    sig = base58.decode(signature);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  if (sig.every((byte) => byte === 0)) return false;
  if (!ed25519.utils.isValidPublicKey(publicKey)) return false;
  try {
    return ed25519.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}
