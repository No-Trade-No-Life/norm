import { describe, expect, it } from 'vitest';

import { foldInstructions } from '../src/routes/relay';

const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'gpt-6.2-astra',
    instructions: '你是 Cybion 助手。',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    ...extra,
  });

describe('OAuth 上游的 instructions 折叠', () => {
  it('折成 input 里第一条 developer 消息，原指令一字不差', () => {
    const folded = JSON.parse(foldInstructions('openai-oauth', body()));
    expect(folded.instructions).toBeUndefined();
    expect(folded.input[0]).toEqual({ role: 'developer', content: [{ type: 'input_text', text: '你是 Cybion 助手。' }] });
    expect(folded.input[1].role).toBe('user');
  });

  it('别的协议一个字节都不动', () => {
    const raw = body();
    expect(foldInstructions('openai-chat', raw)).toBe(raw);
    expect(foldInstructions('deepseek', raw)).toBe(raw);
  });

  it('没有 instructions / 空指令 / 非数组 input：原样返回', () => {
    const noInstructions = JSON.stringify({ model: 'm', input: [] });
    expect(foldInstructions('openai-oauth', noInstructions)).toBe(noInstructions);
    const empty = JSON.stringify({ model: 'm', instructions: '   ', input: [] });
    expect(foldInstructions('openai-oauth', empty)).toBe(empty);
    const stringInput = JSON.stringify({ model: 'm', instructions: 'x', input: 'hi' });
    expect(foldInstructions('openai-oauth', stringInput)).toBe(stringInput);
  });

  it('读不成 JSON 就原样交回去，不猜', () => {
    expect(foldInstructions('openai-oauth', 'not json')).toBe('not json');
  });
});
