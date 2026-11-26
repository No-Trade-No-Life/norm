/**
 * Node 测试环境里没有 workerd 的 socket 原语。
 *
 * 测试里的上游请求都走「没配代理」那条路（`sendUpstream` 直接 `fetch`），所以这个桩只需要
 * 在真被调用时大声失败，而不是假装连上了。
 */
export function connect(): never {
  throw new Error('cloudflare:sockets 只在 Worker 运行时里可用');
}
