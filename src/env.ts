export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Norm 的服务费：每一次被隔离执行的调用固定收一笔，纳美元。
   *
   * 它的来源是 Cloudflare 侧的均摊成本，而不是 token：一次调用要写几行 D1、
   * 一次 Worker 调用、加日志与读取。定在 300 纳美元（$0.0000003）是因为账本
   * 按纳美元记账——一次 40 token 的调用可能只值几十纳美元，服务费不该盖过它。
   *
   * 授信用完之前不涨价：改这个值等于改所有人的账单，属于一次可被审查的合并。
   */
  SERVICE_FEE_NANOS: string;
  GRANT_NANOS: string;
  SIGNATURE_WINDOW_SECONDS: string;
  TRUSTED_BASE_URLS: string;
  /** 32 字节 base64url，只由 `wrangler secret put` 写入，不进仓库、不进 D1。 */
  NORM_MASTER_KEY: string;
  ATTEST_COMMIT: string;
  ATTEST_BUILT_AT: string;
  ATTEST_SOURCE_SHA256: string;
  ATTEST_ASSETS_SHA256: string;
  ATTEST_RUN_URL: string;
};

export function serviceFeeNanos(env: Env): number {
  return Number(env.SERVICE_FEE_NANOS);
}

export function grantNanos(env: Env): number {
  return Number(env.GRANT_NANOS);
}

export function signatureWindowSeconds(env: Env): number {
  return Number(env.SIGNATURE_WINDOW_SECONDS);
}
