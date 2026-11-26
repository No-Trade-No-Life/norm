/**
 * 这次请求真正要发出去的那把「密钥」。
 *
 * 绝大多数协议里它就是库里那条密文解出来的明文。OpenAI OAuth 协议不一样：解出来的是一对
 * 令牌，access_token 会过期，用之前得先拿 refresh_token 换一枚新的。
 *
 * 换新**有副作用**——上游会轮换 refresh_token，换了不发生效，旧的那枚就作废了。所以换完
 * 必须写回库：不写回，下一次就拿着一枚已经死掉的令牌去换，整条上游从此只剩「重新连接」
 * 一条路。
 *
 * ASSUMPTION: 换新成功即视为可用，不等下一次请求回证。
 * 如果两个并发请求同时换新：上游只认后一枚 refresh_token，谁后写库谁生效。落败的那次手里
 * 的 access_token 已经作废，会收到一次上游 401——不是静默错误，客户端重试就会用上库里那一枚。
 */
import type { Env } from './env';
import { protocolFor, type Protocol } from './protocols';
import { openaiCredentialOf, openaiCredentialText, openaiNeedsRefresh, openaiRefresh } from './oauth';
import { sealProviderKey, unsealProviderKey } from './seal';
import { updateProviderSealedKey } from './store';

/** 换新的提前量：离过期不到两分钟就换，别让一枚正在路上的令牌变成一次上游 401。 */
export const CREDENTIAL_REFRESH_MARGIN_SECONDS = 120;

export type CredentialTarget = {
  id: string;
  protocol: Protocol;
  sealed_key: string;
};

export async function providerCredential({
  env,
  address,
  provider,
}: {
  env: Env;
  /** 持有者的地址（不是调用方的）：公共池里那条属于站点。 */
  address: string;
  provider: CredentialTarget;
}): Promise<string> {
  const sealed = await unsealProviderKey({ env, address, providerId: provider.id, sealed: provider.sealed_key });
  // 分支只有一条：除 OAuth 外的协议，密钥就是密钥，用不着换新。
  if (protocolFor(provider.protocol).oauth !== true) return sealed;

  const parsed = openaiCredentialOf(sealed);
  if (!parsed.ok) throw new Error(`这条上游的 OAuth 凭据读不出来：${parsed.message}`);
  if (!openaiNeedsRefresh(parsed.credential, CREDENTIAL_REFRESH_MARGIN_SECONDS)) return sealed;

  const refreshed = openaiCredentialText(await openaiRefresh(parsed.credential));
  await updateProviderSealedKey(env, {
    providerId: provider.id,
    sealed: await sealProviderKey({ env, address, providerId: provider.id, providerKey: refreshed }),
  });
  return refreshed;
}
