import { describe, expect, it } from 'vitest';

import type { AffinityKey } from '../src/routing';
import { SESSION_HEADER, sessionIdFor } from '../src/sessions';

/**
 * 上游会话 id 只影响提示词缓存命中，但它是**唯一一条 Norm 主动往上写、又来自调用方的
 * 字段**，所以要钉死两件事：形状上游认（`ses_` + 64 hex），原值不上行（哈希之后才发）。
 */
const ADDRESS = '7Xq2cJmVbYyfzJ4yTn5wXoPVcUJ1kKZ9dGm4bQ3rS6hL';

function headersOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

const base = {
  address: ADDRESS,
  headers: headersOf({}),
  affinity: null as AffinityKey | null,
  body: { messages: [{ role: 'user', content: '你好' }] },
  model: 'glm-5.3-flash',
};

describe('sessionIdFor', () => {
  it('形状是 ses_ 加 64 位十六进制', () => {
    expect(sessionIdFor(base)).toMatch(/^ses_[0-9a-f]{64}$/);
  });

  it('同样的输入永远得到同一个值（否则缓存一次也命中不了）', () => {
    expect(sessionIdFor(base)).toBe(sessionIdFor({ ...base }));
  });

  it('账户先拼进种子：两个账户用同一个 thread-id 也不会撞到同一个上游会话', () => {
    const affinity: AffinityKey = { source: 'thread-id', value: 'thread-1' };
    expect(sessionIdFor({ ...base, affinity })).not.toBe(
      sessionIdFor({ ...base, address: 'So11111111111111111111111111111111111111112', affinity }),
    );
  });

  it('四路来源按顺序取用，且互相不会算出同一个值', () => {
    const header = sessionIdFor({ ...base, headers: headersOf({ [SESSION_HEADER]: 'ses_caller' }) });
    const affinity = sessionIdFor({ ...base, affinity: { source: 'thread-id', value: 'ses_caller' } });
    const cacheKey = sessionIdFor({ ...base, body: { ...base.body, prompt_cache_key: 'ses_caller' } });
    const turn = sessionIdFor(base);
    expect(new Set([header, affinity, cacheKey, turn]).size).toBe(4);
  });

  it('头优先于亲和键、亲和键优先于 prompt_cache_key', () => {
    const affinity: AffinityKey = { source: 'session-id', value: 'from-affinity' };
    const withHeader = sessionIdFor({
      ...base,
      headers: headersOf({ [SESSION_HEADER]: 'from-header' }),
      affinity,
      body: { ...base.body, prompt_cache_key: 'from-cache-key' },
    });
    expect(withHeader).toBe(sessionIdFor({ ...base, headers: headersOf({ [SESSION_HEADER]: 'from-header' }) }));
    expect(sessionIdFor({ ...base, affinity })).toBe(
      sessionIdFor({ ...base, body: { ...base.body, prompt_cache_key: 'from-cache-key' }, affinity }),
    );
  });

  it('调用方的原值不上行：输出里不含任何来源文本', () => {
    const id = sessionIdFor({ ...base, headers: headersOf({ [SESSION_HEADER]: 'ses_plaintext_secret' }) });
    expect(id).not.toContain('plaintext');
    expect(id).not.toContain('secret');
  });

  it('没有头与亲和键时按第一轮用户输入派生，对话不同则会话不同', () => {
    const other = sessionIdFor({ ...base, body: { messages: [{ role: 'user', content: '换一句话' }] } });
    expect(other).not.toBe(sessionIdFor(base));
  });

  it('Responses 的 input 形状同样能派生出稳定的值', () => {
    const body = { input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }] };
    expect(sessionIdFor({ ...base, body })).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(sessionIdFor({ ...base, body })).not.toBe(sessionIdFor(base));
  });
});
