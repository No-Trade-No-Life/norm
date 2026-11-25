import { describe, expect, it } from 'vitest';
import { carriesOutput } from '../src/dialects';

/**
 * 「首字」按真正的输出增量算，不按第一帧算：几乎每家都会先发一帧
 * 空的 role / 心跳 / 思考增量，那些都不是用户看到的第一个字。
 * 只回一句「我要调工具」的回答同样在产字，所以工具调用的开头也算。
 * 这一组测试钉住的就是「哪一帧才算开始说话」。
 */
describe('carriesOutput：哪一帧才算首字', () => {
  const frame = (value: unknown) => JSON.stringify(value);

  it('openai-chat：空的 role 帧不算，有内容的 delta 才算', () => {
    expect(carriesOutput('openai-chat', frame({ choices: [{ delta: { role: 'assistant', content: '' } }] }))).toBe(false);
    expect(carriesOutput('openai-chat', frame({ choices: [{ delta: { content: '你' } }] }))).toBe(true);
  });

  it('openai-chat：DeepSeek 的 reasoning_content 也算开始产字', () => {
    expect(carriesOutput('openai-chat', frame({ choices: [{ delta: { reasoning_content: '想' } }] }))).toBe(true);
  });

  it('openai-chat：工具调用的第一帧也算——模型是在回话，只是在要工具', () => {
    expect(
      carriesOutput('openai-chat', frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather' } }] } }] })),
    ).toBe(true);
  });

  it('openai-responses：output_text.delta 与函数参数增量都算，response.created 不算', () => {
    expect(carriesOutput('openai-responses', frame({ type: 'response.created' }))).toBe(false);
    expect(carriesOutput('openai-responses', frame({ type: 'response.output_text.delta', delta: '你' }))).toBe(true);
    expect(carriesOutput('openai-responses', frame({ type: 'response.function_call_arguments.delta', delta: '{"city"' }))).toBe(true);
    expect(
      carriesOutput('openai-responses', frame({ type: 'response.output_item.added', item: { type: 'function_call', name: 'get_weather' } })),
    ).toBe(true);
  });

  it('anthropic：空的 content_block_start 不算，tool_use 块与两种 delta 算', () => {
    expect(carriesOutput('anthropic-messages', frame({ type: 'content_block_start' }))).toBe(false);
    expect(carriesOutput('anthropic-messages', frame({ type: 'content_block_start', content_block: { type: 'tool_use' } }))).toBe(true);
    expect(carriesOutput('anthropic-messages', frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }))).toBe(true);
    expect(carriesOutput('anthropic-messages', frame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }))).toBe(true);
  });

  it('gemini：candidates 里有非空 parts.text 或 functionCall 才算', () => {
    expect(carriesOutput('google-gemini', frame({ candidates: [{ content: { parts: [{ text: '' }] } }] }))).toBe(false);
    expect(carriesOutput('google-gemini', frame({ candidates: [{ content: { parts: [{ text: '你' }] } }] }))).toBe(true);
    expect(
      carriesOutput('google-gemini', frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: {} } }] } }] })),
    ).toBe(true);
  });

  it('坏帧与 [DONE] 都不是首字', () => {
    expect(carriesOutput('openai-chat', '[DONE]')).toBe(false);
    expect(carriesOutput('openai-chat', 'not json')).toBe(false);
  });
});
