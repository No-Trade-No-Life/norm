import { describe, expect, it } from 'vitest';
import { checkProvenance, hostOf } from '../src/provenance';

const base = { checkedAt: 1 };

describe('来源核验信号', () => {
  it('官方主机 + 官方前缀才算通过官方声明', () => {
    const result = checkProvenance({
      ...base,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      upstreamKey: 'sk-proj-abc',
      declaredSource: 'official-api-key',
    });
    expect(result.verified).toBe(true);
    expect(result.signals).toEqual(['host', 'key_prefix']);
  });

  it('声明官方却挂在第三方主机上：可见的掺水', () => {
    const result = checkProvenance({
      ...base,
      provider: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      upstreamKey: 'sk-proj-abc',
      declaredSource: 'official-api-key',
    });
    expect(result.verified).toBe(false);
    expect(result.checks.host).toBe(false);
    expect(result.host).toBe('relay.example.com');
  });

  it('自部署不适用官方主机表，但仍公开 base_url', () => {
    const result = checkProvenance({
      ...base,
      provider: 'self-hosted',
      baseUrl: 'https://llm.internal:8080/v1',
      upstreamKey: 'local',
      declaredSource: 'self-hosted',
    });
    expect(result.verified).toBe(false);
    expect(result.host).toBe('llm.internal:8080');
    expect(result.note).toContain('非官方来源');
  });
});

describe('hostOf', () => {
  it('非法 URL 返回空串', () => {
    expect(hostOf('not a url')).toBe('');
  });
});
