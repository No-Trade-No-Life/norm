import { Hono } from 'hono';
import type { Env } from '../env';
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

/** 公开来源看板：只列出用户主动打开「公开透明」开关的凭证。 */
publicRoutes.get('/provenance', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, label, provider, base_url, key_hint, declared_source, provenance, created_at
     FROM credentials WHERE public_listed = 1 AND revoked_at IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  ).all<{
    id: string;
    label: string;
    provider: string;
    base_url: string;
    key_hint: string;
    declared_source: string;
    provenance: string;
    created_at: number;
  }>();
  return c.json({
    items: results.map((row) => ({
      id: row.id,
      label: row.label,
      provider: row.provider,
      base_url: row.base_url,
      key_hint: row.key_hint,
      declared_source: row.declared_source,
      provenance: JSON.parse(row.provenance),
      created_at: row.created_at,
    })),
  });
});

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
    policy: {
      logs: '不留请求体、不留响应体、不留上游密钥',
      storage: 'D1 只存记账所需的最小字段（模型名、token 数、状态、延迟、费用）',
      keys: '上游密钥只在请求头里经过，不落库；库里只有客户端加密后的密文',
    },
  }),
);
