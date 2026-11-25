import { Hono } from 'hono';
import type { Env } from '../env';
import { groupByBaseUrl } from '../base-urls';
import { nowSeconds } from '../ids';

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get('/health', (c) =>
  c.json({ ok: true, service: 'norm', version: '0.1.0', now: nowSeconds() }),
);

publicRoutes.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM principals) AS principals,
       (SELECT COUNT(*) FROM credentials WHERE revoked_at IS NULL) AS credentials,
       (SELECT COUNT(*) FROM requests) AS requests,
       (SELECT COALESCE(SUM(fee_micros), 0) FROM requests) AS spend_micros`,
  ).first<{ principals: number; credentials: number; requests: number; spend_micros: number }>();
  return c.json({ ...row, window_hours: null });
});

/**
 * 上游渠道看板：按 base_url 聚合。
 *
 * 这里没有「官方 / 第三方」这类判断——后端只回事实与一个 `trusted` 布尔
 * （主机名是否在 `TRUSTED_BASE_URLS` 清单里）。「官方 key」是前端按这个布尔
 * 渲染出来的标签，属于 UI 概念，换个清单说法就变，数据层不动。
 */
publicRoutes.get('/base-urls', async (c) => c.json({ items: await groupByBaseUrl(c.env) }));

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
  }),
);
