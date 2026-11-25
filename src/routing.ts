/**
 * 挑哪条上游：整块策略都在这里，纯函数，没有 IO。
 *
 * 三条规则，按顺序：
 *
 *   1. 自有优先 —— 候选里只要有一条自己名下的，公共池就整批退出。池子是兜底，
 *      不是「优先级低一点」：优先级低的池子会让一部分请求悄悄花在站点的密钥上。
 *   2. 会话粘住 —— 同一个 thread-id / session-id 在候选不变时永远落在同一条上游上。
 *      没有亲和键的请求按 rendezvous 随机摊开。
 *   3. rendezvous 而不是取模 —— 候选集增减时只有该搬的那部分会话会搬家，
 *      取模会把几乎所有会话一次性搬到另一台上去。
 *
 * 这一层不知道 D1、不知道请求、不知道 HTTP 状态码：那些在 store.resolveProvider 里。
 */
import { sha256Hex, utf8 } from './crypto';

/** 亲和键：thread-id 优先，其次 session-id。两者都没有 = 这次请求不粘。 */
const AFFINITY_HEADERS = ['thread-id', 'session-id'] as const;

export type AffinityKey = {
  /** 键来自哪个头。只用于回话与排错，不参与选择。 */
  source: (typeof AFFINITY_HEADERS)[number];
  value: string;
};

export function affinityKeyOf(headers: { get(name: string): string | null }): AffinityKey | null {
  for (const source of AFFINITY_HEADERS) {
    const value = headers.get(source)?.trim();
    if (value) return { source, value };
  }
  return null;
}

/** 亲和表的键：先把账户拼进去再哈希，所以它是「这个账户的这个会话」，不是全站一把。 */
export function affinityHash(address: string, key: string): string {
  return sha256Hex(utf8(`${address}|${key}`));
}

/** 亲和条目还有效吗：过期就等于没记住，下一次按候选重挑。 */
export function affinityFresh(expiresAt: number, now: number): boolean {
  return expiresAt > now;
}

/** 自有优先：有自有候选就只留自有的；一条都没有时原样返回（请求落到池子上）。 */
export function narrowToOwned<T extends { address: string }>(candidates: readonly T[], me: string): readonly T[] {
  const owned = candidates.filter((candidate) => candidate.address === me);
  return owned.length > 0 ? owned : candidates;
}

/**
 * rendezvous（最高随机权重）：同一个 seed 在候选不变时永远选中同一条，
 * 候选变化时只有落在被移除那条上的会话会搬家。
 *
 * 调用方保证 candidates 非空——「一条都没有」是业务错误，在这里表达不了。
 */
export function pickByRendezvous<T extends { id: string }>(candidates: readonly T[], seed: string): T {
  let best = candidates[0];
  let bestWeight = -1;
  for (const candidate of candidates) {
    // 稳定且与运行环境无关：两个 Worker 上同一个 (seed, id) 必须得到同一个数。
    const weight = fnv1a(`${seed}|${candidate.id}`);
    if (weight > bestWeight) {
      best = candidate;
      bestWeight = weight;
    }
  }
  return best;
}

/** FNV-1a 32 位：只用来打分，不用于任何密码学用途。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
