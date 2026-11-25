/**
 * 四条方言，两侧同名。
 *
 * Norm 的转发是 4×4 的：客户端用哪种方言说话（入口）× 上游说哪种协议（凭证）。
 * 因为两侧用的是同一套名字，「入口方言 === 上游协议」就是一句字符串相等——
 * 而那 4 格**不转换**：请求体原样发出去，响应体原样还回来，一个字段都不碰。
 *
 * 只有其余 12 格才经过 OpenAI Chat 这座桥：入口 → ChatBody → 上游适配器（见
 * upstreams.ts，它只管 ChatBody 到四种上游）→ 回来时再渲染成入口方言。
 * 桥只在这一侧出现，所以「4 入口 × 4 上游」不是 16 条路径，而是 4 段入口翻译
 * 加 4 段上游适配，互不相干。
 *
 * 不做的事：**跨方言的工具调用**。同格式直通时 tools 免费穿过（我们不碰它），
 * 但跨方言时三家的 tools 形状各不相同，硬拼一个「尽力而为」的映射，只会在客户端
 * 以为有 function calling 时收到一段散文。所以跨方言带 tools 的请求在这里就拒绝。
 */
import { fail } from './http';
import type { ChatBody, ChatMessage, UpstreamProtocol } from './upstreams';

export type Dialect = UpstreamProtocol;

/** 从任意一种方言的响应里读出的、记账与渲染都需要的那点东西。 */
export type AnswerCore = {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  createdAt: number;
};

export type NormMeta = {
  request_id: string;
  fee_micros: number;
  balance_micros: number | null;
  latency_ms: number;
  host: string;
};

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
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

const extractChat = (json: Raw): AnswerCore => {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as { message?: { content?: unknown } } | undefined;
  const usage = (json.usage ?? {}) as Raw;
  return {
    text: flatten(choice?.message?.content),
    model: text(json.model),
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    createdAt: num(json.created),
  };
};

const extractResponses = (json: Raw): AnswerCore => {
  const output = Array.isArray(json.output) ? json.output : [];
  const usage = (json.usage ?? {}) as Raw;
  return {
    text: output.map((item) => flatten((item as { content?: unknown }).content)).filter(Boolean).join('\n'),
    model: text(json.model),
    promptTokens: num(usage.input_tokens),
    completionTokens: num(usage.output_tokens),
    createdAt: num(json.created_at),
  };
};

const extractAnthropic = (json: Raw): AnswerCore => {
  const usage = (json.usage ?? {}) as Raw;
  return {
    text: (Array.isArray(json.content) ? json.content : []).map((block) => text((block as { text?: unknown }).text)).join(''),
    model: text(json.model),
    promptTokens: num(usage.input_tokens),
    completionTokens: num(usage.output_tokens),
    createdAt: 0,
  };
};

const extractGemini = (json: Raw): AnswerCore => {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const usage = (json.usageMetadata ?? {}) as Raw;
  return {
    text: candidates.map((candidate) => flatten((candidate as { content?: { parts?: unknown } }).content?.parts)).filter(Boolean).join('\n'),
    model: text(json.modelVersion),
    promptTokens: num(usage.promptTokenCount),
    completionTokens: num(usage.candidatesTokenCount),
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
 * 上游适配器已经把响应翻译成 OpenAI Chat 形状，这里再落到客户端要的方言。
 * `norm` 只加在顶层：它是附加字段，按已知字段反序列化的客户端会忽略它。
 */
export function renderInbound(dialect: Dialect, answer: AnswerCore, norm: NormMeta): unknown {
  if (dialect === 'openai-chat') {
    return {
      id: `chatcmpl-${norm.request_id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: answer.model,
      choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: answer.promptTokens, completion_tokens: answer.completionTokens },
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
      usage: { input_tokens: answer.promptTokens, output_tokens: answer.completionTokens },
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
        input_tokens: answer.promptTokens,
        output_tokens: answer.completionTokens,
        total_tokens: answer.promptTokens + answer.completionTokens,
      },
      norm,
    };
  }

  return {
    candidates: [{ content: { role: 'model', parts: [{ text: answer.text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {
      promptTokenCount: answer.promptTokens,
      candidatesTokenCount: answer.completionTokens,
      totalTokenCount: answer.promptTokens + answer.completionTokens,
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
            input_tokens: answer.promptTokens,
            output_tokens: answer.completionTokens,
            total_tokens: answer.promptTokens + answer.completionTokens,
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
      named('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: answer.completionTokens } }),
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
            promptTokenCount: answer.promptTokens,
            candidatesTokenCount: answer.completionTokens,
            totalTokenCount: answer.promptTokens + answer.completionTokens,
          },
          modelVersion: answer.model,
        }),
      ],
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
