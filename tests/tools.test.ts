import { describe, expect, it } from 'vitest';

import { parseInbound, readAnswer, renderInbound, streamEmitter, type AnswerCore, type NormMeta } from '../src/dialects';
import { adapterFor, sanitizeGeminiSchema, type ChatBody } from '../src/protocols';

/**
 * 工具调用的翻译矩阵：4 个入口方言 × 4 个上游方言。
 *
 * 这里钉的是**方言**，不是协议：`deepseek` 必须收 Responses 形状的 tools（扁平），
 * `opencode-go` 必须收 Chat 形状的（套一层 `function`）——它们是协议名不同、方言相同的
 * 同一格。工具声明 / 一次调用 / 一条结果，这三样在两侧各说一遍，中间是规范形式。
 */

const weatherTool = {
  name: 'get_weather',
  description: '查天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

const answer: AnswerCore = {
  text: '',
  toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }],
  model: 'm',
  usage: { input: 10, cached: 0, output: 5 },
  createdAt: 0,
};

const norm: NormMeta = {
  request_id: 'req_1',
  fee_nanos: 0,
  gas_fee_nanos: 0,
  token_nanos: 0,
  input_tokens: 10,
  cached_tokens: 0,
  output_tokens: 5,
  unbilled_nanos: 0,
  balance_nanos: null,
  latency_ms: 1,
  host: 'api.example.com',
  pool: false,
};

/** 一段客户端请求：Chat 客户端问天气，模型已经要过一次工具、结果也回来了。 */
const chatRequest = {
  model: 'm',
  tools: [{ type: 'function', function: weatherTool }],
  tool_choice: { type: 'function', function: { name: 'get_weather' } },
  messages: [
    { role: 'user', content: '上海几度？' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
  ],
};

describe('入口 → 规范形式（四方言读工具）', () => {
  it('openai-chat：函数声明与老客户端的 functions 都读，工具结果是一条独立消息', () => {
    const body = parseInbound('openai-chat', chatRequest, 'm', false);
    expect(body.tools).toEqual([weatherTool]);
    expect(body.tool_choice).toEqual({ mode: 'tool', name: 'get_weather' });
    expect(body.messages?.[1].tool_calls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
    expect(body.messages?.[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' });
  });

  it('openai-chat：functions / function_call 这套老写法也认', () => {
    const body = parseInbound(
      'openai-chat',
      { model: 'm', functions: [weatherTool], function_call: { name: 'get_weather' }, messages: [{ role: 'user', content: '嗨' }] },
      'm',
      false,
    );
    expect(body.tools).toEqual([weatherTool]);
    expect(body.tool_choice).toEqual({ mode: 'tool', name: 'get_weather' });
  });

  it('openai-responses：调用与结果是 input 里的两类条目，连续的调用折回同一条 assistant', () => {
    const body = parseInbound(
      'openai-responses',
      {
        model: 'm',
        instructions: 'be nice',
        tools: [{ type: 'function', ...weatherTool }],
        tool_choice: { type: 'function', name: 'get_weather' },
        input: [
          { role: 'user', content: '上海几度？' },
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' },
          { type: 'function_call', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"北京"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
        ],
      },
      'm',
      false,
    );
    expect(body.tools).toEqual([weatherTool]);
    expect(body.tool_choice).toEqual({ mode: 'tool', name: 'get_weather' });
    expect(body.messages?.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body.messages?.[2].tool_calls?.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(body.messages?.[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' });
  });

  it('anthropic：input_schema 就是 parameters，tool_use 与 tool_result 都是 content 块', () => {
    const body = parseInbound(
      'anthropic-messages',
      {
        model: 'm',
        max_tokens: 100,
        system: 'be nice',
        tools: [{ name: 'get_weather', description: '查天气', input_schema: weatherTool.parameters }],
        tool_choice: { type: 'any' },
        messages: [
          { role: 'user', content: '上海几度？' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '上海' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":21}' }] },
        ],
      },
      'm',
      false,
    );
    expect(body.tools).toEqual([weatherTool]);
    expect(body.tool_choice).toEqual({ mode: 'required' });
    expect(body.messages?.[2].tool_calls).toEqual([{ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
    expect(body.messages?.[3]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: '{"temp":21}' });
  });

  it('google-gemini：functionDeclarations 摊平，工具结果按函数名找回调用 id', () => {
    const body = parseInbound(
      'google-gemini',
      {
        model: 'm',
        systemInstruction: { parts: [{ text: 'be nice' }] },
        tools: [{ functionDeclarations: [weatherTool] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
        contents: [
          { role: 'user', parts: [{ text: '上海几度？' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
        ],
      },
      'm',
      false,
    );
    expect(body.tools).toEqual([weatherTool]);
    expect(body.tool_choice).toEqual({ mode: 'tool', name: 'get_weather' });
    expect(body.messages?.[2].tool_calls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
    expect(body.messages?.[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' });
  });
});

describe('规范形式 → 上游请求（四方言说工具）', () => {
  const canonical: ChatBody = parseInbound('openai-chat', chatRequest, 'm', false);

  it('openai-chat：函数套在 function 里，工具结果单列一条 role=tool', () => {
    const out = adapterFor('openai-chat').request(canonical, 'm') as Record<string, any>;
    expect(out.tools).toEqual([{ type: 'function', function: weatherTool }]);
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(out.messages[1].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
    ]);
    expect(out.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' });
  });

  it('opencode-go：协议名不同、方言相同——请求体与 openai-chat 一模一样', () => {
    expect(adapterFor('opencode-go').request(canonical, 'm')).toEqual(adapterFor('openai-chat').request(canonical, 'm'));
  });

  it('openai-responses：工具声明是扁平的，调用与结果各占一条 input 条目', () => {
    const out = adapterFor('openai-responses').request(canonical, 'm') as Record<string, any>;
    expect(out.tools).toEqual([{ type: 'function', ...weatherTool }]);
    expect(out.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
    expect(out.input).toEqual([
      { role: 'user', content: '上海几度？' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
    ]);
  });

  it('deepseek：说 Responses 方言，所以收的就是 Responses 形状的 tools，不是 Chat 的', () => {
    const deepseek = adapterFor('deepseek').request(canonical, 'm') as Record<string, any>;
    expect(deepseek).toEqual(adapterFor('openai-responses').request(canonical, 'm'));
    expect(deepseek.tools[0]).not.toHaveProperty('function');
  });

  it('anthropic：input_schema 接着 parameters，tool_use 与 tool_result 都是 content 块', () => {
    const out = adapterFor('anthropic-messages').request(canonical, 'm') as Record<string, any>;
    expect(out.tools).toEqual([{ name: 'get_weather', description: '查天气', input_schema: weatherTool.parameters }]);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '上海几度？' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '上海' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temp":21}' }] },
    ]);
  });

  it('google-gemini：functionDeclarations 一包，functionResponse 按名字对齐、response 是对象', () => {
    const out = adapterFor('google-gemini').request(canonical, 'm') as Record<string, any>;
    expect(out.tools).toEqual([{ functionDeclarations: [weatherTool] }]);
    expect(out.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } });
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: '上海几度？' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
    ]);
  });
});

describe('上游响应 → 规范形式（四方言读出工具调用）', () => {
  it('openai-chat', () => {
    const core = readAnswer('openai-chat', {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(core.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
    expect(core.text).toBe('');
  });

  it('openai-responses', () => {
    const core = readAnswer('openai-responses', {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }],
    });
    expect(core.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
  });

  it('anthropic', () => {
    const core = readAnswer('anthropic-messages', {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '上海' } }],
    });
    expect(core.toolCalls).toEqual([{ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"上海"}' }]);
  });

  it('google-gemini', () => {
    const core = readAnswer('google-gemini', {
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] } }],
    });
    expect(core.toolCalls).toEqual([{ id: 'call_get_weather', name: 'get_weather', arguments: '{"city":"上海"}' }]);
  });
});

describe('规范形式 → 入口方言（四方言回工具调用）', () => {
  it('openai-chat：content 为 null、finish_reason 是 tool_calls', () => {
    const out = renderInbound('openai-chat', answer, norm) as Record<string, any>;
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
    ]);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });

  it('anthropic：tool_use 块 + stop_reason tool_use', () => {
    const out = renderInbound('anthropic-messages', answer, norm) as Record<string, any>;
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '上海' } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('openai-responses：output 里是 function_call 条目', () => {
    const out = renderInbound('openai-responses', answer, norm) as Record<string, any>;
    expect(out.output).toEqual([
      {
        id: 'fc_req_1_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"上海"}',
      },
    ]);
  });

  it('google-gemini：parts 里是 functionCall，参数是对象', () => {
    const out = renderInbound('google-gemini', answer, norm) as Record<string, any>;
    expect(out.candidates[0].content.parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: '上海' } } }]);
  });
});

describe('流式：上游帧 → 规范事件', () => {
  it('openai-chat：第一帧给 id 与名字，之后是参数片段', () => {
    const events = adapterFor('openai-chat').streamEvents(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } }] } }] }),
    );
    expect(events).toEqual([
      { kind: 'tool_start', index: 0, id: 'call_1', name: 'get_weather' },
      { kind: 'tool_args', index: 0, args: '{"city"' },
    ]);
  });

  it('openai-responses：output_item.added 开调用，参数走自己的增量事件', () => {
    const events = [
      ...adapterFor('openai-responses').streamEvents(
        JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' } }),
      ),
      ...adapterFor('openai-responses').streamEvents(
        JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city"' }),
      ),
    ];
    expect(events).toEqual([
      { kind: 'tool_start', index: 1, id: 'call_1', name: 'get_weather' },
      { kind: 'tool_args', index: 1, args: '{"city"' },
    ]);
  });

  it('anthropic：tool_use 块开始，input_json_delta 给参数', () => {
    const events = [
      ...adapterFor('anthropic-messages').streamEvents(
        JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } }),
      ),
      ...adapterFor('anthropic-messages').streamEvents(
        JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } }),
      ),
    ];
    expect(events).toEqual([
      { kind: 'tool_start', index: 1, id: 'toolu_1', name: 'get_weather' },
      { kind: 'tool_args', index: 1, args: '{"city"' },
    ]);
  });

  it('gemini：没有增量，一帧就把名字与整段参数给全', () => {
    const events = adapterFor('google-gemini').streamEvents(
      JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] } }] }),
    );
    expect(events).toEqual([
      { kind: 'tool_start', index: 0, id: 'call_1', name: 'get_weather' },
      { kind: 'tool_args', index: 0, args: '{"city":"上海"}' },
    ]);
  });
});

/** 把 emitter 吐出的帧拆成「事件名 + JSON」：两种 SSE 形状（带事件名 / 裸 data）都能读。 */
const sse = (chunks: string[]) =>
  chunks.map((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
    const line = chunk.split('\n').find((entry) => entry.startsWith('data: ')) ?? 'data: {}';
    return { event, json: JSON.parse(line.slice(6)) as Record<string, any> };
  });

describe('流式：规范事件 → 入口帧', () => {
  it('openai-chat：tool_calls 的 index 从 0 起，finish_reason 是 tool_calls', () => {
    const emitter = streamEmitter('openai-chat', 'req_1', 'm');
    const deltas = sse([
      ...emitter.toolStart(7, { id: 'call_1', name: 'get_weather' }),
      ...emitter.toolArgs(7, '{"city"'),
      ...emitter.toolArgs(7, ':"上海"}'),
    ]).map((frame) => frame.json.choices[0].delta);
    expect(deltas[0].tool_calls[0]).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
    });
    expect(deltas[1].tool_calls[0].function.arguments).toBe('{"city"');
    expect(deltas[2].tool_calls[0].function.arguments).toBe(':"上海"}');
    expect(sse(emitter.tail(answer))[0].json.choices[0].finish_reason).toBe('tool_calls');
  });

  it('anthropic：先关文本块，再开 tool_use 块，收尾 stop_reason 是 tool_use', () => {
    const emitter = streamEmitter('anthropic-messages', 'req_1', 'm');
    const opened = sse(emitter.toolStart(0, { id: 'call_1', name: 'get_weather' }));
    expect(opened.map((frame) => frame.event)).toEqual(['content_block_stop', 'content_block_start']);
    expect(opened[0].json.index).toBe(0);
    expect(opened[1].json.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });
    expect(sse(emitter.toolArgs(0, '{"city"'))[0].json.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city"' });
    const tail = sse(emitter.tail(answer));
    expect(tail[0].event).toBe('content_block_stop');
    expect(tail[1].json.delta.stop_reason).toBe('tool_use');
  });

  it('openai-responses：先关文本 item，再开 function_call item，completed 里带全量参数', () => {
    const emitter = streamEmitter('openai-responses', 'req_1', 'm');
    const opened = sse(emitter.toolStart(0, { id: 'call_1', name: 'get_weather' }));
    expect(opened.map((frame) => frame.event)).toEqual([
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
    ]);
    expect(opened[3].json).toMatchObject({ output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' } });
    sse(emitter.toolArgs(0, '{"city"'));
    const tail = sse(emitter.tail(answer));
    const completed = tail[tail.length - 1].json.response;
    expect(completed.output).toEqual([
      {
        id: 'fc_req_1_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"上海"}',
      },
    ]);
  });

  it('gemini：流里没有工具帧，收尾那一帧带上完整的 functionCall；纯文本收尾不发空 parts', () => {
    const emitter = streamEmitter('google-gemini', 'req_1', 'm');
    expect(emitter.toolStart(0, { id: 'call_1', name: 'get_weather' })).toEqual([]);
    expect(emitter.toolArgs(0, '{"city"')).toEqual([]);
    const frame = sse(emitter.tail(answer))[0];
    expect(frame.json.candidates[0].content.parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: '上海' } } }]);

    const textOnly = sse(
      streamEmitter('google-gemini', 'req_2', 'm').tail({
        ...answer,
        text: 'hello',
        toolCalls: [],
      }),
    )[0];
    expect(textOnly.json.candidates[0].content).toBeUndefined();
    expect(textOnly.json.candidates[0].finishReason).toBe('STOP');
  });
});

describe('4×4 跨方言边界与参数透传回归', () => {
  it('Bug 1 + 采样参数：openai-chat 的 max_tokens / max_completion_tokens / temperature / top_p / stop 完整过桥', () => {
    const fromChat = parseInbound(
      'openai-chat',
      {
        model: 'm',
        max_tokens: 4096,
        temperature: 0.3,
        top_p: 0.9,
        stop: ['END', 'STOP'],
        messages: [{ role: 'user', content: 'hi' }],
      },
      'm',
      false,
    );
    expect(fromChat.max_tokens).toBe(4096);
    expect(fromChat.temperature).toBe(0.3);
    expect(fromChat.top_p).toBe(0.9);
    expect(fromChat.stop).toEqual(['END', 'STOP']);

    // max_completion_tokens 优先于旧的 max_tokens
    const withCompletion = parseInbound(
      'openai-chat',
      { model: 'm', max_tokens: 512, max_completion_tokens: 8192, stop: 'HALT', messages: [{ role: 'user', content: 'hi' }] },
      'm',
      false,
    );
    expect(withCompletion.max_tokens).toBe(8192);
    expect(withCompletion.stop).toEqual(['HALT']);

    // 落到 Anthropic / Responses / Gemini 各自字段
    const anth = adapterFor('anthropic-messages').request(fromChat, 'm') as Record<string, any>;
    expect(anth.max_tokens).toBe(4096);
    expect(anth.temperature).toBe(0.3);
    expect(anth.top_p).toBe(0.9);
    expect(anth.stop_sequences).toEqual(['END', 'STOP']);

    const resp = adapterFor('openai-responses').request(fromChat, 'm') as Record<string, any>;
    expect(resp.max_output_tokens).toBe(4096);
    expect(resp.temperature).toBe(0.3);
    expect(resp.top_p).toBe(0.9);

    const gem = adapterFor('google-gemini').request(fromChat, 'm') as Record<string, any>;
    expect(gem.generationConfig).toEqual({
      maxOutputTokens: 4096,
      temperature: 0.3,
      topP: 0.9,
      stopSequences: ['END', 'STOP'],
    });

    // 反向：从 Gemini generationConfig 读入并透传到 Chat
    const fromGemini = parseInbound(
      'google-gemini',
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.5, topP: 0.8, stopSequences: ['DONE'] },
      },
      'm',
      false,
    );
    const toChat = adapterFor('openai-chat').request(fromGemini, 'm') as Record<string, any>;
    expect(toChat.max_tokens).toBe(2048);
    expect(toChat.temperature).toBe(0.5);
    expect(toChat.top_p).toBe(0.8);
    expect(toChat.stop).toEqual(['DONE']);
  });

  it('Bug 3：Chat 文本块数组不再被 JSON.stringify，developer 角色归一成 system 不打 400', () => {
    const body = parseInbound(
      'openai-chat',
      {
        model: 'm',
        messages: [
          { role: 'developer', content: [{ type: 'text', text: '遵守规则' }] },
          { role: 'user', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
        ],
      },
      'm',
      false,
    );
    expect(body.messages).toEqual([
      { role: 'system', content: '遵守规则' },
      { role: 'user', content: '第一行\n第二行' },
    ]);

    const anth = adapterFor('anthropic-messages').request(body, 'm') as Record<string, any>;
    expect(anth.system).toBe('遵守规则');
    expect(anth.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '第一行\n第二行' }] }]);

    // Responses 里的 developer role 同样归一成 system
    const fromResp = parseInbound(
      'openai-responses',
      {
        model: 'm',
        input: [
          { role: 'developer', content: '严禁编造' },
          { role: 'user', content: 'hi' },
        ],
      },
      'm',
      false,
    );
    expect(fromResp.messages).toEqual([
      { role: 'system', content: '严禁编造' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('Bug 4：Gemini 流式多帧并行 functionCall 靠 toolOffset 递增编号，不互相覆盖', () => {
    const adapter = adapterFor('google-gemini');
    const frame1 = JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: { x: 1 } } }] } }] });
    const frame2 = JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'b', args: { y: 2 } } }] } }] });
    const e1 = adapter.streamEvents(frame1, 0);
    const e2 = adapter.streamEvents(frame2, 1);
    expect(e1).toEqual([
      { kind: 'tool_start', index: 0, id: 'call_1', name: 'a' },
      { kind: 'tool_args', index: 0, args: '{"x":1}' },
    ]);
    expect(e2).toEqual([
      { kind: 'tool_start', index: 1, id: 'call_2', name: 'b' },
      { kind: 'tool_args', index: 1, args: '{"y":2}' },
    ]);
  });

  it('Bug 5：Gemini functionDeclarations 清洗 $schema / additionalProperties / default 并转换 nullable', () => {
    const dirty = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      title: 'WeatherArgs',
      additionalProperties: false,
      properties: {
        city: { type: 'string', default: '上海', minLength: 1 },
        unit: { type: ['string', 'null'], const: 'C' },
      },
      required: ['city'],
    };
    expect(sanitizeGeminiSchema(dirty)).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', nullable: true, enum: ['C'] },
      },
      required: ['city'],
    });
  });

  it('Bug 6：Anthropic usage.input_tokens 下界夹到 0；工具块后若再吐文本新开文本块而非写回已关的块 0', () => {
    const anomalous: AnswerCore = { ...answer, usage: { input: 5, cached: 12, output: 3 } };
    const rendered = renderInbound('anthropic-messages', anomalous, norm) as Record<string, any>;
    expect(rendered.usage.input_tokens).toBe(0);
    expect(rendered.usage.cache_read_input_tokens).toBe(12);

    const emitter = streamEmitter('anthropic-messages', 'req_1', 'm');
    emitter.head();
    emitter.toolStart(0, { id: 'call_1', name: 'get_weather' }); // 关 block 0，开 block 1
    const afterTool = sse(emitter.delta('补充一句'));
    expect(afterTool.map((f) => f.event)).toEqual(['content_block_stop', 'content_block_start', 'content_block_delta']);
    expect(afterTool[0].json.index).toBe(1);
    expect(afterTool[1].json.index).toBe(2);
    expect(afterTool[2].json.index).toBe(2);
    expect(afterTool[2].json.delta.text).toBe('补充一句');

    const tail = sse(emitter.tail(anomalous));
    const msgDelta = tail.find((f) => f.event === 'message_delta');
    expect(msgDelta?.json.usage.input_tokens).toBe(0);
  });
});
