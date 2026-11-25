import { describe, expect, it } from 'vitest';

import { PROTOCOL_SCHEMAS, PROTOCOLS, schemaOf } from '../src/protocols';

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

  it('只有 deepseek 钉死了基址：哪条协议不要 base_url 是数据，不是判断', () => {
    const fixed = PROTOCOL_SCHEMAS.filter((schema) => schema.base_url !== null);
    expect(fixed.map((schema) => schema.protocol)).toEqual(['deepseek']);
  });
});
