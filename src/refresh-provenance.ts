import type { Env } from './env';
import type { CredentialRow } from './store';
import { checkProvenance, probeModels, type Provenance } from './provenance';

/**
 * 用真实密钥刷新一次来源核验，并把结果写回凭证。
 *
 * 为什么必须等请求发生时才做：创建凭证时服务端拿不到明文密钥（BYOK），
 * `key_prefix` 与 `models_probe` 根本无从判断——把「当时算不出来」存成结论，
 * 公开看板就会长期展示过期信号。所以核验跟着真实调用走：有密钥才判得动。
 *
 * 只在结论**变化**时写库：一次核验跨路径是常态，不该为每一条请求多付一次写入。
 */
export async function refreshProvenance({
  env,
  credential,
  baseUrl,
  upstreamKey,
}: {
  env: Env;
  credential: CredentialRow;
  baseUrl: string;
  upstreamKey: string;
}): Promise<Provenance> {
  const next = checkProvenance({
    provider: credential.provider,
    baseUrl,
    upstreamKey,
    declaredSource: credential.declared_source,
    checkedAt: Math.floor(Date.now() / 1000),
  });

  const previous = JSON.parse(credential.provenance) as { verified?: boolean; signals?: string[] };
  const unchanged =
    previous.verified === next.verified &&
    JSON.stringify(previous.signals ?? []) === JSON.stringify(next.signals);

  // models_probe 是可用性探测：只在还没探过的时候做一次，失败也不阻塞转发。
  if (next.checks.models_probe === null) {
    const probed = await probeModels({ baseUrl, upstreamKey });
    next.checks.models_probe = probed;
    if (probed) next.signals.push('models_probe');
  }

  if (!unchanged) {
    await env.DB.prepare('UPDATE credentials SET provenance = ? WHERE id = ?')
      .bind(JSON.stringify(next), credential.id)
      .run();
    credential.provenance = JSON.stringify(next);
  }
  return next;
}
