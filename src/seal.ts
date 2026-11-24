import type { Env } from './env';

/**
 * 上游密钥在库里的封装：AES-256-GCM，密钥来自 Worker secret `NORM_MASTER_KEY`。
 *
 * 为什么放在服务端而不是让用户记口令：口令那一层只保护「存储中的副本」，
 * 而中转站每次调用都必然看见明文——它防不住运行期，只能防拖库。
 * 既然目标是拖库，那用一把由系统配置的高熵密钥就够了，且没有弱口令问题。
 *
 * 代价要说清：拿到这把密钥又拿到库，就能解开所有上游密钥。所以它是
 * Worker secret（不进仓库、不进 D1、不进日志），轮换即全量重封（见 docs/rotate-key.md）。
 */
const IV_BYTES = 12;

function decodeKey(raw: string): Uint8Array {
  // 只接受 base64url 的 32 字节：其他长度直接失败，不做「尽力而为」的兼容。
  const normalized = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32) throw new Error(`NORM_MASTER_KEY 必须是 32 字节（当前 ${bytes.length}）`);
  return bytes;
}

async function masterKey(env: Env): Promise<CryptoKey> {
  if (!env.NORM_MASTER_KEY) throw new Error('缺少 NORM_MASTER_KEY');
  return crypto.subtle.importKey('raw', decodeKey(env.NORM_MASTER_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * AAD 把密文绑到「哪个账户的哪条凭证」。这样即使两条记录被互换，
 * 解密也会失败——不需要额外的完整性字段。
 */
function aad(address: string, credentialId: string): Uint8Array {
  return new TextEncoder().encode(`${address}|${credentialId}`);
}

/** 返回 base64url(iv || ciphertext||tag)。 */
export async function sealUpstreamKey({
  env,
  address,
  credentialId,
  upstreamKey,
}: {
  env: Env;
  address: string;
  credentialId: string;
  upstreamKey: string;
}): Promise<string> {
  const key = await masterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(address, credentialId) },
      key,
      new TextEncoder().encode(upstreamKey),
    ),
  );
  const packed = new Uint8Array(iv.length + sealed.length);
  packed.set(iv, 0);
  packed.set(sealed, iv.length);
  return btoa(String.fromCharCode(...packed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 解封。密文被改、AAD 不匹配、密钥轮换过，都会抛错——不静默返回空串。 */
export async function unsealUpstreamKey({
  env,
  address,
  credentialId,
  sealed,
}: {
  env: Env;
  address: string;
  credentialId: string;
  sealed: string;
}): Promise<string> {
  const normalized = sealed.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const packed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) packed[i] = binary.charCodeAt(i);
  if (packed.length <= IV_BYTES) throw new Error('密文长度不合法');

  const key = await masterKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, IV_BYTES), additionalData: aad(address, credentialId) },
    key,
    packed.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}

/** 展示用提示：前 4 + … + 后 4。只在创建时算一次，明文不留在库里。 */
export function keyHintOf(upstreamKey: string): string {
  const trimmed = upstreamKey.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
