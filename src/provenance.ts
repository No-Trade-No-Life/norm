/**
 * 上游来源核验：只产出「信号」，不产出「证明」。
 * 一个伪造的 base_url 也能通过 host 检查，所以这里同时保留 base_url 原文与核验时间，
 * 让任何人都能自己重跑一次核验（见 GET /api/v1/provenance）。
 */
export type ProvenanceSignal = 'host' | 'key_prefix' | 'models_probe';

export type Provenance = {
  declared_source: string;
  verified: boolean;
  signals: ProvenanceSignal[];
  checks: { host: boolean; key_prefix: boolean; models_probe: boolean | null };
  host: string;
  checked_at: number;
  note: string;
};

const OFFICIAL_HOSTS: Record<string, string[]> = {
  openai: ['api.openai.com', 'api.openai.azure.com'],
  deepseek: ['api.deepseek.com'],
  anthropic: ['api.anthropic.com'],
  google: ['generativelanguage.googleapis.com'],
  xai: ['api.x.ai'],
  moonshot: ['api.moonshot.cn'],
  zhipu: ['open.bigmodel.cn'],
  qwen: ['dashscope.aliyuncs.com'],
};

const KEY_PREFIXES: Record<string, string[]> = {
  openai: ['sk-', 'sk-proj-'],
  deepseek: ['sk-'],
  anthropic: ['sk-ant-'],
  google: ['AIza'],
  xai: ['xai-'],
  moonshot: ['sk-'],
  zhipu: [''],
  qwen: ['sk-'],
};

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function declaredSourceOf(source: string): string {
  return source;
}

/**
 * 自部署与其他来源不适用官方主机表：它们本来就该是「别处」，
 * 用官方表去判只会把诚实的人判成骗子。这里的 note 会原样公开。
 */
export function checkProvenance({
  provider,
  baseUrl,
  upstreamKey,
  declaredSource,
  checkedAt,
}: {
  provider: string;
  baseUrl: string;
  upstreamKey: string;
  declaredSource: string;
  checkedAt: number;
}): Provenance {
  const host = hostOf(baseUrl);
  const officialHosts = OFFICIAL_HOSTS[provider] ?? [];
  const hostHit = officialHosts.includes(host);
  const prefixes = KEY_PREFIXES[provider] ?? [];
  const keyHit = prefixes.some((p) => upstreamKey.startsWith(p));
  const relevant = declaredSourceOf(declaredSource) === 'official-api-key' || declaredSource === 'official-subscription';
  const checks = { host: hostHit, key_prefix: keyHit, models_probe: null as boolean | null };
  const signals: ProvenanceSignal[] = [];
  if (hostHit) signals.push('host');
  if (keyHit) signals.push('key_prefix');
  return {
    declared_source: declaredSource,
    // 声明为官方却对不上官方主机：这就是「掺水」，无论密钥检查是否通过。
    verified: relevant ? hostHit && keyHit : hostHit,
    signals,
    checks,
    host,
    checked_at: checkedAt,
    note: relevant
      ? `声明为官方来源；官方主机表 ${officialHosts.join(', ') || '（无）'}`
      : '非官方来源（自部署/其他）：主机表不适用，只公开 base_url 供人工核对',
  };
}

export async function probeModels({
  baseUrl,
  upstreamKey,
}: {
  baseUrl: string;
  upstreamKey: string;
}): Promise<boolean | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${upstreamKey}` },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data) && body.data.length > 0;
  } catch {
    return null;
  }
}
