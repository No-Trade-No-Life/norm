import { describe, expect, it } from 'vitest';

import { PROTOCOL_SCHEMAS, PROTOCOLS, adapterFor, protocolUrlFor, schemaOf } from '../src/protocols';

/**
 * 「Base URL + API key」不是两个可以自由组合的输入框，而是协议的一部分：厂商协议
 * （`deepseek`）的地址是官方定死的，用户只给密钥；通用的四条方言由用户填自己的上游。
 * 前端「先选协议、再按协议渲染字段」与创建接口的校验都读这一份，所以钉在这里。
 */
describe('协议契约（protocol schema）', () => {
  it('每条协议都有一份，顺序与 PROTOCOLS 一致', () => {
    expect(PROTOCOL_SCHEMAS.map((schema) => schema.protocol)).toEqual([...PROTOCOLS]);
  });

  it('deepseek：基址由协议给定，只要密钥', () => {
    expect(schemaOf('deepseek')).toEqual({
      protocol: 'deepseek',
      dialect: 'openai-responses',
      base_url: 'https://api.deepseek.com',
      fields: ['provider_key'],
    });
  });

  it('四条通用方言：基址由用户填，base_url 排在密钥前面', () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'] as const) {
      const schema = schemaOf(protocol);
      expect(schema.base_url).toBeNull();
      expect(schema.dialect).toBe(protocol);
      expect(schema.fields).toEqual(['base_url', 'provider_key']);
    }
  });

  it('opencode-go：基址是官方推理面，只要密钥，方言仍是 openai-chat', () => {
    expect(schemaOf('opencode-go')).toEqual({
      protocol: 'opencode-go',
      dialect: 'openai-chat',
      base_url: 'https://opencode.ai/inference/go',
      fields: ['provider_key'],
    });
  });

  it('钉死基址的协议只有 deepseek 与 opencode-go：哪条协议不要 base_url 是数据，不是判断', () => {
    const fixed = PROTOCOL_SCHEMAS.filter((schema) => schema.base_url !== null);
    expect(fixed.map((schema) => schema.protocol)).toEqual(['deepseek', 'opencode-go']);
  });
});

/**
 * 模态是上游清单里的原话，不是 Norm 的推断：只有 OpenRouter 那一系（及照抄它形状的
 * 聚合型上游）会带，认不得的写法就当没说。这几条钉住「说什么信什么，没说就不写」。
 */
describe('清单里的模态（OpenRouter 式字段）', () => {
  const read = (json: unknown) => adapterFor('openai-chat').readModels(json);

  it('architecture.input_modalities / output_modalities 原样读进来', () => {
    const [item] = read({
      data: [{ id: 'm', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }],
    });
    expect(item.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
  });

  it('老字段 modality 是一个字符串，也能拆成两侧', () => {
    const [item] = read({ data: [{ id: 'm', architecture: { modality: 'text+image->text' } }] });
    expect(item.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
  });

  it('摊平在顶层的抄法也认', () => {
    const [item] = read({ data: [{ id: 'm', input_modalities: ['text'], output_modalities: ['image'] }] });
    expect(item.modalities).toEqual({ input: ['text'], output: ['image'] });
  });

  it('没有这个字段时条目上就没有 modalities——不补一个默认的 text', () => {
    const [item] = read({ data: [{ id: 'm', created: 1, owned_by: 'x' }] });
    expect('modalities' in item).toBe(false);
  });

  it('认不得的词丢掉、重复的去掉、大小写归一', () => {
    const [item] = read({
      data: [{ id: 'm', architecture: { input_modalities: ['TEXT', 'text', 'text/plain; charset=utf-8', '', 7] } }],
    });
    expect(item.modalities).toEqual({ input: ['text'], output: [] });
  });

  it('只声明了一半，就只写一半（另一侧是空的，不是猜的）', () => {
    const [item] = read({ data: [{ id: 'm', architecture: { output_modalities: ['image'] } }] });
    expect(item.modalities).toEqual({ input: [], output: ['image'] });
  });

  it('别的方言的清单里有这个字段也照样读，不被方言挡住', () => {
    const [item] = adapterFor('anthropic-messages').readModels({
      data: [{ id: 'm', input_modalities: ['text', 'image'], created_at: '2026-01-01T00:00:00Z' }],
    });
    expect(item.modalities).toEqual({ input: ['text', 'image'], output: [] });
  });
});

/**
 * OpenCode Go 是一条「基址钉死 + 必须带会话头」的厂商协议：这三条断言就是它全部的
 * 契约。少任何一条，线上拿到的都是上游那句 `400 MissingSessionID`。
 */
describe('opencode-go 协议', () => {
  it('路径自带版本段，清单也走同一段', () => {
    const adapter = adapterFor('opencode-go');
    expect(adapter.path('m')).toBe('/openai/v1/chat/completions');
    expect(adapter.modelsPath()).toBe('/openai/v1/models');
    expect(protocolUrlFor('opencode-go', 'https://opencode.ai/inference/go/', 'glm-5.3-flash', false)).toBe(
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
    );
  });

  it('声明了会话头，其余协议一个都不声明', () => {
    expect(adapterFor('opencode-go').session_header).toBe('x-opencode-session');
    const others = PROTOCOLS.filter((protocol) => protocol !== 'opencode-go');
    expect(others.filter((protocol) => adapterFor(protocol).session_header !== undefined)).toEqual([]);
  });

  it('鉴权仍是 Bearer，与 openai-chat 同一套', () => {
    expect(adapterFor('opencode-go').headers('oc_sk_x')).toEqual(adapterFor('openai-chat').headers('oc_sk_x'));
  });
});
