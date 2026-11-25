import { describe, expect, it } from 'vitest';
import { readAnswer, usageSniffer } from '../src/dialects';

/**
 * 四家的用量口径各不相同，账本只认一种：input（含缓存命中）/ cached / output。
 * 归一化写错一个字段，账单就会静默地对不上 provider——这类错必须由测试兜住。
 */
describe('非流式的用量归一化', () => {
  it('openai-chat：prompt 含缓存，命中数在 details 里', () => {
    const core = readAnswer('openai-chat', {
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } },
    });
    expect(core.usage).toEqual({ input: 1000, cached: 900, output: 20 });
  });

  it('openai-responses：input/output_tokens', () => {
    const core = readAnswer('openai-responses', {
      model: 'gpt-4o',
      output: [],
      usage: { input_tokens: 500, output_tokens: 7, input_tokens_details: { cached_tokens: 100 } },
    });
    expect(core.usage).toEqual({ input: 500, cached: 100, output: 7 });
  });

  it('anthropic：input_tokens 不含缓存读/写，三项相加才是输入总量', () => {
    const core = readAnswer('anthropic-messages', {
      model: 'claude-3-5-sonnet',
      content: [{ text: 'hi' }],
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
        output_tokens: 9,
      },
    });
    expect(core.usage).toEqual({ input: 352, cached: 300, output: 9 });
  });

  it('gemini：promptTokenCount 含 cachedContentTokenCount', () => {
    const core = readAnswer('google-gemini', {
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 800, cachedContentTokenCount: 600, candidatesTokenCount: 30 },
    });
    expect(core.usage).toEqual({ input: 800, cached: 600, output: 30 });
  });

  it('没有 usage 字段时三项都是 0，不是 NaN', () => {
    expect(readAnswer('openai-chat', {}).usage).toEqual({ input: 0, cached: 0, output: 0 });
  });
});

describe('流式用量嗅探', () => {
  const push = (dialect: Parameters<typeof usageSniffer>[0], frames: unknown[]) => {
    const sniffer = usageSniffer(dialect);
    for (const frame of frames) sniffer.push(JSON.stringify(frame));
    return sniffer.usage();
  };

  it('openai-chat：末帧的 usage 被读到', () => {
    const usage = push('openai-chat', [
      { choices: [{ delta: { content: '你' } }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 800 } } },
    ]);
    expect(usage).toEqual({ input: 900, cached: 800, output: 12 });
  });

  it('openai-responses：用量在 response.completed 里', () => {
    const usage = push('openai-responses', [
      { type: 'response.output_text.delta', delta: '你' },
      { type: 'response.completed', response: { usage: { input_tokens: 42, output_tokens: 3 } } },
    ]);
    expect(usage).toEqual({ input: 42, cached: 0, output: 3 });
  });

  it('anthropic：输入在 message_start、输出在 message_delta，两帧合起来才是全量', () => {
    const usage = push('anthropic-messages', [
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 200, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } },
      { type: 'message_delta', usage: { output_tokens: 55 } },
    ]);
    expect(usage).toEqual({ input: 210, cached: 200, output: 55 });
  });

  it('gemini：每帧都带累计用量，取最后一次完整读数', () => {
    const usage = push('google-gemini', [
      { usageMetadata: { promptTokenCount: 30, cachedContentTokenCount: 10, candidatesTokenCount: 1 } },
      { usageMetadata: { promptTokenCount: 30, cachedContentTokenCount: 10, candidatesTokenCount: 7 } },
    ]);
    expect(usage).toEqual({ input: 30, cached: 10, output: 7 });
  });

  it('坏帧与非 JSON 不打断流，也不污染用量', () => {
    const sniffer = usageSniffer('openai-chat');
    sniffer.push('not json');
    sniffer.push('[DONE]');
    sniffer.push(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    expect(sniffer.usage()).toEqual({ input: 5, cached: 0, output: 1 });
  });
});
