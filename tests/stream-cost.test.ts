import { describe, expect, it } from 'vitest';

import {
  carriesFinalUsage,
  closingCostFrame,
  stampStreamCost,
  streamEmitter,
  type AnswerCore,
  type NormMeta,
} from '../src/dialects';

/**
 * 流式响应的费用：随流尾那一帧一起回来。
 *
 * 响应头在第一个 token 之前就发出去了，费用那一刻还不知道，所以流式只能把金额
 * 写在「用量到此为止」的那一帧里——四家方言各自的标准位置：
 *   Responses  `response.completed` 的 `response.usage`
 *   Anthropic  `message_delta` 的 `usage`
 *   Gemini     末块的 `usageMetadata`（它的流没有收尾帧，补一条只带用量的块）
 *   Chat       Norm 自己补的 `{"cost_usd_nanos":…,"norm":…}` 帧
 */
const meta: NormMeta = {
  request_id: 'req_cost',
  fee_nanos: 76_390,
  gas_fee_nanos: 2_420,
  gas_billed_nanos: 2_420,
  token_nanos: 73_970,
  token_billed_nanos: 73_970,
  input_tokens: 11,
  cached_tokens: 3,
  output_tokens: 5,
  audio_ms: 0,
  audio_characters: 0,
  unbilled_nanos: 0,
  balance_nanos: 1_000_000,
  latency_ms: 900,
  host: 'upstream.test',
  pool: false,
};

const answer: AnswerCore = {
  text: '你好',
  reasoning: '',
  toolCalls: [],
  model: 'm',
  usage: { input: 11, cached: 3, output: 5 },
  createdAt: 0,
};

const sse = (chunks: string[]) =>
  chunks.map((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
    const line = chunk.split('\n').find((entry) => entry.startsWith('data: ')) ?? 'data: {}';
    return { event, json: JSON.parse(line.slice(6)) as Record<string, any> };
  });

describe('直通流：收尾帧里补费用', () => {
  it('认得出哪一帧是用量到此为止的收尾帧', () => {
    expect(carriesFinalUsage('openai-responses', '{"type":"response.completed","response":{}}')).toBe(true);
    expect(carriesFinalUsage('openai-responses', '{"type":"response.output_text.delta","delta":"嗨"}')).toBe(false);
    expect(carriesFinalUsage('anthropic-messages', '{"type":"message_delta","usage":{}}')).toBe(true);
    expect(carriesFinalUsage('anthropic-messages', '{"type":"message_stop"}')).toBe(false);
    // 这两家的流里没有收尾帧：Chat 由 Norm 自己补帧，Gemini 的末块就是最后一个内容块。
    expect(carriesFinalUsage('openai-chat', '{"choices":[{"delta":{"content":"嗨"}}]}')).toBe(false);
    expect(carriesFinalUsage('google-gemini', '{"usageMetadata":{"totalTokenCount":16}}')).toBe(false);
    // 不是 JSON 的帧（注释、空帧、"data: [DONE]"）一律不动。
    expect(carriesFinalUsage('openai-responses', '')).toBe(false);
    expect(carriesFinalUsage('anthropic-messages', 'not json')).toBe(false);
  });

  it('Responses：费用写进 response.usage，别的字段一个不动', () => {
    const frame = '{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":5}}}';
    const stamped = JSON.parse(stampStreamCost('openai-responses', frame, meta) ?? '{}');
    expect(stamped.type).toBe('response.completed');
    expect(stamped.response.id).toBe('resp_1');
    expect(stamped.response.usage).toEqual({ input_tokens: 11, output_tokens: 5, cost_usd_nanos: 76_390 });
  });

  it('Anthropic：费用写进 message_delta 的 usage', () => {
    const frame = '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}';
    const stamped = JSON.parse(stampStreamCost('anthropic-messages', frame, meta) ?? '{}');
    expect(stamped.delta.stop_reason).toBe('end_turn');
    expect(stamped.usage).toEqual({ output_tokens: 5, cost_usd_nanos: 76_390 });
  });

  it('不是收尾帧就交回 null：字节原样往下走', () => {
    expect(stampStreamCost('openai-responses', '{"type":"response.created"}', meta)).toBeNull();
    expect(stampStreamCost('anthropic-messages', '{"type":"message_start"}', meta)).toBeNull();
    expect(stampStreamCost('google-gemini', '{"candidates":[]}', meta)).toBeNull();
  });
});

describe('没有收尾帧的那一家：补一条只带用量的块', () => {
  it('Gemini：末块带 usageMetadata.cost_usd_nanos，不带 candidates', () => {
    const frame = JSON.parse(closingCostFrame('google-gemini', 'm', answer.usage, meta).replace(/^data: |\n\n$/g, ''));
    expect(frame.candidates).toBeUndefined();
    expect(frame.modelVersion).toBe('m');
    expect(frame.usageMetadata).toEqual({
      promptTokenCount: 11,
      cachedContentTokenCount: 3,
      candidatesTokenCount: 5,
      totalTokenCount: 16,
      cost_usd_nanos: 76_390,
    });
  });

  it('其余三家不补：费用已经写进它们自己的收尾帧了', () => {
    expect(closingCostFrame('openai-responses', 'm', answer.usage, meta)).toBe('');
    expect(closingCostFrame('anthropic-messages', 'm', answer.usage, meta)).toBe('');
    expect(closingCostFrame('openai-chat', 'm', answer.usage, meta)).toBe('');
  });
});

describe('跨方言流：emitter 收尾那一帧自带费用', () => {
  it('Responses：response.completed 的 usage 里带 cost_usd_nanos', () => {
    const frames = sse(streamEmitter('openai-responses', 'req_1', 'm').tail(answer, meta));
    const completed = frames.find((frame) => frame.event === 'response.completed');
    expect(completed?.json.response.usage.cost_usd_nanos).toBe(76_390);
  });

  it('Anthropic：message_delta 的 usage 里带 cost_usd_nanos', () => {
    const frames = sse(streamEmitter('anthropic-messages', 'req_1', 'm').tail(answer, meta));
    const delta = frames.find((frame) => frame.event === 'message_delta');
    expect(delta?.json.usage.cost_usd_nanos).toBe(76_390);
  });

  it('Gemini：收尾块的 usageMetadata 里带 cost_usd_nanos', () => {
    const [frame] = sse(streamEmitter('google-gemini', 'req_1', 'm').tail(answer, meta));
    expect(frame.json.usageMetadata.cost_usd_nanos).toBe(76_390);
  });
});
