export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  REQUEST_FEE_MICROS: string;
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

export function feeMicros(env: Env): number {
  return Number(env.REQUEST_FEE_MICROS);
}

export function grantMicros(env: Env): number {
  return Number(env.GRANT_MICROS);
}

export function signatureWindowSeconds(env: Env): number {
  return Number(env.SIGNATURE_WINDOW_SECONDS);
}
