import { Hono } from 'hono';
import type { Env } from '../env';
import { groupByBaseUrl } from '../base-urls';
import { nowSeconds } from '../ids';
import { PROTOCOL_SCHEMAS } from '../protocols';

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get('/health', (c) =>
  c.json({ ok: true, service: 'norm', version: '0.1.0', now: nowSeconds() }),
);

/**
 * 公开看板的缓存窗口：`/stats` 要数一遍整张 `requests` 表，而 D1 按行计费。
 * 整条响应在边缘缓存一个 TTL，全表扫于是每个 colo 每个窗口只发生一次，
 * 而不是每个访客一次。60 秒是「数量级够新」与「读放大够小」之间的取舍。
 */
const STATS_TTL_SECONDS = 60;

publicRoutes.get('/stats', async (c) => {
  // 缓存键固定成不带查询串的规范 URL：这个端点没有参数，查询串只是噪音。
  const cacheKey = new Request(new URL('/api/v1/stats', c.req.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM principals) AS principals,
       (SELECT COUNT(*) FROM providers WHERE revoked_at IS NULL AND enabled = 1) AS providers,
       (SELECT COUNT(*) FROM requests) AS requests,
       -- Gas（付给 Norm）与 Token（用户间价值转移）分开统计，均直接读 principals 累计数，不扫请求表。
       (SELECT COALESCE(SUM(gas_spend_nanos), 0) FROM principals) AS gas_spend_nanos,
       (SELECT COALESCE(SUM(token_spend_nanos), 0) FROM principals) AS token_spend_nanos,
       (SELECT COALESCE(SUM(earn_nanos), 0) FROM principals) AS earn_nanos,
       (SELECT COALESCE(SUM(gas_spend_nanos + token_spend_nanos), 0) FROM principals) AS spend_nanos`,
  ).first<{
    principals: number;
    providers: number;
    requests: number;
    gas_spend_nanos: number;
    token_spend_nanos: number;
    earn_nanos: number;
    spend_nanos: number;
  }>();

  const response = c.json({ ...row, window_hours: null }, 200, {
    'Cache-Control': `public, max-age=${STATS_TTL_SECONDS}`,
  });
  // 落缓存不占这次响应的延迟：访客先拿到这一版，写入交给 waitUntil。
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

/**
 * 上游提供商看板：按 base_url 聚合。
 *
 * 这里没有「官方 / 第三方」这类判断——后端只回事实与一个 `trusted` 布尔
 * （主机名是否在 `TRUSTED_BASE_URLS` 清单里）。「官方 key」是前端按这个布尔
 * 渲染出来的标签，属于 UI 概念，换个清单说法就变，数据层不动。
 */
publicRoutes.get('/base-urls', async (c) =>
  c.json({ items: await groupByBaseUrl(c.env) }, 200, {
    // 浏览器与代理侧短缓存 60 秒（与 /stats 同口径），减少重复读打进 Worker；
    // 刻意不写 Worker 内 caches.default，保持新增/启停上游后直连接口的读后写一致性。
    'Cache-Control': 'public, max-age=60',
  }),
);

/**
 * 协议清单：每条协议的上游契约——说什么方言、基址由谁给、配置时要填哪些字段。
 *
 * 前端的表单「先选协议、再按协议渲染字段」读的就是这张表，服务端创建时也按同一份判定；
 * 没有秘密，所以公开。加一条协议 = 这里多一行，前后端都不用改。
 */
publicRoutes.get('/protocols', (c) =>
  c.json({ items: PROTOCOL_SCHEMAS }, 200, {
    // 编译期常量表，随部署更新，允许浏览器/代理缓存 5 分钟压缩免费读流量。
    'Cache-Control': 'public, max-age=300',
  }),
);

/**
 * 可信发布证明：把「线上跑的到底是哪份代码」变成可核对的数字。
 * 这些值由 CI 在构建后写入 Worker 变量（见 .github/workflows/release.yml），
 * 任何人 `pnpm build` 后算一次 sha256 就能比出来。
 */
publicRoutes.get('/attestation', (c) =>
  c.json({
    service: 'norm',
    repository: 'https://github.com/No-Trade-No-Life/norm',
    commit: c.env.ATTEST_COMMIT || null,
    built_at: c.env.ATTEST_BUILT_AT || null,
    source_sha256: c.env.ATTEST_SOURCE_SHA256 || null,
    assets_sha256: c.env.ATTEST_ASSETS_SHA256 || null,
    run_url: c.env.ATTEST_RUN_URL || null,
    // 只报「是哪一条」的机器可读编号，措辞由每个客户端自己决定——
    // 把这些句子写死在这里，英文界面就会原样显示中文。
    policy: {
      logs: 'no-bodies',
      storage: 'billing-fields-only',
      keys: 'sealed-at-rest',
    },
  }, 200, {
    // 构建证明必须是「现在这一版」：它一旦被边缘缓存，部署核对就会读到上一版，
    // 把一次成功的上线判成失败（2026-11-25 那次就是这样红的）。
    'Cache-Control': 'no-store',
  }),
);
