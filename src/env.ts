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
