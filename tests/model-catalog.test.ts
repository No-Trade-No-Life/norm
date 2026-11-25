import { describe, expect, it } from 'vitest';

import { mergeCatalog } from '../src/models';

/**
 * 合并规则是这张表的全部逻辑：同名就是同一条、谁有它记成一列、官方价按提供它的
 * 协议的定价模式锚定（通用表平档，`deepseek` 分时）。都在这里钉住，
 * e2e 只负责验证「真打出去也确实如此」。
 */
describe('mergeCatalog', () => {
  it('同名模型跨上游合成一行，记下谁有它，结果按名字排序', () => {
    const rows = mergeCatalog([
      {
        provider_id: 'p-openai',
        protocol: 'openai-chat',
        items: [{ id: 'gpt-4o-mini' }, { id: 'b-model' }],
      },
      {
        provider_id: 'p-proxy',
        protocol: 'openai-chat',
        items: [{ id: 'gpt-4o-mini' }, { id: 'a-model' }],
      },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['a-model', 'b-model', 'gpt-4o-mini']);
    expect(rows[2].providers).toEqual(['p-openai', 'p-proxy']);
    expect(rows[1].providers).toEqual(['p-openai']);
  });

  it('created / owned_by 先给的不被覆盖，后给的能补空', () => {
    const rows = mergeCatalog([
      // Anthropic 的清单没有 owned_by：先来的这一条缺一列。
      { provider_id: 'p-a', protocol: 'anthropic-messages', items: [{ id: 'm', created: 100 }] },
      { provider_id: 'p-b', protocol: 'openai-chat', items: [{ id: 'm', created: 999, owned_by: 'someone' }] },
    ]);

    expect(rows[0].created).toBe(100);
    expect(rows[0].owned_by).toBe('someone');
  });

  it('同一家把同一个模型列两遍，谁有它只记一次', () => {
    const rows = mergeCatalog([
      { provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'm' }, { id: 'm' }] },
    ]);
    expect(rows[0].providers).toEqual(['p']);
  });

  it('官方价按最长前缀锚定：gpt-4o-mini 不能按 gpt-4o 计价', () => {
    const rows = mergeCatalog([
      { provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] },
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('gpt-4o-mini')?.official).toMatchObject({ match: 'gpt-4o-mini', input: 150_000_000 });
    expect(byId.get('gpt-4o')?.official).toMatchObject({ match: 'gpt-4o', input: 2_500_000_000 });
  });

  it('带提供者前缀的名字也能锚上（openrouter 那类 id）', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'openai/gpt-4.1-mini' }] }]);
    expect(rows[0].official?.match).toBe('gpt-4.1-mini');
  });

  it('挂 deepseek 协议的型号，锚点是高峰价 + 低谷价', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'deepseek', items: [{ id: 'deepseek-flash' }] }]);
    expect(rows[0].official).toMatchObject({ match: 'deepseek-flash', input: 300_000_000 });
    expect(rows[0].official?.off_peak).toEqual({ input: 150_000_000, cached: 3_000_000, output: 600_000_000 });
  });

  // 分时价是协议的事：同一个型号挂在通用协议上时，那条上游并没有「低谷时段」，
  // 所以锚点只有平档价（高峰价）。
  it('同一个型号挂在通用协议上，锚点没有低谷价', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'deepseek-flash' }] }]);
    expect(rows[0].official?.input).toBe(300_000_000);
    expect(rows[0].official?.off_peak).toBeUndefined();
  });

  it('几家上游都有它时，锚点以带分时价的那一条为准', () => {
    const rows = mergeCatalog([
      { provider_id: 'p-flat', protocol: 'openai-chat', items: [{ id: 'deepseek-flash' }] },
      { provider_id: 'p-ds', protocol: 'deepseek', items: [{ id: 'deepseek-flash' }] },
    ]);
    expect(rows[0].providers).toEqual(['p-flat', 'p-ds']);
    expect(rows[0].official?.off_peak?.input).toBe(150_000_000);
  });

  it('价目表里没有的型号，官方价是 null，不猜', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'deepseek', items: [{ id: 'acme-secret-model' }] }]);
    expect(rows[0].official).toBeNull();
  });

  it('空清单就是空表', () => {
    expect(mergeCatalog([])).toEqual([]);
    expect(mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [] }])).toEqual([]);
  });
});
