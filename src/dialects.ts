/**
 * 四条线缆方言，入站与出站共用同一套方言名。
 *
 * 转发只比较线缆方言（`entry.dialect === profile.dialect`）：
 *   - 同方言直通：请求体原样发出去，响应体原样还回来，一个字段都不碰；
 *   - 跨方言桥接：入口 → 规范中间态（`ChatBody`）→ 上游方言编解码（`src/codecs.ts`）→ 回来时再渲染成入口方言。
 *
 * 桥只在规范中间态居中出现，因此翻译是 M + N（入口 4 段 + 出站 4 段，互不相干），不是 M × N 矩阵。
 * 厂商协议（`deepseek` / `opencode-go` 等）只在 `src/protocols.ts` 声明复用哪一种方言并叠加基址/头/计价，
 * 本文件与 `src/codecs.ts` 永远不感知具体厂商协议名。
 *
 * 工具调用同样过桥：四家的 `tools` / `tool_choice` / `tool_calls` / 工具结果的形状各不相同，
 * 规范形式只留扁平的「工具声明」「一次调用」「一条结果」三样（见 `src/codecs.ts` 的
 * `ChatTool` / `ChatToolCall`）。入口读进来、出口说回去，带工具的请求因此可以落在任何一条
 * 方言的上游上。同方言直通时仍然一个字节都不碰——那条路上的 `tools` 是客户端自己的事。
 */
import { fail } from './http';
import { toolArguments, type ChatBody, type ChatMessage, type ChatTool, type ChatToolCall, type ChatToolChoice, type Dialect, type StreamEvent } from './codecs';
import type { Usage } from './pricing';

export type { Dialect };

/**
 * 从任意一种方言的响应里读出的、记账与渲染都需要的那点东西。
 *
 * `usage` 只有三项，因为账本只认这三种 token：
 *   input   输入 token 总量（**含**缓存命中的那部分）
 *   cached  其中命中上游提供商缓存的
 *   output  输出 token
 * 四家的口径各不相同（Anthropic 的 `input_tokens` 不含缓存读，OpenAI 的
 * `prompt_tokens` 含），归一化只发生在下面四个 extract 里，别处不再判断方言。
 *
 * `toolCalls` 是这次回答里发起的工具调用（可能为空）：它与文本一样是「回答」，所以
 * 记账的那一份与渲染给客户端的那一份都从这里读，不各读一遍。
 */
export type AnswerCore = {
  text: string;
  /**
   * 模型想过的东西，与 `text` 分开：它是思考，不是回答。
   *
   * 四家都说得出这件事（`reasoning_content` / reasoning summary / thinking 块 / `thought` part），
   * 空串就是「这次上游没给思考」——不猜、不补。
   */
  reasoning: string;
  toolCalls: ChatToolCall[];
  model: string;
  usage: Usage;
  createdAt: number;
};

/** 一次调用的账单结论：Gas（付给 Norm）与 Token（转给上游提供方）分开记，外加三项 token。 */
export type NormMeta = {
  request_id: string;
  /** 真正从余额里扣掉的总额 = gas_billed_nanos + token_billed_nanos = gas_fee_nanos + token_nanos − unbilled_nanos。 */
  fee_nanos: number;
  /** 本次应付 Gas 费（付给 Norm）。 */
  gas_fee_nanos: number;
  /** 本次实际扣到的 Gas 费（付给 Norm）。 */
  gas_billed_nanos: number;
  /** 本次应付 Token 费（转给上游提供方；调用自有上游或失败时为 0）。 */
  token_nanos: number;
  /** 本次实际转给上游提供方的 Token 费（调用自有上游或失败时为 0）。 */
  token_billed_nanos: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  /** 音频用量：转写覆盖的毫秒数与合成的字符数；文本调用为 0。 */
  audio_ms: number;
  audio_characters: number;
  /** 余额不足时没能收上来的部分；正常为 0。 */
  unbilled_nanos: number;
  balance_nanos: number | null;
  latency_ms: number;
  host: string;
  /** true = 这一单落到了公共池（他人上游），Token 费转给上游提供方；false = 自有上游，仅收 Gas。 */
  pool: boolean;
};

/** 四家方言里表示「用量」的那几个字段名，集中在这里，别处不出现。 */
export type RawUsage = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): RawUsage => (value !== null && typeof value === 'object' ? (value as RawUsage) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

type Raw = Record<string, unknown>;

/** 一个请求只回答一个问题：这段内容是什么。四种方言的块名不同，形状一样。 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const value = (part as { text?: unknown } | null)?.text;
      return typeof value === 'string' ? value : '';
    })
    .filter((value) => value.length > 0)
    .join('\n');
}

function textField(body: Raw, field: string): string {
  return flatten(body[field]);
}

/** 工具的 arguments：上游给的是 JSON 原文就用它，给的是对象就序列化——桥只搬原文。 */
const argumentsOf = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? {});

/* ── 入口 → 规范形式（OpenAI Chat） ───────────────────────────────── */

/**
 * 一份工具声明，两种写法都读：`{name, description, parameters}` 是规范形式与 Responses，
 * `{type:'function', function:{…}}` 是 Chat，老客户端的 `functions` 又少了外面那层。
 * 读不出名字的（Gemini 的服务端工具、Anthropic 的 web_search）一律不带——翻译不了就不装懂。
 */
function flatTool(entry: unknown): ChatTool[] {
  const tool = obj(entry);
  const fn = obj(tool.function ?? tool);
  const name = text(fn.name);
  if (!name) return [];
  return [
    {
      name,
      ...(text(fn.description) ? { description: text(fn.description) } : {}),
      ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
    },
  ];
}

function chatFromChat(raw: Raw): ChatMessage[] {
  return list(raw.messages).map((entry) => {
    const message = obj(entry);
    const rawRole = text(message.role) || 'user';
    const role = rawRole === 'developer' ? 'system' : rawRole;
    if (role === 'tool') {
      return { role: 'tool', tool_call_id: text(message.tool_call_id), content: flatten(message.content) };
    }
    const calls = list(message.tool_calls).flatMap((item) => {
      const call = obj(item);
      const fn = obj(call.function ?? call);
      const name = text(fn.name);
      if (!name) return [];
      return [{ id: text(call.id) || `call_${name}`, name, arguments: argumentsOf(fn.arguments) }];
    });
    return {
      role,
      content: flatten(message.content),
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
  });
}

/**
 * Anthropic Messages：system 是独立字段，messages 里只有 user / assistant。
 * 一条 user 消息里可以同时有 `tool_result` 与文本：拆成「若干条工具结果 + 一条 user」，
 * 因为规范形式里工具结果是自己的角色（与 Chat 一致）。
 */
function chatFromAnthropic(raw: Raw): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const entry of list(raw.messages)) {
    const message = obj(entry);
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const texts: string[] = [];
    const calls: ChatToolCall[] = [];
    const results: ChatMessage[] = [];
    for (const item of blocks) {
      const block = obj(item);
      const type = text(block.type);
      if (type === 'tool_use') {
        calls.push({
          id: text(block.id),
          name: text(block.name),
          arguments: argumentsOf(block.input),
        });
      } else if (type === 'tool_result') {
        results.push({ role: 'tool', tool_call_id: text(block.tool_use_id), content: flatten(block.content) });
      } else if (type === 'text') {
        const value = text(block.text);
        if (value.length > 0) texts.push(value);
      }
    }
    if (role === 'assistant') {
      if (texts.length > 0 || calls.length > 0) {
        turns.push({
          role: 'assistant',
          content: texts.join('\n'),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
      continue;
    }
    turns.push(...results);
    if (texts.length > 0) turns.push({ role: 'user', content: texts.join('\n') });
  }
  const system = textField(raw, 'system');
  return system ? [{ role: 'system', content: system }, ...turns] : turns;
}

/**
 * OpenAI Responses：`instructions` 是 system，`input` 是一串条目。
 * 工具调用与工具结果是两类独立条目（`function_call` / `function_call_output`），
 * 连续的几个调用要折回同一条 assistant——否则一轮并行调用会变成好几轮。
 */
function chatFromResponses(raw: Raw): ChatMessage[] {
  const turnList: ChatMessage[] = [];
  const items = Array.isArray(raw.input) ? raw.input : [{ role: 'user', content: raw.input }];
  for (const entry of items) {
    const item = obj(entry);
    const type = text(item.type);
    if (type === 'function_call') {
      const call: ChatToolCall = {
        id: text(item.call_id) || text(item.id) || `call_${text(item.name)}`,
        name: text(item.name),
        arguments: argumentsOf(item.arguments),
      };
      const last = turnList[turnList.length - 1];
      if (last && last.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), call];
      } else {
        turnList.push({ role: 'assistant', content: '', tool_calls: [call] });
      }
      continue;
    }
    if (type === 'function_call_output') {
      turnList.push({ role: 'tool', tool_call_id: text(item.call_id), content: flatten(item.output) });
      continue;
    }
    // `message` 条目与「只给 role/content」的老写法都当普通消息；reasoning 之类的跳过。
    // `developer` / `system` 保持为 system 角色，避免降级成 user 或打到 Anthropic 报 400。
    if (type === 'message' || item.role !== undefined) {
      const role =
        item.role === 'assistant'
          ? 'assistant'
          : item.role === 'system' || item.role === 'developer'
            ? 'system'
            : 'user';
      turnList.push({ role, content: flatten(item.content) });
    }
  }
  const instructions = textField(raw, 'instructions');
  return instructions ? [{ role: 'system', content: instructions }, ...turnList] : turnList;
}

/**
 * Gemini：contents / parts，system 走 systemInstruction，模型在路径上。
 *
 * 它没有调用 id：`functionCall` 只给名字，结果回来时也只带名字。所以这里按**出现的顺序**
 * 编号，并记下「名字 → 还没被结果认领的 id」，遇到 `functionResponse` 时取最早那个。
 * 少了这张表，并行调用同一个函数的两次结果就会互相认错。
 */
function chatFromGemini(raw: Raw): ChatMessage[] {
  const turns: ChatMessage[] = [];
  const pending = new Map<string, string[]>();
  let seq = 0;
  for (const entry of list(raw.contents)) {
    const content = obj(entry);
    const role = content.role === 'model' ? 'assistant' : 'user';
    const texts: string[] = [];
    const calls: ChatToolCall[] = [];
    const results: ChatMessage[] = [];
    for (const item of list(content.parts)) {
      const part = obj(item);
      if (part.functionCall) {
        const call = obj(part.functionCall);
        const name = text(call.name);
        seq += 1;
        const id = `call_${seq}`;
        const ids = pending.get(name);
        if (ids) ids.push(id);
        else pending.set(name, [id]);
        calls.push({ id, name, arguments: argumentsOf(call.args) });
      } else if (part.functionResponse) {
        const response = obj(part.functionResponse);
        const name = text(response.name);
        const id = pending.get(name)?.shift() ?? `call_${name}`;
        results.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(response.response ?? '') });
      } else if (text(part.text).length > 0) {
        texts.push(text(part.text));
      }
    }
    if (role === 'assistant') {
      if (texts.length > 0 || calls.length > 0) {
        turns.push({
          role: 'assistant',
          content: texts.join('\n'),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
      continue;
    }
    turns.push(...results);
    if (texts.length > 0) turns.push({ role: 'user', content: texts.join('\n') });
  }
  const system = flatten(obj(raw.systemInstruction).parts);
  return system ? [{ role: 'system', content: system }, ...turns] : turns;
}

/** 入口侧的「工具」：声明 + 客户端想要的使用方式，四家读成同样两份东西。 */
type ParsedTools = { tools: ChatTool[]; choice?: ChatToolChoice };

function choiceFromChat(raw: Raw): ChatToolChoice | undefined {
  const value = raw.tool_choice ?? raw.function_call;
  if (value === 'auto' || value === 'none') return { mode: value };
  if (value === 'required' || value === 'any') return { mode: 'required' };
  const choice = obj(value);
  const name = text(obj(choice.function).name) || text(choice.name);
  return name ? { mode: 'tool', name } : undefined;
}

function toolsFromChat(raw: Raw): ParsedTools {
  const tools = [...list(raw.tools), ...list(raw.functions)].flatMap(flatTool);
  const choice = choiceFromChat(raw);
  return { tools, ...(choice ? { choice } : {}) };
}

function toolsFromResponses(raw: Raw): ParsedTools {
  // Responses 的声明是扁平的，但 `type` 必须写出来；不是 function 的（内置工具）跳过。
  const tools = list(raw.tools).flatMap((entry) => (text(obj(entry).type) === 'function' ? flatTool(entry) : []));
  const value = raw.tool_choice;
  let choice: ChatToolChoice | undefined;
  if (value === 'auto' || value === 'none' || value === 'required') {
    choice = { mode: value };
  } else {
    const picked = obj(value);
    const name = text(picked.name) || text(obj(picked.function).name);
    if (name) choice = { mode: 'tool', name };
  }
  return { tools, ...(choice ? { choice } : {}) };
}

function toolsFromAnthropic(raw: Raw): ParsedTools {
  const tools = list(raw.tools).flatMap((entry) => {
    const tool = obj(entry);
    const name = text(tool.name);
    if (!name) return [];
    return [
      {
        name,
        ...(text(tool.description) ? { description: text(tool.description) } : {}),
        ...(tool.input_schema === undefined ? {} : { parameters: tool.input_schema }),
      },
    ];
  });
  const picked = obj(raw.tool_choice);
  const type = text(picked.type);
  let choice: ChatToolChoice | undefined;
  if (type === 'any') choice = { mode: 'required' };
  else if (type === 'auto' || type === 'none') choice = { mode: type };
  else if (type === 'tool' && text(picked.name)) choice = { mode: 'tool', name: text(picked.name) };
  return { tools, ...(choice ? { choice } : {}) };
}

function toolsFromGemini(raw: Raw): ParsedTools {
  const tools = list(raw.tools).flatMap((entry) => list(obj(entry).functionDeclarations)).flatMap(flatTool);
  const config = obj(obj(raw.toolConfig).functionCallingConfig);
  const allowed = list(config.allowedFunctionNames).map(text);
  const only = allowed[0];
  let choice: ChatToolChoice | undefined;
  if (text(config.mode) === 'NONE') choice = { mode: 'none' };
  else if (text(config.mode) === 'AUTO') choice = { mode: 'auto' };
  else if (text(config.mode) === 'ANY') choice = only ? { mode: 'tool', name: only } : { mode: 'required' };
  return { tools, ...(choice ? { choice } : {}) };
}

const PARSE: Record<Dialect, (raw: Raw, model: string) => ChatMessage[]> = {
  'openai-chat': chatFromChat,
  'openai-responses': chatFromResponses,
  'anthropic-messages': chatFromAnthropic,
  'google-gemini': chatFromGemini,
};

const TOOLS: Record<Dialect, (raw: Raw) => ParsedTools> = {
  'openai-chat': toolsFromChat,
  'openai-responses': toolsFromResponses,
  'anthropic-messages': toolsFromAnthropic,
  'google-gemini': toolsFromGemini,
};

function stopListOf(dialect: Dialect, raw: Raw): string[] {
  if (dialect === 'openai-chat') {
    if (typeof raw.stop === 'string') return raw.stop.length > 0 ? [raw.stop] : [];
    return list(raw.stop).map(text).filter((item) => item.length > 0);
  }
  if (dialect === 'anthropic-messages') {
    return list(raw.stop_sequences).map(text).filter((item) => item.length > 0);
  }
  if (dialect === 'google-gemini') {
    return list(obj(raw.generationConfig).stopSequences).map(text).filter((item) => item.length > 0);
  }
  return [];
}

/**
 * 只用在**跨方言桥接**路径上；同方言直通时这个函数不会被调用。
 *
 * `stream` 由调用方给出，不从 body 里读：Gemini 的流式写在路径上
 * （`:streamGenerateContent`），body 里没有这个字段，从 body 读会把它抹成 false。
 */
export function parseInbound(dialect: Dialect, raw: Raw, model: string, stream: boolean): ChatBody {
  const geminiCfg = obj(raw.generationConfig);
  const maxTokens =
    dialect === 'openai-chat'
      ? (raw.max_completion_tokens ?? raw.max_tokens)
      : dialect === 'anthropic-messages'
        ? raw.max_tokens
        : dialect === 'google-gemini'
          ? geminiCfg.maxOutputTokens
          : raw.max_output_tokens;
  const temperature = dialect === 'google-gemini' ? geminiCfg.temperature : raw.temperature;
  const topP = dialect === 'google-gemini' ? geminiCfg.topP : raw.top_p;
  const stop = stopListOf(dialect, raw);
  const { tools, choice } = TOOLS[dialect](raw);
  // 推理档位：只有 Chat（`reasoning_effort`）与 Responses（`reasoning.effort`）说得出「档位」。
  // Anthropic（`thinking.budget_tokens`）与 Gemini（`thinkingConfig.thinkingBudget`）说的是预算
  // token 数——把预算折成档位是猜，猜错了直接改变上游的思考成本，所以宁可这一版不带。
  const reasoningEffort =
    dialect === 'openai-chat'
      ? raw.reasoning_effort
      : dialect === 'openai-responses'
        ? obj(raw.reasoning).effort
        : undefined;
  return {
    model,
    messages: PARSE[dialect](raw, model),
    stream,
    ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0 ? { reasoning_effort: reasoningEffort } : {}),
    ...(typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    ...(typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {}),
    ...(typeof topP === 'number' && Number.isFinite(topP) ? { top_p: topP } : {}),
    ...(stop.length > 0 ? { stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(choice ? { tool_choice: choice } : {}),
  };
}

/* ── 响应 → AnswerCore（记账与渲染都要的中间物，不是方言） ──────────── */

/**
 * OpenAI chat / responses：`prompt_tokens` / `input_tokens` **含**缓存命中的部分，
 * 命中数在 `*_details.cached_tokens` 里。
 */
function chatUsage(raw: RawUsage): Usage {
  const details = obj(raw.prompt_tokens_details ?? raw.input_tokens_details);
  // 缓存命中的字段各家不同：OpenAI 放在 `prompt_tokens_details.cached_tokens`，
  // DeepSeek 直接给 `prompt_cache_hit_tokens`（未命中的那半在 `prompt_cache_miss_tokens`）。
  // 少了这一条，DeepSeek 的缓存命中率在账本上永远是 0——那正是它最便宜的来源。
  const cached = num(details.cached_tokens) || num(raw.prompt_cache_hit_tokens) || num(raw.cached_tokens);
  return {
    input: num(raw.prompt_tokens ?? raw.input_tokens),
    cached,
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

/** Chat 的 `message.tool_calls`；Responses 的扁平条目也认（`{name, arguments}`）。 */
function toolCallsFromChat(message: Raw | undefined): ChatToolCall[] {
  return list(message?.tool_calls).flatMap((entry) => {
    const call = obj(entry);
    const fn = obj(call.function ?? call);
    const name = text(fn.name);
    if (!name) return [];
    return [{ id: text(call.id) || `call_${name}`, name, arguments: argumentsOf(fn.arguments) }];
  });
}

const extractChat = (json: Raw): AnswerCore => {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as { message?: Raw } | undefined;
  return {
    text: flatten(choice?.message?.content),
    reasoning: text(choice?.message?.reasoning_content) || text(choice?.message?.reasoning),
    toolCalls: toolCallsFromChat(choice?.message),
    model: text(json.model),
    usage: chatUsage(obj(json.usage)),
    createdAt: num(json.created),
  };
};

const extractResponses = (json: Raw): AnswerCore => {
  const output = list(json.output);
  return {
    text: output.map((item) => flatten(obj(item).content)).filter(Boolean).join('\n'),
    // reasoning 条目有两种写法：`summary[]`（OpenAI 的摘要）与 `content[]`（原样思考文本）。
    reasoning: output
      .filter((entry) => text(obj(entry).type) === 'reasoning')
      .map((entry) => {
        const item = obj(entry);
        return (
          list(item.summary).map((part) => text(obj(part).text)).join('') ||
          list(item.content).map((part) => text(obj(part).text)).join('')
        );
      })
      .filter(Boolean)
      .join('\n'),
    toolCalls: output.flatMap((entry) => {
      const item = obj(entry);
      if (text(item.type) !== 'function_call') return [];
      return [
        {
          id: text(item.call_id) || text(item.id) || `call_${text(item.name)}`,
          name: text(item.name),
          arguments: argumentsOf(item.arguments),
        },
      ];
    }),
    model: text(json.model),
    usage: chatUsage(obj(json.usage)),
    createdAt: num(json.created_at),
  };
};

const extractAnthropic = (json: Raw): AnswerCore => {
  const blocks = list(json.content);
  return {
    text: blocks.map((block) => text(obj(block).text)).join(''),
    reasoning: blocks
      .filter((entry) => text(obj(entry).type) === 'thinking')
      .map((entry) => text(obj(entry).thinking))
      .join(''),
    toolCalls: blocks.flatMap((entry) => {
      const block = obj(entry);
      if (text(block.type) !== 'tool_use') return [];
      return [{ id: text(block.id), name: text(block.name), arguments: JSON.stringify(block.input ?? {}) }];
    }),
    model: text(json.model),
    usage: anthropicUsage(obj(json.usage)),
    createdAt: 0,
  };
};

const extractGemini = (json: Raw): AnswerCore => {
  const candidates = list(json.candidates);
  const parts = candidates.flatMap((candidate) => list(obj(obj(candidate).content).parts));
  const thought = (part: unknown): boolean => obj(part).thought === true;
  return {
    text: parts.filter((part) => !thought(part)).map((part) => text(obj(part).text)).filter(Boolean).join('\n'),
    reasoning: parts.filter(thought).map((part) => text(obj(part).text)).filter(Boolean).join('\n'),
    toolCalls: parts.flatMap((entry) => {
      const part = obj(entry);
      if (!part.functionCall) return [];
      const call = obj(part.functionCall);
      return [{ id: `call_${text(call.name)}`, name: text(call.name), arguments: argumentsOf(call.args) }];
    }),
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

/* ── 规范形式 → 出口方言（只用在跨方言桥接） ──────────────────────── */

/**
 * 协议适配器已经把响应读成 AnswerCore，这里再落到客户端要的方言。
 * `norm` 只加在顶层：它是附加字段，按已知字段反序列化的客户端会忽略它。
 *
 * 工具调用按各家的形状渲染：Chat 套 `function`，Anthropic 是 `tool_use` 块加
 * `stop_reason: 'tool_use'`，Responses 是独立的 `function_call` 条目，Gemini 是
 * `functionCall` part。`finish_reason` / `stop_reason` 也要跟着改——模型是在等工具，
 * 不是在说完话。
 */
export function renderInbound(dialect: Dialect, answer: AnswerCore, norm: NormMeta): unknown {
  const { input, cached, output } = answer.usage;
  const calls = answer.toolCalls;

  if (dialect === 'openai-chat') {
    return {
      id: `chatcmpl-${norm.request_id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: answer.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            // 有工具调用时 content 是 null（OpenAI 自己的形状）；没有工具就是寻常的文本。
            content: answer.text.length > 0 || calls.length === 0 ? answer.text : null,
            ...(answer.reasoning.length > 0 ? { reasoning_content: answer.reasoning } : {}),
            ...(calls.length > 0
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          },
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
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
      content: [
        ...(answer.reasoning.length > 0 ? [{ type: 'thinking', thinking: answer.reasoning }] : []),
        ...(answer.text.length > 0 || calls.length === 0 ? [{ type: 'text', text: answer.text }] : []),
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: toolArguments(call) })),
      ],
      stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      // Anthropic 的 input_tokens 不含缓存读，所以这里回的是扣掉命中的那部分；下界夹到 0 防止异常上游报负。
      usage: { input_tokens: Math.max(input - cached, 0), output_tokens: output, cache_read_input_tokens: cached },
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
        ...(answer.reasoning.length > 0
          ? [
              {
                id: `rs_${norm.request_id}`,
                type: 'reasoning',
                status: 'completed',
                summary: [{ type: 'summary_text', text: answer.reasoning }],
              },
            ]
          : []),
        // 没有正文就不发消息条目：不能把「上游没说话」写成「模型说了空话」。
        ...(answer.text.length > 0
          ? [
              {
                id: `msg_${norm.request_id}`,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: answer.text }],
              },
            ]
          : []),
        ...calls.map((call, index) => ({
          id: `fc_${norm.request_id}_${index + 1}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
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
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            ...(answer.reasoning.length > 0 ? [{ text: answer.reasoning, thought: true }] : []),
            ...(calls.length === 0
              ? [{ text: answer.text }]
              : [
                  ...(answer.text.length > 0 ? [{ text: answer.text }] : []),
                  ...calls.map((call) => ({ functionCall: { name: call.name, args: toolArguments(call) } })),
                ]),
          ],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
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
  /**
   * 每个思考增量。
   *
   * 与 `delta` 分开是因为四家各有各的说法：Chat 是 `reasoning_content`、Anthropic 是 thinking 块、
   * Responses 是 reasoning summary 的增量事件、Gemini 是 `thought: true` 的 part。客户端那边没有
   * 思考位置的（比如只认 `content` 的老客户端）由各家 emitter 自己丢掉。
   */
  reasoning(text: string): string[];
  /** 一次工具调用开始（此时只知道 id 与名字）。`index` 是上游给的序号。 */
  toolStart(index: number, call: { id: string; name: string }): string[];
  /** 参数的增量片段（JSON 原文）。 */
  toolArgs(index: number, args: string): string[];
  /**
   * 收尾：停止标记、还没说完的工具调用与用量。此时才知道最终 token 数，
   * 所以费用也写在这一帧的用量里——客户端读用量时顺手读到，不必再问一次。
   * （Chat 那条路的费用在 Norm 自己补的 `{"norm":…}` 帧上，不看这里。）
   */
  tail(answer: AnswerCore, norm: NormMeta): string[];
};

/** 带事件名的 SSE（Responses / Anthropic 都按 `type` 分派）。 */
const named = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Gemini 的流是不带事件名的裸 data 帧。 */
const bare = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function chatEmitter(id: string, model: string): StreamEmitter {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...extra }] });
  /** 上游序号 → Chat 的 `tool_calls[].index`：Chat 要的是从 0 开始、按出现顺序的编号。 */
  const slots = new Map<number, number>();
  const slotOf = (index: number): number => {
    const known = slots.get(index);
    if (known !== undefined) return known;
    const next = slots.size;
    slots.set(index, next);
    return next;
  };
  return {
    head: () => [`data: ${chunk({ role: 'assistant', content: '' })}\n\n`],
    delta: (text) => [`data: ${chunk({ content: text })}\n\n`],
    reasoning: (text) => [`data: ${chunk({ reasoning_content: text })}\n\n`],
    toolStart: (index, call) => [
      `data: ${chunk({
        tool_calls: [{ index: slotOf(index), id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
      })}\n\n`,
    ],
    toolArgs: (index, args) => [
      `data: ${chunk({ tool_calls: [{ index: slotOf(index), function: { arguments: args } }] })}\n\n`,
    ],
    tail: (answer) => [`data: ${chunk({}, { finish_reason: answer.toolCalls.length > 0 ? 'tool_calls' : 'stop' })}\n\n`],
  };
}

function responsesEmitter(id: string, model: string): StreamEmitter {
  const createdAt = Math.floor(Date.now() / 1000);
  const reasoningId = `rs_${id}`;
  const messageId = `msg_${id}`;
  /**
   * Responses 的输出是一串**按序号排下去的条目**，所以序号不能写死：思考先到时它占 0，
   * 消息就得让到 1。`nextIndex` 是下一个空位，谁先开口谁先拿号——这也是为什么骨架不在
   * `head()` 里一次开完（那时还不知道这次会不会先想）。
   */
  let nextIndex = 0;
  let text = '';
  let reasoning = '';
  let reasoningAt: number | null = null;
  let reasoningOpen = false;
  let messageAt: number | null = null;
  let messageOpen = false;
  let callSeq = 0;
  const calls = new Map<number, { at: number; itemId: string; callId: string; name: string; args: string }>();
  const message = (status: string, content: unknown[]) => ({ id: messageId, type: 'message', status, role: 'assistant', content });
  const reasoningItem = (status: string) => ({
    id: reasoningId,
    type: 'reasoning',
    status,
    summary: reasoning.length > 0 ? [{ type: 'summary_text', text: reasoning }] : [],
  });

  /** 思考条目必须先被声明，客户端的增量事件才有地方挂（没有条目时下游按协议丢掉那些增量）。 */
  const openReasoning = (): string[] => {
    if (reasoningOpen || reasoningAt !== null || messageAt !== null) return [];
    reasoningAt = nextIndex++;
    reasoningOpen = true;
    return [
      named('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: reasoningAt,
        item: { id: reasoningId, type: 'reasoning', status: 'in_progress', summary: [] },
      }),
      named('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        item_id: reasoningId,
        output_index: reasoningAt,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    ];
  };
  const closeReasoning = (): string[] => {
    if (!reasoningOpen) return [];
    reasoningOpen = false;
    return [
      named('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: reasoningId,
        output_index: reasoningAt,
        summary_index: 0,
        text: reasoning,
      }),
      named('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: reasoningId,
        output_index: reasoningAt,
        summary_index: 0,
        part: { type: 'summary_text', text: reasoning },
      }),
      named('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoningAt,
        item: reasoningItem('completed'),
      }),
    ];
  };
  /** 文本 item 必须先 done 才能开下一条：Responses 的输出是一条条排下去的。 */
  const openMessage = (): string[] => {
    if (messageOpen || messageAt !== null) return [];
    messageAt = nextIndex++;
    messageOpen = true;
    return [
      named('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: messageAt,
        item: message('in_progress', []),
      }),
      named('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: messageId,
        output_index: messageAt,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      }),
    ];
  };
  const closeText = (): string[] => {
    if (!messageOpen) return [];
    messageOpen = false;
    return [
      named('response.output_text.done', { type: 'response.output_text.done', item_id: messageId, output_index: messageAt, content_index: 0, text }),
      named('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: messageAt,
        content_index: 0,
        part: { type: 'output_text', text },
      }),
      named('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: messageAt,
        item: message('completed', [{ type: 'output_text', text }]),
      }),
    ];
  };
  const closeCall = (call: { at: number; itemId: string; callId: string; name: string; args: string }): string[] => [
    named('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: call.itemId,
      output_index: call.at,
      arguments: call.args,
    }),
    named('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: call.at,
      item: { id: call.itemId, type: 'function_call', status: 'completed', call_id: call.callId, name: call.name, arguments: call.args },
    }),
  ];

  return {
    head: () => [
      named('response.created', { type: 'response.created', response: { id, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [] } }),
    ],
    reasoning: (delta) => {
      const chunks = openReasoning();
      reasoning += delta;
      chunks.push(
        named('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningId,
          output_index: reasoningAt ?? 0,
          summary_index: 0,
          delta,
        }),
      );
      return chunks;
    },
    delta: (delta) => {
      const chunks = [...closeReasoning(), ...openMessage()];
      text += delta;
      return [
        ...chunks,
        named('response.output_text.delta', { type: 'response.output_text.delta', item_id: messageId, output_index: messageAt ?? 0, content_index: 0, delta }),
      ];
    },
    toolStart: (index, call) => {
      // 只调工具、一句话不说的回合不该凭空多出一条空消息：上游本来就没说话，
      // 开一条 `content: [{text: ""}]` 的条目只会让下游把它当成「模型回了空」。
      const opened = [...closeReasoning(), ...closeText()];
      callSeq += 1;
      const at = nextIndex++;
      const entry = { at, itemId: `fc_${id}_${callSeq}`, callId: call.id, name: call.name, args: '' };
      calls.set(index, entry);
      return [
        ...opened,
        named('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: at,
          item: { id: entry.itemId, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' },
        }),
      ];
    },
    toolArgs: (index, args) => {
      const entry = calls.get(index);
      if (!entry) return [];
      entry.args += args;
      return [
        named('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: entry.itemId,
          output_index: entry.at,
          delta: args,
        }),
      ];
    },
    tail: (answer, norm) => {
      const chunks: string[] = [];
      // 上游可能只在整段结束时才把思考给出来（非流式推理面就是这样）：收尾处补一条完整的思考条目。
      if (reasoning.length === 0 && answer.reasoning.length > 0) {
        chunks.push(...openReasoning());
        reasoning = answer.reasoning;
        chunks.push(
          named('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningId,
            output_index: reasoningAt ?? 0,
            summary_index: 0,
            delta: reasoning,
          }),
        );
      }
      // 正文为空就不发消息条目：思考条目已经说明了这一轮上游想了什么。
      if (text.length > 0) chunks.push(...openMessage(), ...closeText());
      chunks.push(...closeReasoning());
      for (const entry of calls.values()) chunks.push(...closeCall(entry));
      chunks.push(
        named('response.completed', {
          type: 'response.completed',
          response: {
            id,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model: answer.model,
            output: [
              ...(reasoning.length > 0 ? [reasoningItem('completed')] : []),
              ...(text.length > 0 ? [message('completed', [{ type: 'output_text', text }])] : []),
              ...answer.toolCalls.map((call, index) => ({
                id: `fc_${id}_${index + 1}`,
                type: 'function_call',
                status: 'completed',
                call_id: call.id,
                name: call.name,
                arguments: call.arguments,
              })),
            ],
            usage: {
              input_tokens: answer.usage.input,
              input_tokens_details: { cached_tokens: answer.usage.cached },
              output_tokens: answer.usage.output,
              total_tokens: answer.usage.input + answer.usage.output,
              cost_usd_nanos: norm.fee_nanos,
            },
          },
        }),
      );
      return chunks;
    },
  };
}

function anthropicEmitter(id: string, model: string): StreamEmitter {
  /** 已经开到第几个内容块（0 是 head() 开的文本块），当前开着哪一块，以及活跃文本块序号。 */
  let block = 0;
  let open: number | null = 0;
  let textBlock: number | null = 0;
  /** 当前开着的思考块；文本或工具一开口它就关掉（思考总是先说，说完才轮到别的）。 */
  let thinkingBlock: number | null = null;
  const blockOf = new Map<number, number>();
  const closeOpen = (): string[] => {
    if (open === null) return [];
    const index = open;
    open = null;
    if (textBlock === index) textBlock = null;
    if (thinkingBlock === index) thinkingBlock = null;
    return [named('content_block_stop', { type: 'content_block_stop', index })];
  };

  return {
    head: () => [
      named('message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ],
    delta: (text) => {
      const chunks: string[] = [];
      // 工具块关掉文本块 0 后如果模型又吐文本，不能往已关闭的 block 0 写，必须新开一个文本块。
      if (textBlock === null || open !== textBlock) {
        chunks.push(...closeOpen());
        block += 1;
        textBlock = block;
        open = block;
        chunks.push(
          named('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } }),
        );
      }
      chunks.push(
        named('content_block_delta', { type: 'content_block_delta', index: textBlock, delta: { type: 'text_delta', text } }),
      );
      return chunks;
    },
    reasoning: (text) => {
      const chunks: string[] = [];
      if (thinkingBlock === null || open !== thinkingBlock) {
        chunks.push(...closeOpen());
        block += 1;
        thinkingBlock = block;
        open = block;
        chunks.push(
          named('content_block_start', {
            type: 'content_block_start',
            index: block,
            content_block: { type: 'thinking', thinking: '' },
          }),
        );
      }
      chunks.push(
        named('content_block_delta', {
          type: 'content_block_delta',
          index: thinkingBlock,
          delta: { type: 'thinking_delta', thinking: text },
        }),
      );
      return chunks;
    },
    toolStart: (index, call) => {
      const chunks = closeOpen();
      block += 1;
      blockOf.set(index, block);
      open = block;
      chunks.push(
        named('content_block_start', {
          type: 'content_block_start',
          index: block,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        }),
      );
      return chunks;
    },
    toolArgs: (index, args) => {
      const at = blockOf.get(index);
      return at === undefined
        ? []
        : [named('content_block_delta', { type: 'content_block_delta', index: at, delta: { type: 'input_json_delta', partial_json: args } })];
    },
    tail: (answer, norm) => [
      ...closeOpen(),
      named('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: answer.toolCalls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: answer.usage.output,
          input_tokens: Math.max(answer.usage.input - answer.usage.cached, 0),
          cache_read_input_tokens: answer.usage.cached,
          cost_usd_nanos: norm.fee_nanos,
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
    reasoning: (text) => [
      bare({ candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] }, index: 0 }], modelVersion: model }),
    ],
    // Gemini 的流没有增量工具帧：参数攒到收尾，与这一段文本一起给出去。
    toolStart: () => [],
    toolArgs: () => [],
    tail: (answer, norm) =>
      [
        bare({
          candidates: [
            {
              // 纯文本收尾不发空 parts: []（部分 Gemini SDK 解析器要求非空 parts）。
              ...(answer.toolCalls.length > 0
                ? {
                    content: {
                      role: 'model',
                      parts: answer.toolCalls.map((call) => ({ functionCall: { name: call.name, args: toolArguments(call) } })),
                    },
                  }
                : {}),
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: answer.usage.input,
            cachedContentTokenCount: answer.usage.cached,
            candidatesTokenCount: answer.usage.output,
            totalTokenCount: answer.usage.input + answer.usage.output,
            cost_usd_nanos: norm.fee_nanos,
          },
          modelVersion: answer.model,
        }),
      ],
  };
}

/* ── 首字：哪一帧才算「开始说话了」 ───────────────────────────────── */

/**
 * 这一帧里有没有真正的输出增量：文本、思考，或者一次工具调用的开头。
 *
 * 首字延迟不能按「第一帧到达」算：OpenAI chat 的第一帧通常只有一个空的
 * `delta.role`，DeepSeek 的推理模型还会先吐 `reasoning_content`——它们都还没开始
 * 「说话」，但都比真正的第一个字早得多。工具调用同样是上游在产字：只回一句
 * 「我要调工具」的回答，首字也不能记成空。
 */
export function carriesOutput(dialect: Dialect, data: string): boolean {
  if (data.length === 0 || data === '[DONE]') return false;
  let json: Raw;
  try {
    json = JSON.parse(data) as Raw;
  } catch {
    return false;
  }

  const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

  if (dialect === 'openai-chat') {
    const delta = (Array.isArray(json.choices) ? json.choices[0] : undefined) as { delta?: Raw } | undefined;
    const body = obj(delta?.delta);
    return nonEmpty(body.content) || nonEmpty(body.reasoning_content) || list(body.tool_calls).length > 0;
  }

  if (dialect === 'openai-responses') {
    const type = typeof json.type === 'string' ? json.type : '';
    if (type === 'response.output_item.added') return text(obj(json.item).type) === 'function_call';
    return (
      (type === 'response.output_text.delta' ||
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.function_call_arguments.delta') &&
      nonEmpty(json.delta)
    );
  }

  if (dialect === 'anthropic-messages') {
    const type = typeof json.type === 'string' ? json.type : '';
    if (type === 'content_block_start') return text(obj(json.content_block).type) === 'tool_use';
    if (type !== 'content_block_delta') return false;
    const delta = obj(json.delta);
    return nonEmpty(delta.text) || nonEmpty(delta.thinking) || nonEmpty(delta.partial_json);
  }

  // gemini：裸 data 帧，文本与工具调用都在 candidates[].content.parts[] 里。
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  return candidates.some((candidate) => {
    const parts = obj(candidate).content as { parts?: unknown } | undefined;
    return list(parts?.parts).some((part) => nonEmpty(obj(part).text) || obj(part).functionCall !== undefined);
  });
}

/* ── 流里的失败：200 也可能是一句「我干不了」 ─────────────────────── */

/**
 * 上游在流里说的「这次失败了」。
 *
 * 一家上游先回 HTTP 200、再在 SSE 里报错是常态：配额不足、模型下线、内容被拦。
 * 这类帧在四种方言里长得不一样，而且**都不是内容**。认不出来就整帧丢掉的结果，
 * 是客户端拿到一个 200、一片空白、和一笔 Gas——用户看到的就是「点了没反应」。
 * 所以这里统一认一次，交给转发层去决定：既不能当内容渲染，也不该被吞掉。
 */
export function streamError(dialect: Dialect, data: string): string | null {
  if (data.length === 0 || data === '[DONE]') return null;
  let json: Raw;
  try {
    json = JSON.parse(data) as Raw;
  } catch {
    return null;
  }

  /** 错误体的形状各家不同：一句人话、一个对象、或者只有一个 code。 */
  const messageOf = (value: unknown, depth = 0): string | null => {
    if (typeof value === 'string') return value.trim() || null;
    if (depth > 2) return null;
    const record = obj(value);
    for (const key of ['message', 'detail', 'error_description']) {
      const text = record[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    if (record.error !== undefined && record.error !== value) {
      const nested = messageOf(record.error, depth + 1);
      if (nested) return nested;
    }
    for (const key of ['code', 'type', 'status']) {
      const text = record[key];
      if (typeof text === 'string' && text.trim() && text.trim() !== 'error') return text.trim();
    }
    return null;
  };

  const type = typeof json.type === 'string' ? json.type : '';

  if (dialect === 'openai-chat' || dialect === 'google-gemini') {
    // chat：`{"error":{…}}`；gemini：裸帧里的同一把键。
    if (json.error === undefined) return null;
    return messageOf(json.error) ?? '上游在流里报了错';
  }

  if (dialect === 'openai-responses') {
    if (type === 'response.failed') {
      return messageOf(obj(json.response).error) ?? messageOf(json.error) ?? '上游把这次响应标成了 failed';
    }
    // `type: "error"` 是规范形状；裸的 `{error:…}` 也有人发，两种都认。
    if (type === 'error' || json.error !== undefined) {
      return messageOf(json.error) ?? messageOf(json) ?? '上游在流里报了错';
    }
    return null;
  }

  // anthropic：`{"type":"error","error":{"type":…,"message":…}}`
  if (type === 'error') return messageOf(json.error) ?? '上游在流里报了错';
  return null;
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
        // `response.completed` 是正常收尾，`response.incomplete` 是撞了 max_output_tokens；
        // 两种都带 usage，都算这次调用的账。
        const type = typeof json.type === 'string' ? json.type : '';
        if (type === 'response.completed' || type === 'response.incomplete') {
          takeChat(obj(obj(json.response).usage));
        }
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

/* ── 费用：同方言直通时写进流尾那一帧 ─────────────────────────────── */

/**
 * 收尾帧里「用量」那一层，费用就写在它旁边；不是收尾帧就是 null。
 *
 * 只有两家的流里有这么一帧：Responses 的 `response.completed`、Anthropic 的
 * `message_delta`——用量到它为止，费用也就能在这一刻算出来。`feeNanos` 为 null
 * 时只做判断不写入，判定与写入共用同一处方言知识。
 */
function terminalEvent(dialect: Dialect, data: string, feeNanos: number | null): Raw | null {
  let json: Raw;
  try {
    json = JSON.parse(data) as Raw;
  } catch {
    return null;
  }
  if (dialect === 'openai-responses') {
    if (json.type !== 'response.completed') return null;
    const response = obj(json.response);
    const usage = obj(response.usage);
    return { ...json, response: { ...response, usage: feeNanos === null ? usage : { ...usage, cost_usd_nanos: feeNanos } } };
  }
  if (dialect === 'anthropic-messages') {
    if (json.type !== 'message_delta') return null;
    const usage = obj(json.usage);
    return { ...json, usage: feeNanos === null ? usage : { ...usage, cost_usd_nanos: feeNanos } };
  }
  return null;
}

/** 这一帧是不是「用量到此为止」的收尾帧：是就扣住它，等费用算出来再放行。 */
export function carriesFinalUsage(dialect: Dialect, data: string): boolean {
  return terminalEvent(dialect, data, null) !== null;
}

/** 把费用补进收尾帧的用量里，返回改好的 data 原文；不是收尾帧就返回 null。 */
export function stampStreamCost(dialect: Dialect, data: string, meta: NormMeta): string | null {
  const stamped = terminalEvent(dialect, data, meta.fee_nanos);
  return stamped === null ? null : JSON.stringify(stamped);
}

/**
 * 没有收尾帧的那一家（Gemini 的流到最后一个内容块就结束了）：费用补一条只带
 * 用量的块——Gemini 自己的 API 也是这么收尾的。其余三家已经写进收尾帧，返回空串。
 */
export function closingCostFrame(dialect: Dialect, model: string, usage: Usage, meta: NormMeta): string {
  if (dialect !== 'google-gemini') return '';
  return bare({
    usageMetadata: {
      promptTokenCount: usage.input,
      cachedContentTokenCount: usage.cached,
      candidatesTokenCount: usage.output,
      totalTokenCount: usage.input + usage.output,
      cost_usd_nanos: meta.fee_nanos,
    },
    modelVersion: model,
  });
}

export function streamEmitter(dialect: Dialect, id: string, model: string): StreamEmitter {
  return EMITTERS[dialect](id, model);
}
