import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

/**
 * 身份 = 32 字节种子。地址 = base58(ed25519 公钥)。
 * 种子只落在 localStorage['norm.identity.seed']（base58 文本），从不发往任何服务端。
 */
export const SEED_STORAGE_KEY = 'norm.identity.seed';

export type Identity = {
  seed: Uint8Array;
  address: string;
  publicKey: Uint8Array;
};

export function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed 必须是 32 字节');
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, address: base58.encode(publicKey), publicKey };
}

export function loadStoredSeed(): Uint8Array | null {
  try {
    const text = localStorage.getItem(SEED_STORAGE_KEY);
    if (!text) return null;
    const bytes = base58.decode(text.trim());
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function storeSeed(seed: Uint8Array): void {
  localStorage.setItem(SEED_STORAGE_KEY, base58.encode(seed));
}

/** 导出给用户备份：base58 文本。 */
export function exportSeed(seed: Uint8Array): string {
  return base58.encode(seed);
}

/** 导入：解析并校验长度，返回种子（不落盘，调用方决定何时 storeSeed）。 */
export function parseSeed(text: string): Uint8Array {
  const bytes = base58.decode(text.trim());
  if (bytes.length !== 32) throw new Error('seed 必须是 32 字节（base58 文本）');
  return bytes;
}

export function sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

export function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  return ed25519.verify(signature, message, publicKey);
}
