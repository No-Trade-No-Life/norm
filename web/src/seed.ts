import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

/**
 * 身份密钥（keypair）的编解码 —— 对 64 字节展开形式。
 *
 * 扩展形式与 Solana 的密钥种子一致：`keypair = seed(32) || publicKey(32)`，
 * `seed` 是 RFC 8032 的私钥种子，`publicKey` 由它派生。这正是 `solana-keygen`
 * 写进 `id.json` 的那 64 个数字，也是 Solana SDK 里 `secretKey` 的布局。
 *
 * 为什么要 64 字节而不是只存 32：单一 32 字节种子在钱包生态里是「助记词之外的第二身份」，
 * 各家派生路径不一致；展开形式自带公钥，导入导出时不必再猜这条种子属于哪条曲线、
 * 也立刻能验出「种子与公钥不配对」的损坏文本，而不是生成一个静默的新地址。
 *
 * 旧版本浏览器里存的是 32 字节种子的 base58（`norm.identity.seed`），
 * 本模块的 `loadStoredKeypair` 会把它原地升级成 64 字节，地址不变、账户不变。
 *
 * 所有编码都是 base58（Bitcoin 字母表）；导入额外接受 Solana 的 JSON 数组形式。
 * 这个文件不碰 localStorage：存储句柄由调用方传入，逻辑才能在 Node 里被测试。
 */

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
/** 64 = 32 字节种子 + 32 字节公钥，与 Solana 的 secretKey 展开形式一致。 */
export const KEYPAIR_BYTES = SEED_BYTES + PUBLIC_KEY_BYTES;

/** 64 字节展开形式（新版）。 */
export const KEYPAIR_STORAGE_KEY = 'norm.identity.keypair';
/** 32 字节纯种子（旧版，只读一次用于迁移）。 */
export const LEGACY_SEED_STORAGE_KEY = 'norm.identity.seed';

/** localStorage 的结构子集——不 import DOM 类型，测试里可以塞一个假的。 */
export type SeedStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StoredKeypair = {
  keypair: Uint8Array;
  /** 这次读取顺手把旧 32 字节种子升级成了 64 字节——界面应当说一声。 */
  migratedFromLegacy: boolean;
};

const encoder = new TextEncoder();

function seedOf(keypair: Uint8Array): Uint8Array {
  return keypair.subarray(0, SEED_BYTES);
}

/** 由 32 字节种子派生 64 字节展开形式。 */
export function keypairFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new Error(`种子必须是 ${SEED_BYTES} 字节`);
  const publicKey = ed25519.getPublicKey(seed);
  const keypair = new Uint8Array(KEYPAIR_BYTES);
  keypair.set(seed, 0);
  keypair.set(publicKey, SEED_BYTES);
  return keypair;
}

/** 64 字节里的公钥段。 */
export function publicKeyOf(keypair: Uint8Array): Uint8Array {
  assertKeypair(keypair);
  return keypair.subarray(SEED_BYTES);
}

/** 64 字节里的种子段。noble 的 ed25519 只吃 32 字节种子。 */
export function seedKeyOf(keypair: Uint8Array): Uint8Array {
  assertKeypair(keypair);
  return seedOf(keypair);
}

export function randomKeypair(): Uint8Array {
  return keypairFromSeed(crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
}

export function encodeKeypair(keypair: Uint8Array): string {
  assertKeypair(keypair);
  return base58.encode(keypair);
}

/** Solana 的 `id.json` 形状：64 个 0..255 的整数。 */
export function encodeKeypairJson(keypair: Uint8Array): string {
  assertKeypair(keypair);
  return `[${[...keypair].join(',')}]`;
}

/**
 * 解析用户粘贴的密钥文本。接受的形状：
 *
 * - base58 的 64 字节展开形式（本版导出）
 * - base58 的 32 字节种子（旧版导出，升级为 64 字节）
 * - `[1,2,…]` JSON 数组，64 个数字（Solana `id.json`）或 32 个数字
 *
 * 64 字节里公钥必须与种子派生结果一致；不一致说明这段文本被截断或改过，
 * 拒绝比「按种子重新派生」更诚实——否则用户会以为自己在用那把公钥。
 */
export function parseKeypairText(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('密钥为空');

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('JSON 数组解析失败');
    }
    if (!Array.isArray(parsed)) throw new Error('需要 64 个 0..255 的整数');
    const bytes = parsed.map((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error('数组元素必须是 0..255 的整数');
      }
      return value;
    });
    return fromBytes(new Uint8Array(bytes));
  }

  let bytes: Uint8Array;
  try {
    bytes = base58.decode(trimmed);
  } catch {
    throw new Error('不是合法的 base58 文本');
  }
  return fromBytes(bytes);
}

function fromBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === KEYPAIR_BYTES) {
    assertKeypair(bytes);
    return bytes;
  }
  if (bytes.length === SEED_BYTES) return keypairFromSeed(bytes);
  throw new Error(`需要 ${KEYPAIR_BYTES} 字节（也接受旧的 ${SEED_BYTES} 字节种子），收到 ${bytes.length} 字节`);
}

function assertKeypair(keypair: Uint8Array): void {
  if (keypair.length !== KEYPAIR_BYTES) {
    throw new Error(`密钥必须是 ${KEYPAIR_BYTES} 字节，收到 ${keypair.length} 字节`);
  }
  const derived = ed25519.getPublicKey(seedOf(keypair));
  const embedded = keypair.subarray(SEED_BYTES);
  for (let i = 0; i < PUBLIC_KEY_BYTES; i += 1) {
    if (derived[i] !== embedded[i]) throw new Error('公钥段与种子不匹配：这段密钥已损坏或被改过');
  }
}

/**
 * 读本机密钥，并顺手迁移旧格式。
 *
 * 顺序：先看 64 字节新键；没有就看旧 32 字节；两者都没有返回 null（首次访问，调用方新建）。
 * 迁移是写新的、再删旧的：先写保证「删了旧的但没写成」不会丢密钥；删旧的保证
 * 不存在两份互相矛盾的身份来源。旧键读不懂（损坏/被改过）时不清空它，交给调用方按新身份处理，
 * 用户手动导出的备份还在，别让一次解析失败把唯一副本删掉。
 */
export function loadStoredKeypair(store: SeedStore): StoredKeypair | null {
  const current = readKey(store, KEYPAIR_STORAGE_KEY);
  if (current) return { keypair: current, migratedFromLegacy: false };

  const legacyText = store.getItem(LEGACY_SEED_STORAGE_KEY);
  if (!legacyText) return null;

  let migrated: Uint8Array;
  try {
    migrated = parseKeypairText(legacyText);
  } catch {
    // 旧值坏了：保留它，但这一轮当作没有身份。
    return null;
  }
  store.setItem(KEYPAIR_STORAGE_KEY, encodeKeypair(migrated));
  store.removeItem(LEGACY_SEED_STORAGE_KEY);
  return { keypair: migrated, migratedFromLegacy: true };
}

/** 新键存在但读不懂时同样返回 null：宁可新建，也不要拿半截密钥去签名。 */
function readKey(store: SeedStore, key: string): Uint8Array | null {
  const text = store.getItem(key);
  if (!text) return null;
  try {
    return parseKeypairText(text);
  } catch {
    return null;
  }
}

export function storeKeypair(store: SeedStore, keypair: Uint8Array): void {
  store.setItem(KEYPAIR_STORAGE_KEY, encodeKeypair(keypair));
  // 导入新密钥后旧种子就是上一把钥匙的残渣，留着只会制造歧义。
  store.removeItem(LEGACY_SEED_STORAGE_KEY);
}

export function signWithKeypair(keypair: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, seedKeyOf(keypair));
}

/** 只给需要 UTF-8 字节的地方用，避免各文件重复 TextEncoder。 */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}
