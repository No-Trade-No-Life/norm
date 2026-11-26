import { describe, expect, it } from 'vitest';

import { readAnswer, parseInbound, renderInbound, streamEmitter } from '../src/dialects';
import { dialectCodecFor } from '../src/codecs';
import type { NormMeta } from '../src/dialects';

/**
 * 推理（思考）的透传契约。
 *
 * 桥接最容易被丢掉的就是这一层：`reasoning` 不是回答，客户端却正是为了它才把档位调高的。
 * 所以这里钉三件事——档位进得去上游、思考出得来、出来时挂在**自己的条目**上
 * （Responses 的增量事件必须有 item 可挂，否则下游按协议整段丢掉）。
 */

const norm: NormMeta = {
  request_id: 'req_1',
  fee_nanos: 0,
  gas_fee_nanos: 0,
  gas_billed_nanos: 0,
  token_nanos: 0,
  token_billed_nanos: 0,
  input_tokens: 10,
  cached_tokens: 0,
  output_tokens: 5,
  audio_ms: 0,
  audio_characters: 0,
  unbilled_nanos: 0,
  balance_nanos: null,
  latency_ms: 1,
  host: 'norm.test',
  pool: false,
};

const frames = (chunks: string[]) => chunks.map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: '))!.slice(6));

describe('推理档位', () => {
  it('Responses 的 reasoning.effort 落到 Chat 上游的 reasoning_effort 上', () => {
    const body = parseInbound(
      'openai-responses',
      { model: 'deepseek-v4.1-flash', input: [{ role: 'user', content: '你好' }], reasoning: { effort: 'max', summary: 'auto' } },
      'deepseek-v4.1-flash',
      true,
    );
    expect(body.reasoning_effort).toBe('max');
    const wire = dialectCodecFor('openai-chat').encodeRequest(body, 'deepseek-v4.1-flash') as Record<string, unknown>;
    expect(wire.reasoning_effort).toBe('max');
  });

  it('Chat 的 reasoning_effort 落到 Responses 上游的 reasoning.effort 上', () => {
    const body = parseInbound(
      'openai-chat',
      { model: 'm', messages: [{ role: 'user', content: '你好' }], reasoning_effort: 'high' },
      'm',
      true,
    );
    const wire = dialectCodecFor('openai-responses').encodeRequest(body, 'm') as Record<string, unknown>;
    expect(wire.reasoning).toEqual({ effort: 'high' });
  });

  it('没说档位就不往上游加字段', () => {
    const body = parseInbound('openai-responses', { model: 'm', input: [] }, 'm', false);
    expect(body.reasoning_effort).toBeUndefined();
    const wire = dialectCodecFor('openai-chat').encodeRequest(body, 'm') as Record<string, unknown>;
    expect('reasoning_effort' in wire).toBe(false);
  });
});

describe('思考的读出与再渲染', () => {
  it('Chat 上游的 reasoning_content 在非流式 Responses 里是自己的条目', () => {
    const answer = readAnswer('openai-chat', {
      choices: [{ message: { role: 'assistant', content: '答案', reasoning_content: '我想了想' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    expect(answer.reasoning).toBe('我想了想');
    expect(answer.text).toBe('答案');

    const rendered = renderInbound('openai-responses', answer, norm) as { output: Record<string, unknown>[] };
    expect(rendered.output[0].type).toBe('reasoning');
    expect(rendered.output[0].summary).toEqual([{ type: 'summary_text', text: '我想了想' }]);
    expect(rendered.output[1].type).toBe('message');
  });

  it('Responses 上游的 reasoning 条目两种写法都读得出来', () => {
    const fromSummary = readAnswer('openai-responses', {
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要' }] }, { type: 'message', content: [{ type: 'output_text', text: '答' }] }],
    });
    expect(fromSummary.reasoning).toBe('摘要');
    expect(fromSummary.text).toBe('答');

    const fromContent = readAnswer('openai-responses', {
      output: [{ type: 'reasoning', content: [{ type: 'text', text: '原文' }] }],
    });
    expect(fromContent.reasoning).toBe('原文');
  });

  it('Chat 上游的思考增量先声明条目，再挂着它吐增量', () => {
    const emitter = streamEmitter('openai-responses', 'req_1', 'deepseek-v4.1-flash');
    const events = [
      ...emitter.head(),
      ...emitter.reasoning('先想'),
      ...emitter.delta('再说'),
      ...emitter.tail({
        text: '再说',
        reasoning: '先想',
        toolCalls: [],
        model: 'deepseek-v4.1-flash',
        usage: { input: 1, cached: 0, output: 2 },
        createdAt: 0,
      }),
    ].map((chunk) => JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));

    const added = events.filter((event) => event.type === 'response.output_item.added');
    expect(added.map((event) => event.item.type)).toEqual(['reasoning', 'message']);
    // 序号是一条条排下去的：思考 0，消息 1。
    expect(added.map((event) => event.output_index)).toEqual([0, 1]);

    const deltas = events.filter((event) => event.type === 'response.reasoning_summary_text.delta');
    expect(deltas.map((event) => event.delta)).toEqual(['先想']);
    expect(deltas[0].item_id).toBe(added[0].item.id);

    const completed = events.at(-1)!;
    expect(completed.response.output.map((item: Record<string, unknown>) => item.type)).toEqual(['reasoning', 'message']);
  });

  it('没有思考的上游连 reasoning 条目都不出现', () => {
    const emitter = streamEmitter('openai-responses', 'req_1', 'm');
    const events = [
      ...emitter.head(),
      ...emitter.delta('只说这个'),
      ...emitter.tail({ text: '只说这个', reasoning: '', toolCalls: [], model: 'm', usage: { input: 1, cached: 0, output: 2 }, createdAt: 0 }),
    ].map((chunk) => JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));

    expect(events.some((event) => event.type?.toString().startsWith('response.reasoning'))).toBe(false);
    expect(events.at(-1)!.response.output.map((item: Record<string, unknown>) => item.type)).toEqual(['message']);
  });
});
