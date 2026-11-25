/**
 * 上游提供商：四种方言，外加两种带自己契约的厂商变体。
 *
 *   openai-chat         {base}/chat/completions
 *   openai-responses    {base}/responses
 *   anthropic-messages  {base}/v1/messages
 *   google-gemini       {base}/v1beta/models/{model}:generateContent
 *   deepseek            {base}/responses（说 Responses 方言，但价目按时段分两档）
 *   opencode-go         {base}/openai/v1/chat/completions（OpenCode Go 订阅的推理面，
 *                       基址官方钉死，且每个请求必须带 x-opencode-session）
 *
 * 方言只有四种（见 `Dialect`）；协议是「方言 + 这一家的契约」。六条协议落在四格方言上——
 * `deepseek` 说 Responses、`opencode-go` 说 Chat——所以翻译层只按方言分发，永远不按协议名。
 * 一条协议在这一层只回答三件事：路径（含版本段）、请求体怎么写、上游的流怎么读。
 *
 * 响应体不在这里翻译：非流式由 `dialects.readAnswer` 直接读四种方言，流式由
 * `streamEvents` 拆成规范事件。**翻译只有这一条路**——再来一条，迟早会分叉。
 */
import { DEEPSEEK_HOLIDAYS, DEEPSEEK_PEAK_WEEKDAYS, DEEPSEEK_PEAK_WINDOWS_UTC, DEEPSEEK_TARIFFS } from './deepseek';
import { longestMatch, type PriceAnchor, type Tariff } from './pricing';
import { SESSION_HEADER } from './sessions';

export type Dialect =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini';

export type Protocol = Dialect | 'deepseek' | 'opencode-go';

export const PROTOCOLS: Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
  'deepseek',
  'opencode-go',
];

export function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as string[]).includes(value);
}

/**
 * 规范形式里的一次工具调用。
 *
 * `arguments` 一直是**上游给的那段 JSON 原文**：需要对象的那两家（Anthropic / Gemini）
 * 自己 parse，桥不替它猜形状、也不把别人的对象重新序列化一遍。
 */
export type ChatToolCall = {
  id: string;
  name: string;
  arguments: string;
};

/** 规范形式里的一份工具声明：扁平，与 Chat 那层 `function` 包装无关。 */
export type ChatTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

/**
 * 客户端想让模型怎么用工具。
 *
 * 四家的说法：Chat 是 `auto | none | required` 加一个 `{type:'function'}`；Responses 一样但
 * 少了 `function` 那层；Anthropic 是 `auto | any | tool`；Gemini 是 `AUTO | NONE | ANY`
 * 加允许名单。归一成三种意图 + 点名一个，出口再各自说回去。
 */
export type ChatToolChoice =
  | { mode: 'auto' | 'none' | 'required' }
  | { mode: 'tool'; name: string };

export type ChatMessage = {
  role?: string;
  content?: unknown;
  /** assistant 发出的工具调用；这时 `content` 通常是空的。 */
  tool_calls?: ChatToolCall[];
  /** role === 'tool' 时，这条结果对应前面哪一次调用。 */
  tool_call_id?: string;
  [key: string]: unknown;
};

export type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  [key: string]: unknown;
};

/**
 * 流式的规范形式：一段流里只会有这三种事件。
 *
 * `index` 是**上游**给这次调用的序号（Chat 的 `tool_calls[].index`、Responses 的
 * `output_index`、Anthropic 的 content block index，Gemini 没有就按到达顺序编）。入口
 * emitter 自己把它映射成客户端要的编号。参数是增量的：`tool_start` 只带 id 与名字，
 * `tool_args` 一段一段地来——Gemini 没有增量，整段参数一次给完。
 */
export type StreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_start'; index: number; id: string; name: string }
  | { kind: 'tool_args'; index: number; args: string };

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

/**
 * 一条协议的上游契约：说哪种方言、基址从哪来、配置一条这种上游要填哪些字段。
 *
 * 「Base URL + API key」不是两个可以自由组合的输入框，而是协议的一部分：厂商协议
 * （`deepseek`）的地址是官方定死的，用户只需要给密钥；通用的四条方言协议才由用户
 * 填自己的上游地址（可能是中转）。前端「先选协议、再按协议渲染字段」读的就是这张表。
 */
export type ProtocolSchema = {
  protocol: Protocol;
  /** 线缆上的方言：`deepseek` 是 `openai-responses`。 */
  dialect: Dialect;
  /** 这条协议钉死的上游基址；null = 由用户填。 */
  base_url: string | null;
  /** 配置一条这种上游要填的字段，按表单顺序；`provider_key` 是唯一恒有的那个。 */
  fields: Array<'base_url' | 'provider_key'>;
};

export type Adapter = {
  /**
   * 这条协议的上游说的是哪种方言。读用量、嗅流、渲染都按它，不按 `protocol` 的字面——
   * `deepseek` 说 Responses，它的请求与账单都该按 Responses 读。
   */
  dialect: Dialect;
  /**
   * 这条协议钉死的上游基址。厂商协议（`deepseek`）写官方地址，用户不填也改不了；
   * 不写 = 由用户填（通用的四条方言走的就是这条）。
   */
  base_url?: string;
  /** 协议路径（已含协议自带的版本段）。{model} 会被替换。 */
  path: (model: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  /**
   * 这条协议要求上游「本次会话」的头名（OpenCode Go 的 `x-opencode-session`）。
   * 只声明要哪个头，值由 `sessions.ts` 从请求派生——协议不碰派生规则。
   */
  session_header?: string;
  /** 规范形式 → 这条方言的请求体。 */
  request: (body: ChatBody, model: string) => unknown;
  /** 流式：把上游一条 SSE 的 data 拆成规范事件；认不出的帧就是空数组。 */
  streamEvents: (data: string) => StreamEvent[];
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

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  // null / undefined 是「没有文本」（带工具调用的 assistant 就是这样），不是字符串 "null"。
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
};

function systemPrompt(messages: ChatMessage[] = []): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n');
}

function turns(messages: ChatMessage[] = []): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}

/* ── 工具调用：规范形式 ↔ 四家线缆形状，唯一的换算处 ────────────────
 *
 * 规范形式是**扁平**的：工具是 `{name, description, parameters}`，调用是
 * `{id, name, arguments}`，结果是一条 `role='tool'` 的消息。四家只有 OpenAI Chat 把函数
 * 套在 `function` 里、把结果单列成 `role='tool'`；其余三家的差异全部收在下面。
 */

/** 参数的 JSON 原文读成对象。读不懂就给空对象——对象是那两家唯一接受的形状。 */
export function toolArguments(call: ChatToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 参数 Schema 的缺省：Anthropic 与 Gemini 都要求这个字段在，空对象是最保守的那个。 */
function parametersOf(tool: ChatTool): unknown {
  return tool.parameters ?? { type: 'object', properties: {} };
}

/** Gemini 的 `functionResponse.response` 必须是对象：结果本来就是 JSON 就原样给，否则包一层。 */
function responseOf(content: unknown): Record<string, unknown> {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 不是 JSON：下面包一层。
  }
  return { result: raw };
}

/** 同角色相邻轮合并成一轮：Anthropic 要求 user / assistant 交替，Gemini 也不接受并排两条。 */
type Turn<T> = { role: string; blocks: T[] };
function pushBlocks<T>(turns: Turn<T>[], role: string, blocks: T[]): void {
  if (blocks.length === 0) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.blocks.push(...blocks);
  else turns.push({ role, blocks: [...blocks] });
}

/* ── openai-chat：函数套在 `function` 里，工具结果单列一条消息 ─────── */

function chatWireTool(tool: ChatTool): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: parametersOf(tool),
    },
  };
}

function chatWireChoice(choice: ChatToolChoice): unknown {
  return choice.mode === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.mode;
}

function chatWireMessage(message: ChatMessage): unknown {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.tool_call_id ?? '', content: textOf(message.content) };
  }
  const calls = message.tool_calls ?? [];
  if (message.role === 'assistant' && calls.length > 0) {
    return {
      role: 'assistant',
      content: textOf(message.content),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role ?? 'user', content: textOf(message.content) };
}

/** —— openai-chat：说 Chat 方言，也把规范形式说成 Chat 的线缆形状 —— */
const openaiChat: Adapter = {
  dialect: 'openai-chat',
  path: () => '/chat/completions',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  request: (body, model) => ({
    model,
    messages: (body.messages ?? []).map(chatWireMessage),
    stream: body.stream === true,
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.tools?.length ? { tools: body.tools.map(chatWireTool) } : {}),
    // 没带工具却带 tool_choice 是自相矛盾的：上游会当作 400，这里就不发。
    ...(body.tools?.length && body.tool_choice ? { tool_choice: chatWireChoice(body.tool_choice) } : {}),
  }),
  streamEvents: chatStreamEvents,
  modelsPath: () => '/models',
  readModels: readOpenAiModels,
};

/* ── openai-responses：工具调用与结果是两类独立条目，工具声明是扁平的 ── */

/** 一条 chat 消息摊成 Responses 的条目：assistant 的文本与每个调用各占一条。 */
function responseItems(message: ChatMessage): unknown[] {
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: textOf(message.content) }];
  }
  if (message.role !== 'assistant') return [{ role: 'user', content: textOf(message.content) }];
  const items: unknown[] = [];
  const text = textOf(message.content);
  if (text.length > 0) items.push({ role: 'assistant', content: text });
  for (const call of message.tool_calls ?? []) {
    items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
  }
  return items;
}

function responseChoice(choice: ChatToolChoice): unknown {
  return choice.mode === 'tool' ? { type: 'function', name: choice.name } : choice.mode;
}

/** —— openai-responses：input/output 与 chat 的 message 形状不同 —— */
const openaiResponses: Adapter = {
  dialect: 'openai-responses',
  path: () => '/responses',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  request: (body, model) => {
    const system = systemPrompt(body.messages);
    return {
      model,
      ...(system ? { instructions: system } : {}),
      input: turns(body.messages).flatMap(responseItems),
      stream: body.stream === true,
      ...(body.max_tokens === undefined ? {} : { max_output_tokens: body.max_tokens }),
      ...(body.tools?.length
        ? {
            tools: body.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: parametersOf(tool),
            })),
          }
        : {}),
      ...(body.tools?.length && body.tool_choice ? { tool_choice: responseChoice(body.tool_choice) } : {}),
    };
  },
  streamEvents: responsesStreamEvents,
  // Responses 与 Chat 是同一台机器上的两条路，清单就是同一个 /models。
  modelsPath: () => '/models',
  readModels: readOpenAiModels,
};

/**
 * —— deepseek：说 Responses 方言，但价目按时段分两档 ——
 *
 * 除了计价一个字节都不特殊：路径、请求、流、清单全部来自 `openaiResponses`——包括工具的
 * 形状，因为 DeepSeek 的 Responses 接口收的就是 Responses 的那一套。
 * 单独成一条协议而不是给 `openai-responses` 加个开关，是因为定价模式是这条上游契约的
 * 一部分——配置上游时就选定了「按 DeepSeek 官方时段计费」，不是逐次请求的开关。
 * 基址填 `https://api.deepseek.com`（与 DeepSeek LB 的 upstream_base 同一个）。
 */
const deepseek: Adapter = {
  ...openaiResponses,
  // DeepSeek 官方 API 的基址：选了这条协议就是选了这一台主机，没有第二个问题要问。
  base_url: 'https://api.deepseek.com',
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

/**
 * —— opencode-go：说 OpenAI Chat，上游是 OpenCode Go 订阅的推理面 ——
 *
 * 三条硬性要求都钉在协议里，用户只需要给一把 `oc_sk_…`：
 *   1. 基址是官方推理面 `https://opencode.ai/inference/go`（不是 console，也不是 zen）；
 *   2. 路径自带版本段：`/openai/v1/chat/completions`（清单同在 `/openai/v1/models`）；
 *   3. 每个请求必须带 `x-opencode-session: ses_<64 hex>`，缺了上游直接
 *      `400 MissingSessionID`——它靠这个值把一段对话路由到同一个槽位、复用提示词缓存。
 *
 * 会话 id 不是身份、不进账本、也不透传调用方的原值：派生规则在 `src/sessions.ts`。
 */
const opencodeGo: Adapter = {
  ...openaiChat,
  base_url: 'https://opencode.ai/inference/go',
  path: () => '/openai/v1/chat/completions',
  modelsPath: () => '/openai/v1/models',
  session_header: SESSION_HEADER,
};

/* ── anthropic-messages：content blocks、system 独立字段、x-api-key 头 ── */

function anthropicChoice(choice: ChatToolChoice): unknown {
  if (choice.mode === 'tool') return { type: 'tool', name: choice.name };
  // Anthropic 把「必须调一个」叫 any，Chat 叫 required。
  return { type: choice.mode === 'required' ? 'any' : choice.mode };
}

const anthropicMessages: Adapter = {
  dialect: 'anthropic-messages',
  path: () => '/v1/messages',
  headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  request: (body, model) => {
    const turnsOut: Turn<unknown>[] = [];
    for (const message of turns(body.messages)) {
      if (message.role === 'tool') {
        // 工具结果是一条 user 轮里的 tool_result 块；连着几条结果会被 pushBlocks 并进同一轮。
        pushBlocks(turnsOut, 'user', [
          { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: textOf(message.content) },
        ]);
        continue;
      }
      if (message.role === 'assistant') {
        const blocks: unknown[] = [];
        const text = textOf(message.content);
        if (text.length > 0) blocks.push({ type: 'text', text });
        for (const call of message.tool_calls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: toolArguments(call) });
        }
        // 空字符串的文本块是合法的，空 content 数组不是。
        pushBlocks(turnsOut, 'assistant', blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]);
        continue;
      }
      pushBlocks(turnsOut, 'user', [{ type: 'text', text: textOf(message.content) }]);
    }
    return {
      model,
      max_tokens: (body.max_tokens as number | undefined) ?? 1024,
      system: systemPrompt(body.messages) || undefined,
      messages: turnsOut.map((turn) => ({ role: turn.role, content: turn.blocks })),
      stream: body.stream === true,
      ...(body.tools?.length
        ? {
            tools: body.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              input_schema: parametersOf(tool),
            })),
          }
        : {}),
      ...(body.tools?.length && body.tool_choice ? { tool_choice: anthropicChoice(body.tool_choice) } : {}),
    };
  },
  streamEvents: anthropicStreamEvents,
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

/* ── google-gemini：contents/parts，工具靠**函数名**对齐（它没有调用 id） ── */

function geminiChoice(choice: ChatToolChoice): unknown {
  if (choice.mode === 'tool') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  if (choice.mode === 'required') return { mode: 'ANY' };
  return { mode: choice.mode === 'none' ? 'NONE' : 'AUTO' };
}

const googleGemini: Adapter = {
  dialect: 'google-gemini',
  path: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  headers: (key) => ({ 'x-goog-api-key': key }),
  request: (body, model) => {
    const turnsOut: Turn<unknown>[] = [];
    // 结果在 Gemini 里只说得出函数名：把 id → name 从前面 assistant 的调用里抄下来，
    // 遇到 role='tool' 时按 id 找回名字。少了这张表，工具结果就会被挂到不存在的函数上。
    const names = new Map<string, string>();
    for (const message of turns(body.messages)) {
      if (message.role === 'tool') {
        pushBlocks(turnsOut, 'user', [
          {
            functionResponse: {
              name: names.get(message.tool_call_id ?? '') ?? 'tool',
              response: responseOf(message.content),
            },
          },
        ]);
        continue;
      }
      if (message.role === 'assistant') {
        const parts: unknown[] = [];
        const text = textOf(message.content);
        if (text.length > 0) parts.push({ text });
        for (const call of message.tool_calls ?? []) {
          names.set(call.id, call.name);
          parts.push({ functionCall: { name: call.name, args: toolArguments(call) } });
        }
        pushBlocks(turnsOut, 'model', parts);
        continue;
      }
      pushBlocks(turnsOut, 'user', [{ text: textOf(message.content) }]);
    }
    const system = systemPrompt(body.messages);
    const tools = body.tools ?? [];
    return {
      // 流式端点由 path 决定（:streamGenerateContent?alt=sse），body 形状相同。
      contents: turnsOut.map((turn) => ({ role: turn.role, parts: turn.blocks })),
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: body.max_tokens ? { maxOutputTokens: body.max_tokens } : undefined,
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description ? { description: tool.description } : {}),
                  parameters: parametersOf(tool),
                })),
              },
            ],
          }
        : {}),
      ...(tools.length && body.tool_choice
        ? { toolConfig: { functionCallingConfig: geminiChoice(body.tool_choice) } }
        : {}),
    };
  },
  streamEvents: geminiStreamEvents,
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

/* ── 流式：上游帧 → 规范事件 ─────────────────────────────────────── */

/** 一帧 SSE 的 data；`[DONE]`、空的、不是 JSON 的都当没有。 */
function frameOf(data: string): Record<string, unknown> | null {
  if (data.length === 0 || data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** OpenAI Chat 形状的流（`opencode-go` 与 `openai-chat` 共用同一份读法）。 */
function chatStreamEvents(data: string): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const events: StreamEvent[] = [];
  for (const choice of listOf(frame.choices)) {
    const delta = recordOf(recordOf(choice).delta);
    const text = stringOf(delta.content);
    if (text.length > 0) events.push({ kind: 'text', text });
    for (const entry of listOf(delta.tool_calls)) {
      const call = recordOf(entry);
      const index = typeof call.index === 'number' ? call.index : 0;
      const fn = recordOf(call.function);
      const id = stringOf(call.id);
      const name = stringOf(fn.name);
      // 第一帧给 id 与名字，之后只剩参数片段：缺哪个就不写哪个，下游按 index 合并。
      if (id.length > 0 || name.length > 0) {
        events.push({ kind: 'tool_start', index, id: id || `call_${index}`, name });
      }
      const args = stringOf(fn.arguments);
      if (args.length > 0) events.push({ kind: 'tool_args', index, args });
    }
  }
  return events;
}

/** Responses：工具调用是一条独立的 output item，参数走自己的增量事件。 */
function responsesStreamEvents(data: string): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const type = stringOf(frame.type);
  const index = typeof frame.output_index === 'number' ? frame.output_index : 0;
  if (type === 'response.output_item.added') {
    const item = recordOf(frame.item);
    if (stringOf(item.type) !== 'function_call') return [];
    return [{ kind: 'tool_start', index, id: stringOf(item.call_id) || stringOf(item.id), name: stringOf(item.name) }];
  }
  if (type === 'response.function_call_arguments.delta') {
    const args = stringOf(frame.delta);
    return args.length > 0 ? [{ kind: 'tool_args', index, args }] : [];
  }
  if (type === 'response.output_text.delta') {
    // 有的中转把文本放在 `delta_text` 里（旧的字段名），两种都认。
    const text = stringOf(frame.delta) || stringOf(frame.delta_text);
    return text.length > 0 ? [{ kind: 'text', text }] : [];
  }
  return [];
}

/** Anthropic：tool_use 块开始给 id 与名字，参数是 `input_json_delta` 的片段。 */
function anthropicStreamEvents(data: string): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const type = stringOf(frame.type);
  const index = typeof frame.index === 'number' ? frame.index : 0;
  if (type === 'content_block_start') {
    const block = recordOf(frame.content_block);
    if (stringOf(block.type) !== 'tool_use') return [];
    return [{ kind: 'tool_start', index, id: stringOf(block.id), name: stringOf(block.name) }];
  }
  if (type === 'content_block_delta') {
    const delta = recordOf(frame.delta);
    if (stringOf(delta.type) === 'input_json_delta') {
      const args = stringOf(delta.partial_json);
      return args.length > 0 ? [{ kind: 'tool_args', index, args }] : [];
    }
    const text = stringOf(delta.text);
    return text.length > 0 ? [{ kind: 'text', text }] : [];
  }
  return [];
}

/** Gemini：没有增量，一次 functionCall 就把名字与整段参数都给全了。 */
function geminiStreamEvents(data: string): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const events: StreamEvent[] = [];
  for (const candidate of listOf(frame.candidates)) {
    for (const part of listOf(recordOf(recordOf(candidate).content).parts)) {
      const piece = recordOf(part);
      const text = stringOf(piece.text);
      if (text.length > 0) events.push({ kind: 'text', text });
      if (piece.functionCall) {
        const call = recordOf(piece.functionCall);
        // Gemini 不给调用 id，也没有分片：按到达顺序编号，参数一次给完。
        const index = events.filter((event) => event.kind === 'tool_start').length;
        events.push({ kind: 'tool_start', index, id: `call_${index + 1}`, name: stringOf(call.name) });
        events.push({ kind: 'tool_args', index, args: JSON.stringify(call.args ?? {}) });
      }
    }
  }
  return events;
}

const ADAPTERS: Record<Protocol, Adapter> = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
  'google-gemini': googleGemini,
  deepseek,
  'opencode-go': opencodeGo,
};

export function adapterFor(protocol: Protocol): Adapter {
  return ADAPTERS[protocol];
}

/** 一条协议的上游契约（`GET /api/v1/protocols` 的一条）。 */
export function schemaOf(protocol: Protocol): ProtocolSchema {
  const adapter = adapterFor(protocol);
  const fixed = adapter.base_url ?? null;
  return {
    protocol,
    dialect: adapter.dialect,
    base_url: fixed,
    fields: fixed === null ? ['base_url', 'provider_key'] : ['provider_key'],
  };
}

/** 全部协议的契约，一次算好：这是「先选协议、再渲染字段」的唯一一份数据。 */
export const PROTOCOL_SCHEMAS: ProtocolSchema[] = PROTOCOLS.map(schemaOf);

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
