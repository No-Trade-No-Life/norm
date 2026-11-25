export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Norm 的 Gas 费：每一次**真的打出去**的调用固定收一笔，纳美元，与成败无关。
   *
   * 它买的是「这次请求被执行」本身，不是答案：一次 Worker 调用（Workers Paid 每百万次
   * $0.30，摊到一次正好 300 纳美元）加几次 D1 读写。上游回 500、密钥被吊销、地址根本
   * 打不通，这些成本一样发生过了——所以 Gas 照收，token 那部分才按结果算。
   *
   * 没打到上游的请求（请求体不是 JSON、余额不足、没配上游提供商）不收：没有执行可言。
   *
   * 改这个值等于改所有人的账单，属于一次可被审查的合并。
   */
  GAS_FEE_NANOS: string;
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

export function gasFeeNanos(env: Env): number {
  const fee = Number(env.GAS_FEE_NANOS);
  // 缺这个变量就没人知道该收多少：宁可整条转发报错，也不要让 NaN 流进账本。
  if (!Number.isFinite(fee)) throw new Error('GAS_FEE_NANOS 未配置或不是数字');
  return fee;
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
