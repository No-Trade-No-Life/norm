/**
 * 四条方言，两侧同名。
 *
 * Norm 的转发是 4×4 的：客户端用哪种方言说话（入口）× 上游提供商说哪种协议（上游提供商）。
 * 因为两侧用的是同一套名字，「入口方言 === 上游提供商协议」就是一句字符串相等——
 * 而那 4 格**不转换**：请求体原样发出去，响应体原样还回来，一个字段都不碰。
 *
 * 只有其余 12 格才经过 OpenAI Chat 这座桥：入口 → ChatBody → 协议适配器（见
 * providers.ts，它只管 ChatBody 到四种上游提供商）→ 回来时再渲染成入口方言。
 * 桥只在这一侧出现，所以「4 入口 × 4 上游提供商」不是 16 条路径，而是 4 段入口翻译
 * 加 4 段上游提供商适配，互不相干。
 *
 * 不做的事：**跨方言的工具调用**。同格式直通时 tools 免费穿过（我们不碰它），
 * 但跨方言时三家的 tools 形状各不相同，硬拼一个「尽力而为」的映射，只会在客户端
 * 以为有 function calling 时收到一段散文。所以跨方言带 tools 的请求在这里就拒绝。
 */
import { fail } from './http';
import type { Usage } from './pricing';
import type { ChatBody, ChatMessage, Protocol } from './protocols';

export type Dialect = Protocol;

/**
 * 从任意一种方言的响应里读出的、记账与渲染都需要的那点东西。
 *
 * `usage` 只有三项，因为账本只认这三种 token：
 *   input   输入 token 总量（**含**缓存命中的那部分）
 *   cached  其中命中上游提供商缓存的
 *   output  输出 token
 * 四家的口径各不相同（Anthropic 的 `input_tokens` 不含缓存读，OpenAI 的
 * `prompt_tokens` 含），归一化只发生在下面四个 extract 里，别处不再判断方言。
 */
export type AnswerCore = {
  text: string;
  model: string;
  usage: Usage;
  createdAt: number;
};

/** 一次调用的账单结论：总价、构成、以及算这笔账用的三项 token。 */
export type NormMeta = {
  request_id: string;
  fee_nanos: number;
  service_fee_nanos: number;
  token_nanos: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  /** 余额不足时没能收上来的部分；正常为 0。 */
  unbilled_nanos: number;
  balance_nanos: number | null;
  latency_ms: number;
  host: string;
};

/** 四家方言里表示「用量」的那几个字段名，集中在这里，别处不出现。 */
export type RawUsage = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): RawUsage => (value !== null && typeof value === 'object' ? (value as RawUsage) : {});

type Raw = Record<string, unknown>;

/** 一个请求只回答一个问题：这段内容是什么。四种方言的块名不同，形状一样。 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function textField(body: Raw, field: string): string {
  return flatten(body[field]);
}

function rejectTools(dialect: Dialect, body: Raw): void {
  for (const field of ['tools', 'tool_choice', 'functions', 'function_call']) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    fail(400, 'tools_unsupported', `跨方言不翻译工具调用（${dialect} 入口的 ${field}）；同格式调用或 /v1/chat/completions 不受影响`);
  }
}

/* ── 入口 → 规范形式（OpenAI Chat） ───────────────────────────────── */

function chatFromChat(raw: Raw): ChatMessage[] {
  return (Array.isArray(raw.messages) ? raw.messages : []) as ChatMessage[];
}

/** Anthropic Messages：system 是独立字段，messages 里只有 user / assistant。 */
function chatFromAnthropic(raw: Raw): ChatMessage[] {
  const turns = (Array.isArray(raw.messages) ? raw.messages : []).map((entry) => {
    const message = entry as { role?: string; content?: unknown };
    return { role: message.role === 'assistant' ? 'assistant' : 'user', content: flatten(message.content) };
  });
  const system = textField(raw, 'system');
  return system ? [{ role: 'system', content: system }, ...turns] : turns;
}

/** OpenAI Responses：`instructions` 是 system，`input` 可以是一句话或条目数组。 */
function chatFromResponses(raw: Raw): ChatMessage[] {
  const input = Array.isArray(raw.input)
    ? raw.input.map((entry) => {
        const item = entry as { role?: string; content?: unknown };
        return { role: item.role === 'assistant' ? 'assistant' : 'user', content: flatten(item.content) };
      })
    : [{ role: 'user', content: flatten(raw.input) }];
  const instructions = textField(raw, 'instructions');
  return instructions ? [{ role: 'system', content: instructions }, ...input] : input;
}

/** Gemini：contents / parts，system 走 systemInstruction，模型在路径上。 */
function chatFromGemini(raw: Raw): ChatMessage[] {
  const turns = (Array.isArray(raw.contents) ? raw.contents : []).map((entry) => {
    const content = entry as { role?: string; parts?: unknown };
    return { role: content.role === 'model' ? 'assistant' : 'user', content: flatten(content.parts) };
  });
  const system = flatten((raw.systemInstruction as { parts?: unknown } | undefined)?.parts);
  return system ? [{ role: 'system', content: system }, ...turns] : turns;
}

const PARSE: Record<Dialect, (raw: Raw, model: string) => ChatMessage[]> = {
  'openai-chat': chatFromChat,
  'openai-responses': chatFromResponses,
  'anthropic-messages': chatFromAnthropic,
  'google-gemini': chatFromGemini,
};

/**
 * 只用在**跨方言**那 12 格上；同格式直通时这个函数不会被调用。
 *
 * `stream` 由调用方给出，不从 body 里读：Gemini 的流式写在路径上
 * （`:streamGenerateContent`），body 里没有这个字段，从 body 读会把它抹成 false。
 */
export function parseInbound(dialect: Dialect, raw: Raw, model: string, stream: boolean): ChatBody {
  rejectTools(dialect, raw);
  const maxTokens =
    dialect === 'anthropic-messages' ? raw.max_tokens : dialect === 'google-gemini' ? (raw.generationConfig as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens : raw.max_output_tokens;
  return {
    model,
    messages: PARSE[dialect](raw, model),
    stream,
    ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
  };
}

/* ── 响应 → AnswerCore（记账与渲染都要的中间物，不是方言） ──────────── */

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * OpenAI chat / responses：`prompt_tokens` / `input_tokens` **含**缓存命中的部分，
 * 命中数在 `*_details.cached_tokens` 里。
 */
function chatUsage(raw: RawUsage): Usage {
  const details = obj(raw.prompt_tokens_details ?? raw.input_tokens_details);
  return {
    input: num(raw.prompt_tokens ?? raw.input_tokens),
    cached: num(details.cached_tokens),
    output: num(raw.completion_tokens ?? raw.output_tokens),
  };
}

/**
 * Anthropic：`input_tokens` **不含**缓存读与缓存写，另外两项单独给。
 * 所以输入总量要三项相加，命中数只算 `cache_read_input_tokens`。
 * 缓存写按普通输入计价——那是有意的保守：它其实比普通输入贵，按便宜的收，
 * 账面不会多收用户的钱。
 */
function anthropicUsage(raw: RawUsage): Usage {
  const fresh = num(raw.input_tokens);
  const read = num(raw.cache_read_input_tokens);
  const created = num(raw.cache_creation_input_tokens);
  return { input: fresh + read + created, cached: read, output: num(raw.output_tokens) };
}

/** Gemini：`promptTokenCount` 含 `cachedContentTokenCount`。 */
function geminiUsage(raw: RawUsage): Usage {
  return {
    input: num(raw.promptTokenCount),
    cached: num(raw.cachedContentTokenCount),
    output: num(raw.candidatesTokenCount),
  };
}

const extractChat = (json: Raw): AnswerCore => {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as { message?: { content?: unknown } } | undefined;
  return {
    text: flatten(choice?.message?.content),
    model: text(json.model),
    usage: chatUsage(obj(json.usage)),
    createdAt: num(json.created),
  };
};

const extractResponses = (json: Raw): AnswerCore => {
  const output = Array.isArray(json.output) ? json.output : [];
  return {
    text: output.map((item) => flatten((item as { content?: unknown }).content)).filter(Boolean).join('\n'),
    model: text(json.model),
    usage: chatUsage(obj(json.usage)),
    createdAt: num(json.created_at),
  };
};

const extractAnthropic = (json: Raw): AnswerCore => {
  return {
    text: (Array.isArray(json.content) ? json.content : []).map((block) => text((block as { text?: unknown }).text)).join(''),
    model: text(json.model),
    usage: anthropicUsage(obj(json.usage)),
    createdAt: 0,
  };
};

const extractGemini = (json: Raw): AnswerCore => {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  return {
    text: candidates.map((candidate) => flatten((candidate as { content?: { parts?: unknown } }).content?.parts)).filter(Boolean).join('\n'),
    model: text(json.modelVersion),
    usage: geminiUsage(obj(json.usageMetadata)),
    createdAt: 0,
  };
};

const EXTRACT: Record<Dialect, (json: Raw) => AnswerCore> = {
  'openai-chat': extractChat,
  'openai-responses': extractResponses,
  'anthropic-messages': extractAnthropic,
  'google-gemini': extractGemini,
};

export function readAnswer(dialect: Dialect, json: Raw): AnswerCore {
  return EXTRACT[dialect](json ?? {});
}

/* ── 规范形式 → 出口方言（只用在跨方言那 12 格） ───────────────────── */

/**
 * 协议适配器已经把响应翻译成 OpenAI Chat 形状，这里再落到客户端要的方言。
 * `norm` 只加在顶层：它是附加字段，按已知字段反序列化的客户端会忽略它。
 */
export function renderInbound(dialect: Dialect, answer: AnswerCore, norm: NormMeta): unknown {
  const { input, cached, output } = answer.usage;

  if (dialect === 'openai-chat') {
    return {
      id: `chatcmpl-${norm.request_id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: answer.model,
      choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }],
      // prompt_tokens 含缓存命中的那部分，与 OpenAI 自己的口径一致；命中数单列。
      usage: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        prompt_tokens_details: { cached_tokens: cached },
      },
      norm,
    };
  }

  if (dialect === 'anthropic-messages') {
    return {
      id: `msg_${norm.request_id}`,
      type: 'message',
      role: 'assistant',
      model: answer.model,
      content: [{ type: 'text', text: answer.text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      // Anthropic 的 input_tokens 不含缓存读，所以这里回的是扣掉命中的那部分。
      usage: { input_tokens: input - cached, output_tokens: output, cache_read_input_tokens: cached },
      norm,
    };
  }

  if (dialect === 'openai-responses') {
    return {
      id: `resp_${norm.request_id}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: answer.model,
      output: [
        {
          id: `msg_${norm.request_id}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: answer.text }],
        },
      ],
      usage: {
        input_tokens: input,
        input_tokens_details: { cached_tokens: cached },
        output_tokens: output,
        total_tokens: input + output,
      },
      norm,
    };
  }

  return {
    candidates: [{ content: { role: 'model', parts: [{ text: answer.text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {
      promptTokenCount: input,
      cachedContentTokenCount: cached,
      candidatesTokenCount: output,
      totalTokenCount: input + output,
    },
    modelVersion: answer.model,
    norm,
  };
}

/* ── 流式的出口帧 ─────────────────────────────────────────────────── */

export type StreamEmitter = {
  /** 开流：建立 message / response 骨架。 */
  head(): string[];
  /** 每个文本增量。 */
  delta(text: string): string[];
  /** 收尾：停止标记与用量。此时才知道最终 token 数。 */
  tail(answer: AnswerCore): string[];
};

/** 带事件名的 SSE（Responses / Anthropic 都按 `type` 分派）。 */
const named = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Gemini 的流是不带事件名的裸 data 帧。 */
const bare = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function chatEmitter(id: string, model: string): StreamEmitter {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...extra }] });
  return {
    head: () => [`data: ${chunk({ role: 'assistant', content: '' })}\n\n`],
    delta: (text) => [`data: ${chunk({ content: text })}\n\n`],
    tail: () => [`data: ${chunk({}, { finish_reason: 'stop' })}\n\n`],
  };
}

function responsesEmitter(id: string, model: string): StreamEmitter {
  const itemId = `msg_${id}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let text = '';
  const message = (status: string, content: unknown[]) => ({ id: itemId, type: 'message', status, role: 'assistant', content });

  return {
    head: () => [
      named('response.created', { type: 'response.created', response: { id, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [] } }),
      named('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: message('in_progress', []) }),
      named('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
    ],
    delta: (delta) => {
      text += delta;
      return [named('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta })];
    },
    tail: (answer) => [
      named('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text }),
      named('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text } }),
      named('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: message('completed', [{ type: 'output_text', text }]) }),
      named('response.completed', {
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          created_at: createdAt,
          status: 'completed',
          model: answer.model,
          output: [message('completed', [{ type: 'output_text', text }])],
          usage: {
            input_tokens: answer.usage.input,
            input_tokens_details: { cached_tokens: answer.usage.cached },
            output_tokens: answer.usage.output,
            total_tokens: answer.usage.input + answer.usage.output,
          },
        },
      }),
    ],
  };
}

function anthropicEmitter(id: string, model: string): StreamEmitter {
  return {
    head: () => [
      named('message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ],
    delta: (text) => [named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })],
    tail: (answer) => [
      named('content_block_stop', { type: 'content_block_stop', index: 0 }),
      named('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: answer.usage.output,
          input_tokens: answer.usage.input - answer.usage.cached,
          cache_read_input_tokens: answer.usage.cached,
        },
      }),
      named('message_stop', { type: 'message_stop' }),
    ],
  };
}

function geminiEmitter(_id: string, model: string): StreamEmitter {
  return {
    head: () => [],
    delta: (text) => [bare({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }], modelVersion: model })],
    tail: (answer) =>
      [
        bare({
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: {
            promptTokenCount: answer.usage.input,
            cachedContentTokenCount: answer.usage.cached,
            candidatesTokenCount: answer.usage.output,
            totalTokenCount: answer.usage.input + answer.usage.output,
          },
          modelVersion: answer.model,
        }),
      ],
  };
}

/* ── 流式里的用量 ─────────────────────────────────────────────────── */

/**
 * 流式响应里，用量散在几个不相邻的帧里，而且各自的含义不同：
 *
 *   openai-chat        末帧的 `usage`（只在请求 `stream_options.include_usage` 时出现）
 *   openai-responses   `response.completed` 里的 `response.usage`
 *   anthropic-messages `message_start` 给输入与缓存，`message_delta` 给输出
 *   google-gemini      每一帧都带一次累计的 `usageMetadata`
 *
 * 所以这里不是一个「读最后一帧」的函数，而是一个累加器：同一字段取最大值
 * （都是累计计数，取最大等于取最后一次完整读数），缺的字段保持原值。
 * 一个流里一次用量都没给时，三项都是 0——账单为 0，与 docs/api.md 的说法一致。
 */
export function usageSniffer(dialect: Dialect): { push(data: string): void; usage(): Usage } {
  const acc: Usage = { input: 0, cached: 0, output: 0 };

  const takeChat = (raw: RawUsage) => {
    const usage = chatUsage(raw);
    acc.input = Math.max(acc.input, usage.input);
    acc.cached = Math.max(acc.cached, usage.cached);
    acc.output = Math.max(acc.output, usage.output);
  };

  const takeAnthropic = (raw: RawUsage) => {
    const fresh = num(raw.input_tokens);
    const read = num(raw.cache_read_input_tokens);
    const created = num(raw.cache_creation_input_tokens);
    if (fresh + read + created > 0) {
      acc.input = Math.max(acc.input, fresh + read + created);
      acc.cached = Math.max(acc.cached, read);
    }
    acc.output = Math.max(acc.output, num(raw.output_tokens));
  };

  const takeGemini = (raw: RawUsage) => {
    const usage = geminiUsage(raw);
    acc.input = Math.max(acc.input, usage.input);
    acc.cached = Math.max(acc.cached, usage.cached);
    acc.output = Math.max(acc.output, usage.output);
  };

  return {
    push(data) {
      if (data.length === 0 || data === '[DONE]') return;
      let json: Raw;
      try {
        json = JSON.parse(data) as Raw;
      } catch {
        return;
      }
      if (dialect === 'openai-chat') takeChat(obj(json.usage));
      else if (dialect === 'openai-responses') {
        if (json.type === 'response.completed') takeChat(obj(obj(json.response).usage));
      } else if (dialect === 'anthropic-messages') {
        // 输入在 `message_start`（包里套一层 message.usage），输出在 `message_delta`（顶层）。
        takeAnthropic(obj(json.usage ?? obj(json.message).usage));
      }
      else takeGemini(obj(json.usageMetadata));
    },
    usage: () => ({ ...acc }),
  };
}

const EMITTERS: Record<Dialect, (id: string, model: string) => StreamEmitter> = {
  'openai-chat': chatEmitter,
  'openai-responses': responsesEmitter,
  'anthropic-messages': anthropicEmitter,
  'google-gemini': geminiEmitter,
};

export function streamEmitter(dialect: Dialect, id: string, model: string): StreamEmitter {
  return EMITTERS[dialect](id, model);
}
