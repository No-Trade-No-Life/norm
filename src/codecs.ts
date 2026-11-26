/**
 * 线缆方言层（Wire Dialect Codecs）：全系统只有四份，管「规范中间态 ↔ 上游线缆格式」。
 *
 *   openai-chat         {base}/chat/completions
 *   openai-responses    {base}/responses
 *   anthropic-messages  {base}/v1/messages
 *   google-gemini       {base}/v1beta/models/{model}:generateContent
 *
 * 翻译层只认方言（`Dialect`），永远不知道具体厂商协议（`deepseek` / `opencode-go` 等）：
 *   - 入口侧在 `src/dialects.ts`：4 种入口方言 ↔ 规范中间态（`ChatBody` / `AnswerCore` / `StreamEvent`）；
 *   - 出口侧在本文件：规范中间态 ↔ 4 种上游方言（请求编码、流式拆帧、模型清单解码）；
 *   - 上游厂商契约在 `src/protocols.ts`：声明复用哪一种 `dialect` 并叠加基址 / 路径 / 头 / 计价。
 *
 * 因此复杂度是 M + N（两层各自线性），而不是 M × N 矩阵：
 *   - 新增一个厂商协议（如 OpenRouter / Groq / 火山方舟）：只需在 `protocols.ts` 复用已有方言，翻译代码增量 = 0；
 *   - 即使未来新增第 5 种全新线缆方言，也只需补 1 份「方言 ↔ 规范中间态」编解码，不需要为每条入口各写一套。
 */

export const DIALECTS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
] as const;

export type Dialect = (typeof DIALECTS)[number];

export function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
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
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  /**
   * 客户端想让模型想多久（`none` / `low` / `medium` / `high` / `xhigh` / `max`）。
   *
   * 只有 Chat 与 Responses 两家用「档位」说同一件事（`reasoning_effort` 与 `reasoning.effort`），
   * 所以规范形式里也只留档位：Anthropic 与 Gemini 用**预算 token 数**表达，数字换档位是猜，
   * 猜出来的档位会让上游真的多花或省掉一笔钱，所以那两家不进这个字段（见 `parseInbound`）。
   */
  reasoning_effort?: string;
  stop?: string[];
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
  /**
   * 模型想出来的东西（DeepSeek 的 `reasoning_content`、Anthropic 的 thinking 块、
   * Responses 的 reasoning summary、Gemini 的 `thought` part）。
   *
   * 它**不是回答**：`carriesOutput` 不认它（首字延迟按真正开口算，见 dialects.ts），
   * 但它也不是噪声——推理档位开着的时候，客户端要的就是这段。所以它单独成一种事件，
   * 由出口决定说成哪一家的思考帧；出口那家说不出来就丢掉，绝不混进 `text`。
   */
  | { kind: 'reasoning'; text: string }
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
  /** 上游自述的输入 / 输出模态。没说的就是 `undefined`——不猜，见 `Modalities`。 */
  modalities?: Modalities;
};

/**
 * 一条模型**自己声明**的输入 / 输出模态。
 *
 * 这不是 Norm 的判断，是上游清单里的原话：只有 OpenRouter 那一系（以及照抄它清单形状的
 * 聚合型上游）会多带一段 `architecture: { input_modalities, output_modalities }`。
 * OpenAI、Anthropic、Google 的官方清单里根本没有这个字段——**缺是常态，不是解析失败**。
 * 所以 `undefined` 的意思是「这条上游没说」，而不是「只能文本」。
 */
export type Modalities = {
  input: string[];
  output: string[];
};

/**
 * 一种线缆方言的出站编解码器（全系统恒为 4 份，一一对应 `DIALECTS`）。
 *
 * 非流式响应体不在这里解码：由 `src/dialects.ts` 的 `readAnswer` 直接读四种方言，
 * 避免同一份方言出现两套响应解析逻辑。
 */
export type DialectCodec = {
  dialect: Dialect;
  /** 默认非流式推理路径（含协议自带的版本段）；厂商协议可按需覆写。 */
  defaultPath: (model: string) => string;
  /** 默认流式推理路径：多数方言与非流式同端点，Gemini 必须走 `:streamGenerateContent?alt=sse`。 */
  streamPath: (model: string) => string;
  /** 默认鉴权头；厂商协议可按需覆写。 */
  defaultHeaders: (apiKey: string) => Record<string, string>;
  /** 默认列模型路径；厂商协议可按需覆写。 */
  defaultModelsPath: () => string;
  /** 规范形式（ChatBody）→ 这一方言的上游请求体。 */
  encodeRequest: (body: ChatBody, model: string) => unknown;
  /** 流式：把上游一条 SSE 的 data 拆成规范事件；认不出的帧返回空数组。`toolOffset` 给无序号上游（Gemini）分配不冲突的调用序号。 */
  decodeStreamEvents: (data: string, toolOffset?: number) => StreamEvent[];
  /** 把上游的模型清单翻译成规范形式；形状不认识就当空清单，不猜。 */
  decodeModels: (json: unknown) => ModelInfo[];
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 一份清单里认得的模态词形：认不出的词不往表里放，宁可少说一句。 */
const MODALITY_TOKEN = /^[a-z0-9][a-z0-9_.-]{0,15}$/;

/** 一段模态声明归一成小写词表：去重、保序、丢掉认不出的词。 */
function modalityList(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of listOf(value)) {
    const token = stringOf(raw).trim().toLowerCase();
    if (token.length === 0 || !MODALITY_TOKEN.test(token) || out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * 上游自述的模态，认三种写法（都是 OpenRouter 那一系的形状与它的抄法）：
 *
 *   architecture: { input_modalities: ['text','image'], output_modalities: ['text'] }
 *   architecture: { modality: 'text+image->text' }           ← 老字段，一个字符串
 *   { input_modalities: [...], output_modalities: [...] }     ← 摊平在顶层的抄法
 *
 * 两边都没认出来就是 `undefined`；只声明了一半的照实只写一半（另一侧是空数组）。补一个
 * 猜出来的另一半，就把「没说」写成了「说了」——这比留空更糟。
 */
function readModalities(item: Record<string, unknown>): Modalities | undefined {
  const architecture = recordOf(item.architecture);
  let input = modalityList(architecture.input_modalities ?? item.input_modalities);
  let output = modalityList(architecture.output_modalities ?? item.output_modalities);

  if (input.length === 0 && output.length === 0) {
    const [left, right] = stringOf(architecture.modality ?? item.modality).split('->');
    input = modalityList(left?.split('+'));
    output = modalityList(right?.split('+'));
  }

  return input.length === 0 && output.length === 0 ? undefined : { input, output };
}

/** 一条模型带上它自述的模态；没有就一个字都不多写，出口那边也就不必判空。 */
function withModalities(item: Record<string, unknown>, info: ModelInfo): ModelInfo {
  const modalities = readModalities(item);
  return modalities === undefined ? info : { ...info, modalities };
}

/** created 在各家是 unix 秒、毫秒或 ISO 字符串：能读就读，读不懂就不写这个字段。 */
function secondsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value > 1e11 ? value / 1000 : value);
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

/** OpenAI 一族的清单：`{object:"list", data:[{id, created, owned_by}]}`，模态是可选的扩展。 */
function readOpenAiModels(json: unknown): ModelInfo[] {
  return listOf(recordOf(json).data).flatMap((entry) => {
    const item = recordOf(entry);
    const id = stringOf(item.id);
    if (!id) return [];
    const created = secondsOf(item.created);
    const ownedBy = stringOf(item.owned_by);
    return [
      withModalities(item, {
        id,
        ...(created === undefined ? {} : { created }),
        ...(ownedBy ? { owned_by: ownedBy } : {}),
      }),
    ];
  });
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  // null / undefined 是「没有文本」（带工具调用的 assistant 就是这样），不是字符串 "null"。
  if (content === undefined || content === null) return '';
  // OpenAI 现代客户端常发文本块数组 `[{ type: "text", text: "..." }]`，不能直接 JSON.stringify。
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter((value) => value.length > 0)
      .join('\n');
  }
  return JSON.stringify(content);
};

const isSystemRole = (role?: string): boolean => role === 'system' || role === 'developer';

function systemPrompt(messages: ChatMessage[] = []): string {
  return messages
    .filter((m) => isSystemRole(m.role))
    .map((m) => textOf(m.content))
    .filter((value) => value.length > 0)
    .join('\n\n');
}

function turns(messages: ChatMessage[] = []): ChatMessage[] {
  return messages.filter((m) => !isSystemRole(m.role));
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

/**
 * Gemini `functionDeclarations.parameters` 不接受标准 JSON Schema 的元关键字
 * （遇到 `$schema` / `additionalProperties` / `default` 等直接 400）。
 * 递归清洗出 Gemini 接受的子集，同时把 `type: ['string', 'null']` 翻成 `nullable: true`。
 */
const GEMINI_FORBIDDEN_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'definitions',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'default',
  'examples',
  'title',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
]);

export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (GEMINI_FORBIDDEN_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.filter((item) => item !== 'null');
      if (nonNull.length > 0) out.type = nonNull[0];
      if (value.includes('null')) out.nullable = true;
      continue;
    }
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
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
function pushBlocks<T>(turnsList: Turn<T>[], role: string, blocks: T[]): void {
  if (blocks.length === 0) return;
  const last = turnsList[turnsList.length - 1];
  if (last && last.role === role) last.blocks.push(...blocks);
  else turnsList.push({ role, blocks: [...blocks] });
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

const openaiChatCodec: DialectCodec = {
  dialect: 'openai-chat',
  defaultPath: () => '/chat/completions',
  streamPath: () => '/chat/completions',
  defaultHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
  defaultModelsPath: () => '/models',
  encodeRequest: (body, model) => ({
    model,
    messages: (body.messages ?? []).map(chatWireMessage),
    stream: body.stream === true,
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    // 推理档位是 Chat 自己的字段名，同方言直通时本来就在（这条只走跨方言桥）。
    ...(body.reasoning_effort === undefined ? {} : { reasoning_effort: body.reasoning_effort }),
    ...(body.stop?.length ? { stop: body.stop } : {}),
    ...(body.tools?.length ? { tools: body.tools.map(chatWireTool) } : {}),
    // 没带工具却带 tool_choice 是自相矛盾的：上游会当作 400，这里就不发。
    ...(body.tools?.length && body.tool_choice ? { tool_choice: chatWireChoice(body.tool_choice) } : {}),
  }),
  decodeStreamEvents: chatStreamEvents,
  decodeModels: readOpenAiModels,
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

const openaiResponsesCodec: DialectCodec = {
  dialect: 'openai-responses',
  defaultPath: () => '/responses',
  streamPath: () => '/responses',
  defaultHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
  // Responses 与 Chat 是同一台机器上的两条路，清单就是同一个 /models。
  defaultModelsPath: () => '/models',
  encodeRequest: (body, model) => {
    const system = systemPrompt(body.messages);
    return {
      model,
      ...(system ? { instructions: system } : {}),
      input: turns(body.messages).flatMap(responseItems),
      stream: body.stream === true,
      ...(body.max_tokens === undefined ? {} : { max_output_tokens: body.max_tokens }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
      ...(body.reasoning_effort === undefined ? {} : { reasoning: { effort: body.reasoning_effort } }),
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
  decodeStreamEvents: responsesStreamEvents,
  decodeModels: readOpenAiModels,
};

/* ── anthropic-messages：content blocks、system 独立字段、x-api-key 头 ── */

function anthropicChoice(choice: ChatToolChoice): unknown {
  if (choice.mode === 'tool') return { type: 'tool', name: choice.name };
  // Anthropic 把「必须调一个」叫 any，Chat 叫 required。
  return { type: choice.mode === 'required' ? 'any' : choice.mode };
}

const anthropicMessagesCodec: DialectCodec = {
  dialect: 'anthropic-messages',
  defaultPath: () => '/v1/messages',
  streamPath: () => '/v1/messages',
  defaultHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  defaultModelsPath: () => '/v1/models',
  encodeRequest: (body, model) => {
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
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
      ...(body.stop?.length ? { stop_sequences: body.stop } : {}),
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
  decodeStreamEvents: anthropicStreamEvents,
  // Anthropic 的清单是 `{data:[{id, display_name, created_at}]}`，没有 owned_by。
  decodeModels: (json) =>
    listOf(recordOf(json).data).flatMap((entry) => {
      const item = recordOf(entry);
      const id = stringOf(item.id);
      if (!id) return [];
      const created = secondsOf(item.created_at);
      return [withModalities(item, { id, ...(created === undefined ? {} : { created }) })];
    }),
};

/* ── google-gemini：contents/parts，工具靠**函数名**对齐（它没有调用 id） ── */

function geminiChoice(choice: ChatToolChoice): unknown {
  if (choice.mode === 'tool') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  if (choice.mode === 'required') return { mode: 'ANY' };
  return { mode: choice.mode === 'none' ? 'NONE' : 'AUTO' };
}

const googleGeminiCodec: DialectCodec = {
  dialect: 'google-gemini',
  defaultPath: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  // Gemini 的流式必须在路径上声明，否则上游会返回一个大 JSON。
  streamPath: (model) => `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
  defaultHeaders: (key) => ({ 'x-goog-api-key': key }),
  defaultModelsPath: () => '/v1beta/models',
  encodeRequest: (body, _model) => {
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
    const generationConfig: Record<string, unknown> = {
      ...(body.max_tokens === undefined ? {} : { maxOutputTokens: body.max_tokens }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { topP: body.top_p }),
      ...(body.stop?.length ? { stopSequences: body.stop } : {}),
    };
    return {
      // 流式端点由 path 决定（:streamGenerateContent?alt=sse），body 形状相同。
      contents: turnsOut.map((turn) => ({ role: turn.role, parts: turn.blocks })),
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description ? { description: tool.description } : {}),
                  parameters: sanitizeGeminiSchema(parametersOf(tool)),
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
  decodeStreamEvents: geminiStreamEvents,
  // Gemini 的清单是 `{models:[{name:"models/gemini-2.0-flash", ...}]}`：
  // 名字里的 `models/` 是它的命名空间前缀，剥掉它才是调用时要的模型名。
  decodeModels: (json) =>
    listOf(recordOf(json).models).flatMap((entry) => {
      const item = recordOf(entry);
      const name = stringOf(item.name).replace(/^models\//, '');
      if (!name) return [];
      return [withModalities(item, { id: name })];
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

/** OpenAI Chat 形状的流（所有复用 `openai-chat` 方言的上游共用这一份读法）。 */
function chatStreamEvents(data: string): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const events: StreamEvent[] = [];
  for (const choice of listOf(frame.choices)) {
    const delta = recordOf(recordOf(choice).delta);
    // 推理模型的思考先到：DeepSeek 叫 `reasoning_content`，走中转的常常叫 `reasoning`。
    const reasoning = stringOf(delta.reasoning_content) || stringOf(delta.reasoning);
    if (reasoning.length > 0) events.push({ kind: 'reasoning', text: reasoning });
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
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    const text = stringOf(frame.delta);
    return text.length > 0 ? [{ kind: 'reasoning', text }] : [];
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
    if (stringOf(delta.type) === 'thinking_delta') {
      const thinking = stringOf(delta.thinking);
      return thinking.length > 0 ? [{ kind: 'reasoning', text: thinking }] : [];
    }
    const text = stringOf(delta.text);
    return text.length > 0 ? [{ kind: 'text', text }] : [];
  }
  return [];
}

/** Gemini：没有增量，一次 functionCall 就把名字与整段参数都给全了。 */
function geminiStreamEvents(data: string, toolOffset = 0): StreamEvent[] {
  const frame = frameOf(data);
  if (!frame) return [];
  const events: StreamEvent[] = [];
  for (const candidate of listOf(frame.candidates)) {
    for (const part of listOf(recordOf(recordOf(candidate).content).parts)) {
      const piece = recordOf(part);
      const text = stringOf(piece.text);
      // Gemini 的思考 part 是同一段文字加 `thought: true`：认得它，才不会被当成回答。
      if (text.length > 0) events.push({ kind: piece.thought === true ? 'reasoning' : 'text', text });
      if (piece.functionCall) {
        const call = recordOf(piece.functionCall);
        // Gemini 不给调用 id，也没有分片：用跨帧递增的 toolOffset 编号，防止多帧并行调用互相覆盖。
        const index = toolOffset + events.filter((event) => event.kind === 'tool_start').length;
        events.push({ kind: 'tool_start', index, id: `call_${index + 1}`, name: stringOf(call.name) });
        events.push({ kind: 'tool_args', index, args: JSON.stringify(call.args ?? {}) });
      }
    }
  }
  return events;
}

const DIALECT_CODECS: Record<Dialect, DialectCodec> = {
  'openai-chat': openaiChatCodec,
  'openai-responses': openaiResponsesCodec,
  'anthropic-messages': anthropicMessagesCodec,
  'google-gemini': googleGeminiCodec,
};

/** 按线缆方言取唯一的出站编解码器。翻译永远只按方言分发，绝不按厂商协议名分发。 */
export function dialectCodecFor(dialect: Dialect): DialectCodec {
  return DIALECT_CODECS[dialect];
}
