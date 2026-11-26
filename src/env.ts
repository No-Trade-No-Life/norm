import { DEFAULT_MIN_BALANCE_NANOS, GAS_FLOOR_NANOS } from './gas';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * 转发面余额安全阈值（纳美元）：余额低于该值时在入口直接 402 拒绝，
   * 不做任何 D1 写入也不打上游。实际生效值不会低于单次最低执行 Gas（GAS_FLOOR_NANOS）。
   */
  MIN_BALANCE_NANOS?: string;
  GRANT_NANOS: string;
  SIGNATURE_WINDOW_SECONDS: string;
  TRUSTED_BASE_URLS: string;
  /**
   * 亲和的有效期：一个 thread-id / session-id 在这段时间里留在同一条上游上。
   * 到期不是「换一台」，而是重新按候选集挑一次——候选没变通常还是同一条。
   */
  AFFINITY_TTL_SECONDS: string;
  /**
   * 可以往公共池里放上游的地址，逗号分隔，空 = 没有人可以。
   *
   * 池子里的密钥是站点的，谁都能用；所以「谁能往里放」必须是一个显式清单，
   * 不能是「谁先建谁算」。地址是公钥，不是秘密。
   */
  POOL_ADMIN_ADDRESSES: string;
  /** 32 字节 base64url，只由 `wrangler secret put` 写入，不进仓库、不进 D1。 */
  NORM_MASTER_KEY: string;
  ATTEST_COMMIT: string;
  ATTEST_BUILT_AT: string;
  ATTEST_SOURCE_SHA256: string;
  ATTEST_ASSETS_SHA256: string;
  ATTEST_RUN_URL: string;
};

/** 转发面入口安全余额阈值：缺省 10,000 纳美元，且绝不低于最低完整执行 Gas。 */
export function minBalanceNanos(env: Env): number {
  const configured = Number(env.MIN_BALANCE_NANOS);
  const threshold = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MIN_BALANCE_NANOS;
  return Math.max(threshold, GAS_FLOOR_NANOS);
}

export function grantNanos(env: Env): number {
  return Number(env.GRANT_NANOS);
}

export function signatureWindowSeconds(env: Env): number {
  return Number(env.SIGNATURE_WINDOW_SECONDS);
}

/** 亲和有效期。缺省 7 天：一个线程活得比一次会话长，但没人指望它活过一周。 */
export function affinityTtlSeconds(env: Env): number {
  const ttl = Number(env.AFFINITY_TTL_SECONDS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 604_800;
}

/** 这个地址能不能往公共池里放上游。 */
export function canOwnPool(env: Env, address: string): boolean {
  return (env.POOL_ADMIN_ADDRESSES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(address);
}
