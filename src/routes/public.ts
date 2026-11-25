import { Hono } from 'hono';
import type { Env } from '../env';
import { groupByBaseUrl } from '../base-urls';
import { nowSeconds } from '../ids';
import { PROTOCOL_SCHEMAS } from '../protocols';

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get('/health', (c) =>
  c.json({ ok: true, service: 'norm', version: '0.1.0', now: nowSeconds() }),
);

publicRoutes.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM principals) AS principals,
       (SELECT COUNT(*) FROM providers WHERE revoked_at IS NULL AND enabled = 1) AS providers,
       (SELECT COUNT(*) FROM requests) AS requests,
       (SELECT COALESCE(SUM(fee_nanos), 0) FROM requests) AS spend_nanos`,
  ).first<{ principals: number; providers: number; requests: number; spend_nanos: number }>();
  return c.json({ ...row, window_hours: null });
});

/**
 * 上游提供商看板：按 base_url 聚合。
 *
 * 这里没有「官方 / 第三方」这类判断——后端只回事实与一个 `trusted` 布尔
 * （主机名是否在 `TRUSTED_BASE_URLS` 清单里）。「官方 key」是前端按这个布尔
 * 渲染出来的标签，属于 UI 概念，换个清单说法就变，数据层不动。
 */
publicRoutes.get('/base-urls', async (c) => c.json({ items: await groupByBaseUrl(c.env) }));

/**
 * 协议清单：每条协议的上游契约——说什么方言、基址由谁给、配置时要填哪些字段。
 *
 * 前端的表单「先选协议、再按协议渲染字段」读的就是这张表，服务端创建时也按同一份判定；
 * 没有秘密，所以公开。加一条协议 = 这里多一行，前后端都不用改。
 */
publicRoutes.get('/protocols', (c) => c.json({ items: PROTOCOL_SCHEMAS }));

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
