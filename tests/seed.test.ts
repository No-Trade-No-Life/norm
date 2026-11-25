import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

import {
  KEYPAIR_BYTES,
  KEYPAIR_STORAGE_KEY,
  LEGACY_SEED_STORAGE_KEY,
  encodeKeypair,
  encodeKeypairJson,
  keypairFromSeed,
  loadStoredKeypair,
  parseKeypairText,
  publicKeyOf,
  randomKeypair,
  seedKeyOf,
  signWithKeypair,
  storeKeypair,
  type SeedStore,
} from '../web/src/seed';

/** 内存版 localStorage：迁移逻辑不该依赖真实浏览器。 */
function fakeStore(initial: Record<string, string> = {}): SeedStore & { raw: Map<string, string> } {
  const raw = new Map(Object.entries(initial));
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => void raw.set(key, value),
    removeItem: (key) => void raw.delete(key),
  };
}

const randomSeed = () => crypto.getRandomValues(new Uint8Array(32));

describe('64 字节密钥（Solana 展开形式）', () => {
  it('展开形式 = 种子 + 派生公钥', () => {
    const seed = randomSeed();
    const keypair = keypairFromSeed(seed);
    expect(keypair.length).toBe(KEYPAIR_BYTES);
    expect(KEYPAIR_BYTES).toBe(64);
    expect([...seedKeyOf(keypair)]).toEqual([...seed]);
    expect([...publicKeyOf(keypair)]).toEqual([...ed25519.getPublicKey(seed)]);
  });

  it('base58 / JSON 数组往返不变', () => {
    const keypair = randomKeypair();
    expect([...parseKeypairText(encodeKeypair(keypair))]).toEqual([...keypair]);

    const json = encodeKeypairJson(keypair);
    expect(json.startsWith('[')).toBe(true);
    expect(JSON.parse(json)).toHaveLength(64);
    expect([...parseKeypairText(json)]).toEqual([...keypair]);
  });

  it('64 字节里公钥被改过就拒绝，而不是静默按种子重新派生', () => {
    const keypair = randomKeypair();
    const tampered = new Uint8Array(keypair);
    tampered[40] ^= 0xff;
    expect(() => parseKeypairText(encodeKeypair(tampered))).toThrow(/公钥段与种子不匹配/);
  });

  it('长度不对、字符非法、数组元素越界都拒绝', () => {
    expect(() => parseKeypairText('')).toThrow();
    expect(() => parseKeypairText(base58.encode(new Uint8Array(16)))).toThrow(/需要 64 字节/);
    expect(() => parseKeypairText('0OIl')).toThrow(/base58/);
    expect(() => parseKeypairText('[1,2,300]')).toThrow(/0\.\.255/);
    expect(() => parseKeypairText('[1,2,"x"]')).toThrow(/0\.\.255/);
    expect(() => parseKeypairText('[1,2,')).toThrow(/JSON/);
  });

  it('签名用种子段，与 32 字节种子的签名逐字节相同', () => {
    const seed = randomSeed();
    const keypair = keypairFromSeed(seed);
    const message = new TextEncoder().encode('norm-v1\nGET\n/api/v1/account/me\n1\nn\nhash');
    expect([...signWithKeypair(keypair, message)]).toEqual([...ed25519.sign(message, seed)]);
  });
});

describe('旧格式迁移（32 字节种子 → 64 字节）', () => {
  it('读到旧键就地升级，地址不变，旧键被删掉', () => {
    const seed = randomSeed();
    const legacyAddress = base58.encode(ed25519.getPublicKey(seed));
    const store = fakeStore({ [LEGACY_SEED_STORAGE_KEY]: base58.encode(seed) });

    const stored = loadStoredKeypair(store);
    expect(stored).not.toBeNull();
    expect(stored!.migratedFromLegacy).toBe(true);
    expect(base58.encode(publicKeyOf(stored!.keypair))).toBe(legacyAddress);

    // 写新键、删旧键：库里只留一份能说话的身份来源。
    expect(store.raw.has(KEYPAIR_STORAGE_KEY)).toBe(true);
    expect(store.raw.has(LEGACY_SEED_STORAGE_KEY)).toBe(false);

    // 再读一次：不再重复迁移，读到的还是同一把钥匙。
    const again = loadStoredKeypair(store);
    expect(again!.migratedFromLegacy).toBe(false);
    expect([...again!.keypair]).toEqual([...stored!.keypair]);
  });

  it('旧键是 Solana 风格的 32 数字数组也认', () => {
    const seed = randomSeed();
    const store = fakeStore({ [LEGACY_SEED_STORAGE_KEY]: `[${[...seed].join(',')}]` });
    const stored = loadStoredKeypair(store);
    expect(stored!.migratedFromLegacy).toBe(true);
    expect([...seedKeyOf(stored!.keypair)]).toEqual([...seed]);
  });

  it('旧键损坏时返回 null 且不删掉它——用户手抄的备份是唯一剩余副本', () => {
    const store = fakeStore({ [LEGACY_SEED_STORAGE_KEY]: 'not-base58-0OIl' });
    expect(loadStoredKeypair(store)).toBeNull();
    expect(store.raw.get(LEGACY_SEED_STORAGE_KEY)).toBe('not-base58-0OIl');
    expect(store.raw.has(KEYPAIR_STORAGE_KEY)).toBe(false);
  });

  it('已经有新键时不看旧键', () => {
    const fresh = randomKeypair();
    const store = fakeStore({
      [KEYPAIR_STORAGE_KEY]: encodeKeypair(fresh),
      [LEGACY_SEED_STORAGE_KEY]: base58.encode(randomSeed()),
    });
    const stored = loadStoredKeypair(store);
    expect(stored!.migratedFromLegacy).toBe(false);
    expect([...stored!.keypair]).toEqual([...fresh]);
  });

  it('两把键都没有时是 null（首次访问，调用方新建）', () => {
    expect(loadStoredKeypair(fakeStore())).toBeNull();
  });

  it('存新键会顺手清掉旧键', () => {
    const store = fakeStore({ [LEGACY_SEED_STORAGE_KEY]: base58.encode(randomSeed()) });
    storeKeypair(store, randomKeypair());
    expect(store.raw.has(LEGACY_SEED_STORAGE_KEY)).toBe(false);
    expect(store.raw.has(KEYPAIR_STORAGE_KEY)).toBe(true);
  });
});
