export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Norm 的服务费：每一次被隔离执行的调用固定收一笔，微美元。
   *
   * 它的来源是 Cloudflare 侧的均摊成本，而不是 token。一次调用写 3 行 D1
   * （requests / ledger / nonce，约 3 µ$）、一次 Worker 调用（约 0.3 µ$）、
   * 加日志与读取，边际成本在 5 µ$ 上下；固定开销（部署、观测、免费额度之外的余量）
   * 再按请求数摊一层，所以定在 100 µ$，留 20 倍余量。
   *
   * 授信用完之前不涨价：改这个值等于改所有人的账单，属于一次可被审查的合并。
   */
  SERVICE_FEE_MICROS: string;
  GRANT_MICROS: string;
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

export function serviceFeeMicros(env: Env): number {
  return Number(env.SERVICE_FEE_MICROS);
}

export function grantMicros(env: Env): number {
  return Number(env.GRANT_MICROS);
}

export function signatureWindowSeconds(env: Env): number {
  return Number(env.SIGNATURE_WINDOW_SECONDS);
}
