import { base58 } from '@scure/base';

import {
  encodeKeypair,
  keypairFromSeed,
  loadStoredKeypair,
  parseKeypairText,
  publicKeyOf,
  randomKeypair,
  seedKeyOf,
  signWithKeypair,
  storeKeypair,
  type SeedStore,
  type StoredKeypair,
} from './seed';

/**
 * 身份 = 64 字节展开密钥（`seed || publicKey`，与 Solana 的密钥种子同形）。
 * 地址 = base58(publicKey)。
 * 密钥只落在 localStorage，从不发往任何服务端。
 *
 * 编解码与旧格式迁移都在 `./seed`——这个文件只负责把字节折成「有地址的身份」。
 */

export type Identity = {
  keypair: Uint8Array;
  address: string;
  publicKey: Uint8Array;
};

/** 64 字节密钥 → 身份。地址取内嵌公钥，不再重新派生。 */
export function identityFromKeypair(keypair: Uint8Array): Identity {
  const publicKey = publicKeyOf(keypair);
  return { keypair, address: base58.encode(publicKey), publicKey };
}

export function identityFromSeed(seed: Uint8Array): Identity {
  return identityFromKeypair(keypairFromSeed(seed));
}

export function randomIdentity(): Identity {
  return identityFromKeypair(randomKeypair());
}

/** 读本机密钥；旧版 32 字节种子会被原地升级为 64 字节。 */
export function loadStoredIdentity(store: SeedStore): StoredKeypair | null {
  return loadStoredKeypair(store);
}

export function persistIdentity(store: SeedStore, keypair: Uint8Array): void {
  storeKeypair(store, keypair);
}

/** 导出给用户备份：base58 的 64 字节。 */
export function exportIdentity(keypair: Uint8Array): string {
  return encodeKeypair(keypair);
}

/** 导入：解析并校验，返回密钥（不落盘，调用方决定何时 persistIdentity）。 */
export function parseIdentity(text: string): Uint8Array {
  return parseKeypairText(text);
}

export function sign(keypair: Uint8Array, message: Uint8Array): Uint8Array {
  return signWithKeypair(keypair, message);
}

export function seedOf(keypair: Uint8Array): Uint8Array {
  return seedKeyOf(keypair);
}
