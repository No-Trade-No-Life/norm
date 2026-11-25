/**
 * 上游提供商：四种方言，外加一种带自己定价的厂商变体。
 *
 *   openai-chat         {base}/chat/completions
 *   openai-responses    {base}/responses
 *   anthropic-messages  {base}/v1/messages
 *   google-gemini       {base}/v1beta/models/{model}:generateContent
 *   deepseek            {base}/responses（说 Responses 方言，但价目按时段分两档）
 *
 * 客户端**一律**说 OpenAI Chat（/v1/chat/completions）。协议是**上游提供商**的属性，
 * 由上游提供商配置；Norm 在边界处把请求翻译过去、把响应翻译回来。
 * 这样「换一家上游提供商」只是换一张上游提供商，客户端一行都不用改。
 *
 * 一条协议除了「说什么方言」，还可以带「怎么计价」：DeepSeek 的官方价随请求时刻分
 * 高峰 / 低谷两档，那是这一家上游的定价模式，不属于通用价目表。所以协议值分两层——
 * `Dialect` 是线缆上的形状，`Protocol` 是方言加上可选的定价模式。
 */
import { DEEPSEEK_HOLIDAYS, DEEPSEEK_PEAK_WEEKDAYS, DEEPSEEK_PEAK_WINDOWS_UTC, DEEPSEEK_TARIFFS } from './deepseek';
import { longestMatch, type PriceAnchor, type Tariff } from './pricing';

export type Dialect =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini';

export type Protocol = Dialect | 'deepseek';

export const PROTOCOLS: Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
  'deepseek',
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

/**
 * 模型清单的规范形式。
 *
 * 与 ChatBody 同一条思路：它是一份**中间物**，不是任何一家的方言。四种方言各自
 * 用完全不同的字段说同一件事（`data[].id` / `models[].name` / `id`），这里只把
 * 「叫什么、谁给的、什么时候有的」抽出来。真正的形状由出口决定。
 */
export type ModelInfo = {
  id: string;
  created?: number;
  owned_by?: string;
};

/**
 * 一条协议自带的定价模式。`GET /api/v1/pricing` 原样回出去，让人能核对
 * 「这个时刻为什么是这个价」。
 */
export type PricingMode = {
  /** `time-tiered`：同一批型号两档价，按请求时刻选档。 */
  kind: 'time-tiered';
  /** 高峰时段（UTC，半开区间）。 */
  peak_windows_utc: string[];
  /** 高峰只落在这些星期（ISO：1 = 周一 … 7 = 周日）。 */
  peak_weekdays: number[];
  /** 这些日期整天按低谷（法定节假日，UTC 日历日）。 */
  off_peak_days: string[];
};

/** 协议自带的价目与它的选档规则。 */
export type ProtocolPricing = {
  mode: PricingMode;
  /** 整张价目：模型名前缀 → 两档价，匹配规则与通用表同一套。 */
  tariffs: Tariff[];
};

export type Adapter = {
  /**
   * 这条协议的上游说的是哪种方言。读用量、嗅流、渲染都按它，不按 `protocol` 的字面——
   * `deepseek` 说 Responses，它的请求与账单都该按 Responses 读。
   */
  dialect: Dialect;
  /** 协议路径（已含协议自带的版本段）。{model} 会被替换。 */
  path: (model: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  request: (body: ChatBody, model: string) => unknown;
  /** 非流式：把上游提供商 JSON 翻译回 OpenAI Chat 形状。 */
  response: (json: unknown, model: string) => unknown;
  /** 流式：把上游提供商一条 SSE 的 data 翻译成 0..n 条 chat SSE data 字符串。 */
  streamData: (data: string, model: string) => string[];
  /** 列模型的上游路径（已含协议自带的版本段）。 */
  modelsPath: () => string;
  /** 把上游的模型清单翻译成规范形式；形状不认识就当空清单，不猜。 */
  readModels: (json: unknown) => ModelInfo[];
  /**
   * 这条协议自带的定价（整张表）。不写 = 没有自定义定价，账本用 `pricing.ts` 的通用表。
   * 只有按时刻变价的厂商才需要它。
   */
  pricing?: ProtocolPricing;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** created 在各家是 unix 秒、毫秒或 ISO 字符串：能读就读，读不懂就不写这个字段。 */
function secondsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value > 1e11 ? value / 1000 : value);
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

/** OpenAI 一族的清单：`{object:"list", data:[{id, created, owned_by}]}`。 */
function readOpenAiModels(json: unknown): ModelInfo[] {
  return listOf(recordOf(json).data).flatMap((entry) => {
    const item = recordOf(entry);
    const id = stringOf(item.id);
    if (!id) return [];
    const created = secondsOf(item.created);
    const ownedBy = stringOf(item.owned_by);
    return [{ id, ...(created === undefined ? {} : { created }), ...(ownedBy ? { owned_by: ownedBy } : {}) }];
  });
}

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
  dialect: 'openai-chat',
  path: () => '/chat/completions',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  request: (body) => body,
  response: (json) => json,
  streamData: (data) => [data],
  modelsPath: () => '/models',
  readModels: readOpenAiModels,
};

/** —— openai-responses：input/output 与 chat 的 message 形状不同 —— */
const openaiResponses: Adapter = {
  dialect: 'openai-responses',
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
  // Responses 与 Chat 是同一台机器上的两条路，清单就是同一个 /models。
  modelsPath: () => '/models',
  readModels: readOpenAiModels,
};

/**
 * —— deepseek：说 Responses 方言，但价目按时段分两档 ——
 *
 * 除了计价一个字节都不特殊：路径、请求、响应、清单全部来自 `openaiResponses`。
 * 单独成一条协议而不是给 `openai-responses` 加个开关，是因为定价模式是这条上游契约的
 * 一部分——配置上游时就选定了「按 DeepSeek 官方时段计费」，不是逐次请求的开关。
 * 基址填 `https://api.deepseek.com`（与 DeepSeek LB 的 upstream_base 同一个）。
 */
const deepseek: Adapter = {
  ...openaiResponses,
  pricing: {
    mode: {
      kind: 'time-tiered',
      peak_windows_utc: DEEPSEEK_PEAK_WINDOWS_UTC,
      peak_weekdays: DEEPSEEK_PEAK_WEEKDAYS,
      off_peak_days: DEEPSEEK_HOLIDAYS,
    },
    tariffs: DEEPSEEK_TARIFFS,
  },
};

/** —— anthropic-messages：content blocks、system 独立字段、x-api-key 头 —— */
const anthropicMessages: Adapter = {
  dialect: 'anthropic-messages',
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
  modelsPath: () => '/v1/models',
  // Anthropic 的清单是 `{data:[{id, display_name, created_at}]}`，没有 owned_by。
  readModels: (json) =>
    listOf(recordOf(json).data).flatMap((entry) => {
      const item = recordOf(entry);
      const id = stringOf(item.id);
      if (!id) return [];
      const created = secondsOf(item.created_at);
      return [{ id, ...(created === undefined ? {} : { created }) }];
    }),
};

/** —— google-gemini：contents/parts，密钥走查询参数或 x-goog-api-key —— */
const googleGemini: Adapter = {
  dialect: 'google-gemini',
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
  modelsPath: () => '/v1beta/models',
  // Gemini 的清单是 `{models:[{name:"models/gemini-2.0-flash", ...}]}`：
  // 名字里的 `models/` 是它的命名空间前缀，剥掉它才是调用时要的模型名。
  readModels: (json) =>
    listOf(recordOf(json).models).flatMap((entry) => {
      const item = recordOf(entry);
      const name = stringOf(item.name).replace(/^models\//, '');
      if (!name) return [];
      return [{ id: name }];
    }),
};

const ADAPTERS: Record<Protocol, Adapter> = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
  'google-gemini': googleGemini,
  deepseek,
};

export function adapterFor(protocol: Protocol): Adapter {
  return ADAPTERS[protocol];
}

/** 这条协议对这个型号的官方价目；null = 这条协议没有自定义定价。 */
export function tariffFor(protocol: Protocol, model: string): Tariff | null {
  const tariffs = adapterFor(protocol).pricing?.tariffs;
  return tariffs ? longestMatch(tariffs, model) : null;
}

/**
 * 请求开始时该按哪一档计价；null = 这条协议不分时，账本用通用价目表。
 *
 * 档位按**请求开始的时刻**定一次（与 DeepSeek LB 同一口径）：一个请求跨过档位边界时
 * 按它的起点算，不按收尾算。调用方要把结果存下来、算账时复用，别在收尾时重算一遍。
 */
export function rateAt(protocol: Protocol, model: string, utcSeconds: number): PriceAnchor | null {
  const tariff = tariffFor(protocol, model);
  if (tariff === null) return null;
  const offPeak = tariff.tier?.(utcSeconds) === 'off_peak';
  return { match: tariff.match, rates: (offPeak ? tariff.off_peak : undefined) ?? tariff.peak };
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
