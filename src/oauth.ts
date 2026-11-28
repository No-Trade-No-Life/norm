/**
 * OpenAI OAuth：把一份 ChatGPT 订阅当成一条上游。
 *
 * 这条协议跟别处最大的不同是「密钥」不是一把 API key，而是一对会过期的 OAuth 令牌：
 *
 *   access_token   短命的 Bearer，上游靠它认人。它是一枚 JWT：`exp` 说什么时候死，
 *                  `https://api.openai.com/auth.chatgpt_account_id` 说这是哪个工作区。
 *   refresh_token  长命的换新凭据。换新会**轮换**——换过一次，旧的就作废了。
 *
 * 所以库里存的是一个人能读懂、也能自己造的 JSON（`{access_token, refresh_token}`）。
 * 工作区 id 不跟着存：它是 access_token 里的 claim，再存一份只会跟令牌不一致。
 *
 * 四个常量（授权地址、换币地址、client_id、回调地址）全部来自 Codex CLI 这个公开客户端：
 * 走到订阅额度的那条路只有它这一条，没有给第三方注册的入口。回调是
 * `http://localhost:1455/auth/callback`——那台机器上**没有服务在听**，浏览器会停在
 * 「连不上」，而回调 URL 的地址栏里已经拿到了 code 与 state。把那一行贴回来，就是这一步
 * 全部的人机接口（OpenAI-LB 用的是同一套手势）。
 *
 * 安全边界说清：Norm 不存这次授权的任何状态。PKCE 的 verifier 与 state 随响应回到发起
 * 授权的浏览器，回调回来时再一起送回来——换币要的正是 verifier，而它只存在于那只浏览器里。
 * 没有服务端流程表，就没有过期清理，也没有多实例一致性问题。
 */
import type { ModelInfo } from './codecs';
import { nowSeconds } from './ids';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
/** 上游只认这个客户端家族：每个请求都要带 `originator`，少了它就像换了个客户端在敲门。 */
const ORIGINATOR = 'codex_cli_rs';

/** 一对令牌，外加从 access_token 里读出来的工作区 id（读不出来就进不了这里）。 */
export type OpenAICredential = {
  access_token: string;
  refresh_token: string;
  account_id: string;
};

/** 解析结果。写入口（新建 / 编辑上游）用它把「贴错了」变成一次 400，而不是一次上游 401。 */
export type CredentialParse = { ok: true; credential: OpenAICredential } | { ok: false; message: string };

/**
 * 把一份凭据读成一对令牌 + 工作区 id。
 *
 * 只认一种形状：JSON 里的 `access_token` 与 `refresh_token`。`~/.codex/auth.json` 那种
 * 套着 `tokens` 一层的外壳不认——那是别的工具的文件格式，不让它变成这条协议的契约。
 */
export function openaiCredentialOf(providerKey: string): CredentialParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(providerKey);
  } catch {
    return { ok: false, message: '凭据必须是 JSON：{"access_token":"…","refresh_token":"…"}' };
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const accessToken = typeof record.access_token === 'string' ? record.access_token.trim() : '';
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) {
    return { ok: false, message: '凭据里缺 access_token 或 refresh_token' };
  }
  const accountId = claimOf(accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id']);
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return { ok: false, message: 'access_token 不是 OpenAI 的 access token（读不出 chatgpt_account_id）' };
  }
  return { ok: true, credential: { access_token: accessToken, refresh_token: refreshToken, account_id: accountId } };
}

/** 存回库里的那份文本：只有两枚令牌，工作区 id 每次从令牌里现读。 */
export function openaiCredentialText(credential: OpenAICredential): string {
  return JSON.stringify({ access_token: credential.access_token, refresh_token: credential.refresh_token });
}

/** access_token 的过期时刻（unix 秒）；读不出来就是 null——「不知道」不是「永远有效」。 */
export function openaiExpiresAt(credential: OpenAICredential): number | null {
  const exp = claimOf(credential.access_token, ['exp']);
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

/**
 * 这枚 access_token 该不该换新。
 *
 * 留 `margin` 秒的余量：一枚正好在路上的令牌比死掉的更难查——它会在上游那侧过期，
 * 而账本上只留下一次 401。
 */
export function openaiNeedsRefresh(credential: OpenAICredential, marginSeconds: number): boolean {
  const expiresAt = openaiExpiresAt(credential);
  return expiresAt === null || expiresAt - marginSeconds <= nowSeconds();
}

/**
 * 上游请求头：Bearer 认人、`chatgpt-account-id` 指定工作区、`originator` 声明客户端家族。
 *
 * 这三个头缺任何一个，`/backend-api/codex` 回的都是不好查的 4xx，所以凭据读不出来时
 * 直接抛——不静默发一个缺头的请求。
 */
export function openaiHeaders(providerKey: string): Record<string, string> {
  const parsed = openaiCredentialOf(providerKey);
  if (!parsed.ok) throw new Error(parsed.message);
  return {
    Authorization: `Bearer ${parsed.credential.access_token}`,
    'chatgpt-account-id': parsed.credential.account_id,
    originator: ORIGINATOR,
    // ASSUMPTION: 不带 User-Agent 的请求会被 chatgpt.com 挡在 Cloudflare 那一层（403，回一页 HTML，
    // 连 JSON 都不是）。所以这里显式声明自己是谁——学 Codex 的家族名，不冒充它的版本号。
    'User-Agent': `${ORIGINATOR} (Norm)`,
  };
}

/** 展示用提示：OAuth 凭据没有「前四位」，能核对的是工作区 id。 */
export function openaiAccountHint(accountId: string): string {
  return accountId.length <= 8 ? accountId : `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

/**
 * 发起一次授权：PKCE（S256）与 state 都现生成，连同授权地址一起交给浏览器。
 *
 * `id_token_add_organizations` 与 `codex_cli_simplified_flow` 是 Codex CLI 授权请求里的
 * 原样两条：少了它们，回来的东西就不是它认的那种流程。
 */
export async function openaiAuthorize(): Promise<{ authorize_url: string; verifier: string; state: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: ORIGINATOR,
  }).toString();
  return { authorize_url: url.toString(), verifier, state };
}

/** 用回调 URL 里的 code 换第一对令牌。 */
export function openaiExchange({ code, verifier }: { code: string; verifier: string }): Promise<OpenAICredential> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
}

/** 换一枚新的 access_token。上游同时轮换 refresh_token，所以回的是**整对**。 */
export function openaiRefresh(credential: OpenAICredential): Promise<OpenAICredential> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: credential.refresh_token });
}

/** 换币与换新是同一条路：表单，不是 JSON。 */
async function tokenRequest(form: Record<string, string>): Promise<OpenAICredential> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...form, client_id: CLIENT_ID }).toString(),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`OpenAI OAuth 令牌端点回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  // 拿到的这一对再走一遍解析：缺字段、access_token 不是 JWT，都在这里断掉，
  // 不留一对「能存进去、但打不出去」的令牌在库里。
  const parsed = openaiCredentialOf(
    JSON.stringify({ access_token: json.access_token, refresh_token: json.refresh_token }),
  );
  if (!parsed.ok) throw new Error(`OpenAI OAuth 令牌端点回的凭据不可用：${parsed.message}`);
  return parsed.credential;
}

/** JWT payload 里的一个 claim，支持一层嵌套（`['https://api.openai.com/auth', 'chatgpt_account_id']`）。 */
function claimOf(token: string, path: string[]): unknown {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    let value: unknown = JSON.parse(decodeBase64Url(payload));
    for (const key of path) {
      value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : null;
    }
    return value;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Codex CLI 的清单端点：`{base}/models?client_version=<version>`。
 *
 * 它按客户端版本发清单：版本太旧回一张空表（实测 `0.58.0` 得到 `{models:[]}`，与「这张
 * 订阅真的没有模型」长得一模一样），省掉这个参数则直接 400。所以钉一个够新的版本，
 * 而不是不传——空表和错误在选址那里是两种事实。
 */
export const OAUTH_CLIENT_VERSION = '1.0.0';

/**
 * 读这份清单：`{models:[{slug, …}]}`，不是任何一种方言的形状。
 *
 * 只取 `slug`。清单里还挂着几十条客户端行为参数（工具、截断、并发、沙箱），那是 Codex
 * 自己的事；模态也不写——上游只声明了输入，输出那张表它没说，按方言同一套规矩宁缺勿猜。
 */
export function decodeOauthModels(json: unknown): ModelInfo[] {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    const slug = (entry as { slug?: unknown } | null)?.slug;
    return typeof slug === 'string' && slug.length > 0 ? [{ id: slug }] : [];
  });
}
