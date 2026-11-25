import { describe, expect, it } from 'vitest';
import { carriesText } from '../src/dialects';

/**
 * 「首字」按真正的文本增量算，不按第一帧算：几乎每家都会先发一帧
 * 空的 role / 心跳 / 思考增量，那些都不是用户看到的第一个字。
 * 这一组测试钉住的就是「哪一帧才算开始说话」。
 */
describe('carriesText：哪一帧才算首字', () => {
  const frame = (value: unknown) => JSON.stringify(value);

  it('openai-chat：空的 role 帧不算，有内容的 delta 才算', () => {
    expect(carriesText('openai-chat', frame({ choices: [{ delta: { role: 'assistant', content: '' } }] }))).toBe(false);
    expect(carriesText('openai-chat', frame({ choices: [{ delta: { content: '你' } }] }))).toBe(true);
  });

  it('openai-chat：DeepSeek 的 reasoning_content 也算开始产字', () => {
    expect(carriesText('openai-chat', frame({ choices: [{ delta: { reasoning_content: '想' } }] }))).toBe(true);
  });

  it('openai-responses：只有 output_text.delta 才算', () => {
    expect(carriesText('openai-responses', frame({ type: 'response.created' }))).toBe(false);
    expect(carriesText('openai-responses', frame({ type: 'response.output_text.delta', delta: '你' }))).toBe(true);
  });

  it('anthropic：content_block_start 不算，text_delta / thinking_delta 算', () => {
    expect(carriesText('anthropic-messages', frame({ type: 'content_block_start' }))).toBe(false);
    expect(carriesText('anthropic-messages', frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }))).toBe(true);
  });

  it('gemini：candidates 里有非空 parts.text 才算', () => {
    expect(carriesText('google-gemini', frame({ candidates: [{ content: { parts: [{ text: '' }] } }] }))).toBe(false);
    expect(carriesText('google-gemini', frame({ candidates: [{ content: { parts: [{ text: '你' }] } }] }))).toBe(true);
  });

  it('坏帧与 [DONE] 都不是首字', () => {
    expect(carriesText('openai-chat', '[DONE]')).toBe(false);
    expect(carriesText('openai-chat', 'not json')).toBe(false);
  });
});
