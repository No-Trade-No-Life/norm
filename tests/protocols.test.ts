import { describe, expect, it } from 'vitest';

import { DIALECTS, dialectCodecFor } from '../src/codecs';
import { PROTOCOL_SCHEMAS, PROTOCOLS, protocolFor, protocolUrlFor, schemaOf, streamPathFor } from '../src/protocols';

/**
 * 「Base URL + API key」不是两个可以自由组合的输入框，而是协议的一部分：厂商协议
 * （`deepseek` / `opencode-go`）的地址是官方定死的，用户只给密钥；通用的四条方言由用户填自己的上游。
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
      oauth: false,
      stream_only: false,
      audio: [],
      image: false,
    });
  });

  it('四条通用方言：基址由用户填，base_url 排在密钥前面', () => {
    for (const protocol of DIALECTS) {
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
      oauth: false,
      stream_only: false,
      audio: [],
      image: false,
    });
  });

  it('openai-oauth：凭据走 OAuth、上游只认流式，基址钉死为官方地址（出口由 proxy_url 决定）', () => {
    expect(schemaOf('openai-oauth')).toEqual({
      protocol: 'openai-oauth',
      dialect: 'openai-responses',
      base_url: 'https://chatgpt.com/backend-api/codex',
      fields: ['provider_key'],
      oauth: true,
      stream_only: true,
      audio: [],
      image: true,
    });
  });

  it('钉死基址的协议只有 deepseek、opencode-go、openai-oauth 与 qwen：哪条协议不要 base_url 是数据，不是判断', () => {
    const fixed = PROTOCOL_SCHEMAS.filter((schema) => schema.base_url !== null);
    expect(fixed.map((schema) => schema.protocol)).toEqual(['deepseek', 'opencode-go', 'openai-oauth', 'qwen']);
  });

  it('图像能力只落在 openai-oauth 上：订阅上游没有 Images 端点，出图走 image_generation 工具', () => {
    expect(PROTOCOL_SCHEMAS.filter((schema) => schema.image).map((schema) => schema.protocol)).toEqual(['openai-oauth']);
    expect(protocolFor('openai-oauth').image).toBe('openai-image-tool');
  });

  it('音频能力只落在 qwen 与 openai-audio 两条协议上', () => {
    expect(PROTOCOL_SCHEMAS.filter((schema) => schema.audio.length > 0).map((schema) => schema.protocol)).toEqual([
      'openai-audio',
      'qwen',
    ]);
  });

  it('qwen：基址是百炼的根，文本走兼容层路径，音频走原生接口', () => {
    expect(schemaOf('qwen')).toEqual({
      protocol: 'qwen',
      dialect: 'openai-chat',
      base_url: 'https://dashscope.aliyuncs.com',
      fields: ['provider_key'],
      oauth: false,
      stream_only: false,
      audio: ['transcriptions', 'speech'],
      image: false,
    });
    expect(protocolUrlFor('qwen', 'https://dashscope.aliyuncs.com/', 'qwen-max', false)).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(protocolFor('qwen').modelsPath()).toBe('/compatible-mode/v1/models');
  });

  it('openai-audio：基址由用户填（Qwen LB / OpenAI / 任何兼容实现都是它），两个音频入口都认', () => {
    expect(schemaOf('openai-audio')).toEqual({
      protocol: 'openai-audio',
      dialect: 'openai-chat',
      base_url: null,
      fields: ['base_url', 'provider_key'],
      oauth: false,
      stream_only: false,
      audio: ['transcriptions', 'speech'],
      image: false,
    });
  });

  it('「OAuth 凭据」与「只认流式」各只落在 openai-oauth 一条协议上', () => {
    expect(PROTOCOL_SCHEMAS.filter((schema) => schema.oauth).map((schema) => schema.protocol)).toEqual([
      'openai-oauth',
    ]);
    expect(PROTOCOL_SCHEMAS.filter((schema) => schema.stream_only).map((schema) => schema.protocol)).toEqual([
      'openai-oauth',
    ]);
  });
});

/**
 * OpenAI OAuth 的上游契约：地址、路径、方言复用三件事钉在协议层，凭据那一段在
 * `oauth.ts`（见 tests/oauth.test.ts）。少一条，线上拿到的都是上游一句不好查的 4xx。
 */
describe('openai-oauth 协议', () => {
  it('路径就是 Codex 的 /responses，拼在用户填的那一跳后面', () => {
    const profile = protocolFor('openai-oauth');
    expect(profile.path('gpt-5.6-luna')).toBe('/responses');
    expect(streamPathFor('openai-oauth', 'gpt-5.6-luna')).toBe('/responses');
    expect(protocolUrlFor('openai-oauth', 'https://hop.example.com/codex/', 'gpt-5.6-luna', true)).toBe(
      'https://hop.example.com/codex/responses',
    );
  });

  it('复用 Responses 方言：请求体与清单读法都借那一份，翻译代码增量是 0', () => {
    const profile = protocolFor('openai-oauth');
    expect(profile.dialect).toBe('openai-responses');
    const codec = dialectCodecFor(profile.dialect);
    expect(
      codec.encodeRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, 'm'),
    ).toMatchObject({ model: 'm', stream: true, input: [{ role: 'user', content: 'hi' }] });
  });
});

/**
 * 模态是上游清单里的原话，不是 Norm 的推断：只有 OpenRouter 那一系（及照抄它形状的
 * 聚合型上游）会带，认不得的写法就当没说。这几条钉住「说什么信什么，没说就不写」。
 */
describe('清单里的模态（OpenRouter 式字段）', () => {
  const read = (json: unknown) => dialectCodecFor('openai-chat').decodeModels(json);

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
    const [item] = dialectCodecFor('anthropic-messages').decodeModels({
      data: [{ id: 'm', input_modalities: ['text', 'image'], created_at: '2026-01-01T00:00:00Z' }],
    });
    expect(item.modalities).toEqual({ input: ['text', 'image'], output: [] });
  });
});

/**
 * 架构不变量：协议层（ProtocolProfile）与翻译层（DialectCodec）彻底解耦。
 * 新增上游厂商协议只声明复用哪一种 `dialect` 与传输/计价契约，翻译代码增量为 0。
 */
describe('方言编解码与协议契约分层', () => {
  it('协议对象只含传输/计价契约，不含翻译方法；所有协议均映射到 4 种方言之一', () => {
    for (const protocol of PROTOCOLS) {
      const resolved = protocolFor(protocol);
      expect(DIALECTS).toContain(resolved.dialect);
      expect(dialectCodecFor(resolved.dialect).dialect).toBe(resolved.dialect);
      // 翻译方法只存在于 DialectCodec，协议层绝不分叉出自己的编解码方法。
      expect('encodeRequest' in resolved).toBe(false);
      expect('decodeStreamEvents' in resolved).toBe(false);
      expect('decodeModels' in resolved).toBe(false);
    }
  });

  it('流式路径按方言/契约派生：Gemini 走 :streamGenerateContent?alt=sse，覆写路径的协议沿用自身路径', () => {
    expect(streamPathFor('google-gemini', 'gemini-2.0-flash')).toBe(
      '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
    expect(streamPathFor('opencode-go', 'glm-5.3-flash')).toBe('/openai/v1/chat/completions');
    expect(streamPathFor('deepseek', 'deepseek-v4-pro')).toBe('/responses');
  });
});

/**
 * OpenCode Go 是一条「基址钉死 + 必须带会话头」的厂商协议：这三条断言就是它全部的
 * 契约。少任何一条，线上拿到的都是上游那句 `400 MissingSessionID`。
 */
describe('opencode-go 协议', () => {
  it('路径自带版本段，清单也走同一段', () => {
    const profile = protocolFor('opencode-go');
    expect(profile.path('m')).toBe('/openai/v1/chat/completions');
    expect(profile.modelsPath()).toBe('/openai/v1/models');
    expect(protocolUrlFor('opencode-go', 'https://opencode.ai/inference/go/', 'glm-5.3-flash', false)).toBe(
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
    );
  });

  it('声明了会话头，其余协议一个都不声明', () => {
    expect(protocolFor('opencode-go').session_header).toBe('x-opencode-session');
    const others = PROTOCOLS.filter((protocol) => protocol !== 'opencode-go');
    expect(others.filter((protocol) => protocolFor(protocol).session_header !== undefined)).toEqual([]);
  });

  it('鉴权仍是 Bearer，与 openai-chat 同一套', () => {
    expect(protocolFor('opencode-go').headers('oc_sk_x')).toEqual(protocolFor('openai-chat').headers('oc_sk_x'));
  });
});
