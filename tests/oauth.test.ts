import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openaiAccountHint,
  openaiAuthorize,
  openaiCredentialOf,
  openaiCredentialText,
  openaiExpiresAt,
  openaiHeaders,
  openaiNeedsRefresh,
  openaiRefresh,
} from '../src/oauth';

const base64url = (value: string): string =>
  btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 造一枚 OpenAI 形状的 access token：`exp` 与 `chatgpt_account_id` 都在 JWT 里。 */
function accessToken({ exp = Math.floor(Date.now() / 1000) + 3600, accountId = 'acct_12345678' } = {}): string {
  const payload = base64url(
    JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  );
  return `header.${payload}.signature`;
}

const credentialText = (overrides: { exp?: number; accountId?: string } = {}): string =>
  JSON.stringify({ access_token: accessToken(overrides), refresh_token: 'rt_123' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI OAuth 凭据', () => {
  it('读得出一对令牌与它声明的工作区', () => {
    const parsed = openaiCredentialOf(credentialText({ accountId: 'acct_abcdefgh' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.credential.account_id).toBe('acct_abcdefgh');
    expect(parsed.credential.refresh_token).toBe('rt_123');
  });

  it('贴错的三种东西都在写入口被挡住，而不是变成一次上游 401', () => {
    expect(openaiCredentialOf('sk-not-json').ok).toBe(false);
    expect(openaiCredentialOf(JSON.stringify({ access_token: accessToken() })).ok).toBe(false);
    // 有令牌，但不是 OpenAI 的：读不出 chatgpt_account_id。
    expect(
      openaiCredentialOf(
        JSON.stringify({ access_token: `header.${base64url(JSON.stringify({ exp: 1 }))}.sig`, refresh_token: 'rt' }),
      ).ok,
    ).toBe(false);
  });

  it('存回去的文本只有两枚令牌：工作区 id 是 claim，不存第二份', () => {
    const parsed = openaiCredentialOf(credentialText());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.parse(openaiCredentialText(parsed.credential))).toEqual({
      access_token: parsed.credential.access_token,
      refresh_token: 'rt_123',
    });
  });

  it('请求头三件套：Bearer、工作区、客户端家族', () => {
    const text = credentialText({ accountId: 'acct_zzzz9999' });
    expect(openaiHeaders(text)).toEqual({
      Authorization: `Bearer ${JSON.parse(text).access_token}`,
      'chatgpt-account-id': 'acct_zzzz9999',
      originator: 'codex_cli_rs',
      // 上游把「没有 User-Agent」的请求挡在 Cloudflare 那一层（403 HTML），所以它是必需头。
      'User-Agent': 'codex_cli_rs (Norm)',
    });
  });

  it('凭据读不出来时抛错——不静默发一个缺头的请求', () => {
    expect(() => openaiHeaders('{}')).toThrow('凭据里缺 access_token 或 refresh_token');
  });
});

describe('OpenAI OAuth 过期与换新', () => {
  const credential = (exp: number) => {
    const parsed = openaiCredentialOf(
      JSON.stringify({ access_token: accessToken({ exp }), refresh_token: 'rt_old' }),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.credential;
  };

  it('读得出 exp；读不出来就是 null（「不知道」不等于「永远有效」）', () => {
    expect(openaiExpiresAt(credential(1_800_000_000))).toBe(1_800_000_000);
    const noExp = openaiCredentialOf(
      JSON.stringify({
        access_token: `h.${base64url(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } }))}.s`,
        refresh_token: 'rt',
      }),
    );
    expect(noExp.ok).toBe(true);
    if (noExp.ok) expect(openaiExpiresAt(noExp.credential)).toBeNull();
  });

  it('到期余量内就换新：快死掉的令牌比死掉的更难查', () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    expect(openaiNeedsRefresh(credential(soon), 120)).toBe(true);
    expect(openaiNeedsRefresh(credential(soon + 600), 120)).toBe(false);
  });

  it('换新打的是令牌端点，拿回整对（上游会轮换 refresh_token）', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response(
        JSON.stringify({ access_token: accessToken({ exp: 1_900_000_000 }), refresh_token: 'rt_new' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const refreshed = await openaiRefresh(credential(Math.floor(Date.now() / 1000) - 10));
    expect(refreshed.refresh_token).toBe('rt_new');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://auth.openai.com/oauth/token');
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt_old');
    expect(form.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
  });

  it('令牌端点拒绝时把状态码与原话带出来', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    await expect(openaiRefresh(credential(1_800_000_000))).rejects.toThrow('400');
  });
});

describe('OpenAI OAuth 授权', () => {
  it('授权地址里 PKCE 是 S256、回调是 Codex 的那个 localhost，state 与返回值一致', async () => {
    const flow = await openaiAuthorize();
    const url = new URL(flow.authorize_url);
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    // challenge 必须是 verifier 的 SHA-256：对不上，换币那一步会被上游拒。
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('展示提示取工作区 id 的首尾，不是密钥的首尾', () => {
    expect(openaiAccountHint('acct_abcdefgh')).toBe('acct…efgh');
    expect(openaiAccountHint('short')).toBe('short');
  });
});
