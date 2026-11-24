import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

/** docs/crypto.md 第 3 节：服务端只认这一串 kdf 标识。 */
export const KDF_ID = 'pbkdf2-sha256-600000+xchacha20poly1305';
const PBKDF2_ROUNDS = 600_000;
const SALT_PREFIX = 'norm-v1|';

const encoder = new TextEncoder();

/**
 * 口令派生密钥：PBKDF2-SHA256(passphrase, "norm-v1|" + address, 600000, 32)。
 * salt 里带上地址，防止同一口令在不同账号下派生出同一把钥匙。
 */
export function deriveKey(passphrase: string, address: string): Uint8Array {
  return pbkdf2(sha256, encoder.encode(passphrase), encoder.encode(`${SALT_PREFIX}${address}`), {
    c: PBKDF2_ROUNDS,
    dkLen: 32,
  });
}

/** 密封：base58(nonce24 || XChaCha20-Poly1305(key, nonce24, utf8(key), aad = utf8(address)))。 */
export function sealUpstreamKey(passphrase: string, address: string, upstreamKey: string): string {
  const key = deriveKey(passphrase, address);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const sealed = xchacha20poly1305(key, nonce, encoder.encode(address)).encrypt(encoder.encode(upstreamKey));
  const packed = new Uint8Array(nonce.length + sealed.length);
  packed.set(nonce, 0);
  packed.set(sealed, nonce.length);
  return base58.encode(packed);
}

/** 解封。口令错或密文被改过，AEAD 校验会抛错——调用方把它当成「口令不对」。 */
export function unsealUpstreamKey(passphrase: string, address: string, sealed: string): string {
  const packed = base58.decode(sealed.trim());
  if (packed.length <= 24) throw new Error('密文长度不合法');
  const key = deriveKey(passphrase, address);
  const nonce = packed.slice(0, 24);
  const body = packed.slice(24);
  const plain = xchacha20poly1305(key, nonce, encoder.encode(address)).decrypt(body);
  return new TextDecoder().decode(plain);
}

/** 展示用提示：前 4 + … + 后 4。明文密钥不进这里之外任何地方。 */
export function keyHint(upstreamKey: string): string {
  const trimmed = upstreamKey.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
