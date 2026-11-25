import type { Env } from './env';

/**
 * 信任 = 一份 base_url 清单。
 *
 * 这里不做任何判断，只做事实查找：主机名是否在 `TRUSTED_BASE_URLS` 里。
 * 「官方 key」不是后端的类型，而是前端按这份清单渲染出来的标签——
 * 换一份清单，同一个上游就换个说法，数据层不需要动。
 *
 * 清单用「精确主机名」而不是后缀：`api.openai.com` 与 `api.openai.com.evil.tld`
 * 是两台完全不同的机器，后缀匹配会把后者也放进来。
 */
export function trustedHosts(env: Env): string[] {
  return (env.TRUSTED_BASE_URLS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

export function isTrusted(baseUrl: string, env: Env): boolean {
  const host = hostOf(baseUrl);
  return host.length > 0 && trustedHosts(env).includes(host);
}

export type BaseUrlGroup = {
  base_url: string;
  host: string;
  trusted: boolean;
  credentials: number;
  public_listed: number;
  protocols: string[];
  last_seen_at: number;
};

type GroupRow = {
  base_url: string;
  credentials: number;
  public_listed: number;
  protocols: string;
  last_seen_at: number;
};

/**
 * 按 base_url 聚合：同一个上游被多少条凭证用着、其中有几条公开、说过哪些协议。
 * 这是后端唯一关于「上游」的视图——没有官方/第三方，只有地址与计数。
 */
export async function groupByBaseUrl(env: Env): Promise<BaseUrlGroup[]> {
  const { results } = await env.DB.prepare(
    `SELECT base_url,
            COUNT(*) AS credentials,
            SUM(public_listed) AS public_listed,
            GROUP_CONCAT(DISTINCT upstream_protocol) AS protocols,
            MAX(created_at) AS last_seen_at
     FROM credentials
     WHERE revoked_at IS NULL
     GROUP BY base_url
     ORDER BY credentials DESC, base_url ASC`,
  ).all<GroupRow>();

  return results.map((row) => ({
    base_url: row.base_url,
    host: hostOf(row.base_url),
    trusted: isTrusted(row.base_url, env),
    credentials: row.credentials,
    public_listed: row.public_listed ?? 0,
    protocols: (row.protocols ?? '').split(',').filter((p) => p.length > 0),
    last_seen_at: row.last_seen_at,
  }));
}
