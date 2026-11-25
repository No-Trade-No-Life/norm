/**
 * 上游提供商：只有四种协议，其余都是它们的变体。
 *
 *   openai-chat         {base}/chat/completions
 *   openai-responses    {base}/responses
 *   anthropic-messages  {base}/v1/messages
 *   google-gemini       {base}/v1beta/models/{model}:generateContent
 *
 * 客户端**一律**说 OpenAI Chat（/v1/chat/completions）。协议是**上游提供商**的属性，
 * 由上游提供商配置；Norm 在边界处把请求翻译过去、把响应翻译回来。
 * 这样「换一家上游提供商」只是换一张上游提供商，客户端一行都不用改。
 */
export type Protocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini';

export const PROTOCOLS: Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
];

export function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as string[]).includes(value);
}

/** 上游提供商是否对公众可用，由用户声明。私有不代表掺水，只代表不对外。 */
export type Visibility = 'public' | 'private';

export function isVisibility(value: string): value is Visibility {
  return value === 'public' || value === 'private';
}

export type ChatMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  [key: string]: unknown;
};

export type Adapter = {
  /** 协议路径（已含协议自带的版本段）。{model} 会被替换。 */
  path: (model: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  request: (body: ChatBody, model: string) => unknown;
  /** 非流式：把上游提供商 JSON 翻译回 OpenAI Chat 形状。 */
  response: (json: unknown, model: string) => unknown;
  /** 流式：把上游提供商一条 SSE 的 data 翻译成 0..n 条 chat SSE data 字符串。 */
  streamData: (data: string, model: string) => string[];
};

const enc = (text: string) => ({ role: 'assistant', content: text });
const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

function systemPrompt(messages: ChatMessage[] = []): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n');
}

function turns(messages: ChatMessage[] = []): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}

/** —— openai-chat：原样透传，不做任何翻译 —— */
const openaiChat: Adapter = {
  path: () => '/chat/completions',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  request: (body) => body,
  response: (json) => json,
  streamData: (data) => [data],
};

/** —— openai-responses：input/output 与 chat 的 message 形状不同 —— */
const openaiResponses: Adapter = {
  path: () => '/responses',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  request: (body, model) => ({
    model,
    input: (body.messages ?? []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content) })),
    stream: body.stream === true,
  }),
  response: (json, model) => {
    const payload = json as { id?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: Record<string, number> };
    const text = (payload.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
    return {
      id: payload.id ?? `resp_${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: enc(text), finish_reason: 'stop' }],
      usage: {
        prompt_tokens: payload.usage?.input_tokens ?? 0,
        completion_tokens: payload.usage?.output_tokens ?? 0,
      },
    };
  },
  streamData: (data, model) => {
    let event: { type?: string; delta?: string; delta_text?: string } = {};
    try {
      event = JSON.parse(data);
    } catch {
      return [];
    }
    const delta = event.delta ?? event.delta_text;
    if (event.type !== 'response.output_text.delta' || typeof delta !== 'string') return [];
    return [JSON.stringify({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: delta } }] })];
  },
};

/** —— anthropic-messages：content blocks、system 独立字段、x-api-key 头 —— */
const anthropicMessages: Adapter = {
  path: () => '/v1/messages',
  headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  request: (body, model) => ({
    model,
    max_tokens: (body.max_tokens as number | undefined) ?? 1024,
    system: systemPrompt(body.messages) || undefined,
    messages: turns(body.messages).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: textOf(m.content),
    })),
    stream: body.stream === true,
  }),
  response: (json, model) => {
    const payload = json as { id?: string; content?: Array<{ text?: string }>; usage?: Record<string, number> };
    const text = (payload.content ?? []).map((block) => block.text ?? '').join('');
    return {
      id: payload.id ?? `msg_${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: enc(text), finish_reason: 'stop' }],
      usage: {
        prompt_tokens: payload.usage?.input_tokens ?? 0,
        completion_tokens: payload.usage?.output_tokens ?? 0,
      },
    };
  },
  streamData: (data, model) => {
    let event: { type?: string; delta?: { type?: string; text?: string } } = {};
    try {
      event = JSON.parse(data);
    } catch {
      return [];
    }
    const text = event.type === 'content_block_delta' ? event.delta?.text : undefined;
    if (typeof text !== 'string') return [];
    return [JSON.stringify({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text } }] })];
  },
};

/** —— google-gemini：contents/parts，密钥走查询参数或 x-goog-api-key —— */
const googleGemini: Adapter = {
  path: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  headers: (key) => ({ 'x-goog-api-key': key }),
  request: (body, model) => ({
    // 流式端点由 path 决定（:streamGenerateContent?alt=sse），body 形状相同。
    contents: turns(body.messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: textOf(m.content) }],
    })),
    systemInstruction: systemPrompt(body.messages) ? { parts: [{ text: systemPrompt(body.messages) }] } : undefined,
    generationConfig: body.max_tokens ? { maxOutputTokens: body.max_tokens } : undefined,
  }),
  response: (json, model) => {
    const payload = json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: Record<string, number>;
    };
    const text = (payload.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    return {
      id: `gem_${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: enc(text), finish_reason: 'stop' }],
      usage: {
        prompt_tokens: payload.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
  streamData: (data, model) => {
    let event: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } = {};
    try {
      event = JSON.parse(data);
    } catch {
      return [];
    }
    const text = (event.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (text.length === 0) return [];
    return [JSON.stringify({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text } }] })];
  },
};

const ADAPTERS: Record<Protocol, Adapter> = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
  'google-gemini': googleGemini,
};

export function adapterFor(protocol: Protocol): Adapter {
  return ADAPTERS[protocol];
}

/**
 * 流式端点：只有 chat 与 gemini 的路径随 stream 变化，其余同端点不同 body。
 * gemini 的流式必须在路径上声明，否则它会返回一个大 JSON。
 */
export function streamPathFor(protocol: Protocol, model: string): string {
  return protocol === 'google-gemini'
    ? `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : adapterFor(protocol).path(model);
}

export function protocolUrlFor(protocol: Protocol, baseUrl: string, model: string, stream: boolean): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${stream ? streamPathFor(protocol, model) : adapterFor(protocol).path(model)}`;
}
