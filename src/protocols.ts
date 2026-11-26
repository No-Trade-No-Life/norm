/**
 * 上游协议契约层（Protocol Profiles）：只声明「方言 + 厂商契约」，不包含任何翻译逻辑。
 *
 * 两层彻底分离：
 *   1. 线缆方言（`Dialect`，见 `src/codecs.ts` 与 `src/dialects.ts`）：全系统只有 4 份，负责
 *      请求 / 响应 / 流式 / 模型清单 ↔ 规范中间态的互译；
 *   2. 上游协议（`Protocol`，本文件）：声明这条上游说哪一种方言，并按需叠加厂商特有契约
 *      （固定 `base_url`、路径前缀、会话头、分时计价）。
 *
 * 类型约束强制保证：`ProtocolProfile` 与 `ResolvedProtocol` 上都不存在翻译方法——
 * 新增一条厂商协议（如 `deepseek`、`opencode-go` 或未来的任何厂商）只能通过 `dialect`
 * 复用既有方言，新增翻译代码恒为 0，不存在「每加一个上游就要加 4 种翻译」的矩阵膨胀。
 */
import {
  DIALECTS,
  dialectCodecFor,
  isDialect,
  sanitizeGeminiSchema,
  toolArguments,
  type ChatBody,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type ChatToolChoice,
  type Dialect,
  type DialectCodec,
  type Modalities,
  type ModelInfo,
  type StreamEvent,
} from './codecs';
import { DEEPSEEK_HOLIDAYS, DEEPSEEK_PEAK_WEEKDAYS, DEEPSEEK_PEAK_WINDOWS_UTC, DEEPSEEK_TARIFFS } from './deepseek';
import { openaiHeaders } from './oauth';
import { longestMatch, type PriceAnchor, type Tariff } from './pricing';
import { SESSION_HEADER } from './sessions';

export {
  DIALECTS,
  dialectCodecFor,
  isDialect,
  sanitizeGeminiSchema,
  toolArguments,
  type ChatBody,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type ChatToolChoice,
  type Dialect,
  type DialectCodec,
  type Modalities,
  type ModelInfo,
  type StreamEvent,
};

export type Protocol = Dialect | 'deepseek' | 'opencode-go' | 'openai-oauth';

export const PROTOCOLS: Protocol[] = [
  ...DIALECTS,
  'deepseek',
  'opencode-go',
  'openai-oauth',
];

export function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as string[]).includes(value);
}

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
 * 一条协议的上游契约（`GET /api/v1/protocols` 的一条）。
 *
 * 「Base URL + API key」不是两个可以自由组合的输入框，而是协议的一部分：厂商协议
 * （如 `deepseek`、`opencode-go`）的地址由协议给定，用户只需要给密钥；四条通用方言协议
 * 才由用户填自己的上游地址。前端「先选协议、再按协议渲染字段」读的就是这张表。
 */
export type ProtocolSchema = {
  protocol: Protocol;
  /** 线缆上的方言：`deepseek` 是 `openai-responses`，`opencode-go` 是 `openai-chat`。 */
  dialect: Dialect;
  /** 这条协议钉死的上游基址；null = 由用户填。 */
  base_url: string | null;
  /** 配置一条这种上游要填的字段，按表单顺序；`provider_key` 是唯一恒有的那个。 */
  fields: Array<'base_url' | 'provider_key'>;
  /** 凭据是一对 OAuth 令牌：前端要渲染「连接」这一步，而不是一个密钥输入框。 */
  oauth: boolean;
  /** 上游只接受流式请求：非流式调用会被转发层挡下并说清原因。 */
  stream_only: boolean;
};

/**
 * 声明式的上游协议配置：只绑定一种 `dialect`，并按需覆写厂商特有的传输与计价契约。
 * 刻意不接受任何编解码回调——翻译逻辑只能活在 `src/codecs.ts` 与 `src/dialects.ts`。
 */
export type ProtocolProfile = {
  /** 这条上游说的线缆方言。直通判定、编解码、用量嗅探全部按它分发。 */
  dialect: Dialect;
  /** 协议钉死的上游基址；不写 = 由用户填（四条通用方言）。 */
  base_url?: string;
  /** 覆写推理路径（缺省沿用方言默认路径）。 */
  path?: (model: string) => string;
  /** 覆写流式推理路径（缺省优先沿用 `path`，否则沿用方言默认流式路径）。 */
  streamPath?: (model: string) => string;
  /** 覆写鉴权头（缺省沿用方言默认鉴权头）。 */
  headers?: (apiKey: string) => Record<string, string>;
  /** 覆写模型清单路径（缺省沿用方言默认清单路径）。 */
  modelsPath?: () => string;
  /**
   * 这条协议要求上游「本次会话」的头名（如 OpenCode Go 的 `x-opencode-session`）。
   * 只声明要哪个头，值由 `sessions.ts` 从请求派生——协议不碰派生规则。
   */
  session_header?: string;
  /**
   * 这条协议自带的定价（整张表）。不写 = 没有自定义定价，账本用 `pricing.ts` 的通用表。
   * 只有按时刻变价的厂商才需要它。
   */
  pricing?: ProtocolPricing;
  /**
   * 凭据是一对会过期的 OAuth 令牌：用之前先拿 refresh_token 换新的，换完写回库
   * （见 `src/credentials.ts`）。这是**凭据契约**，不是编解码——翻译仍然只在 codecs.ts 里。
   */
  oauth?: true;
  /**
   * 上游只接受流式请求（ChatGPT 的 responses 端点缺 `stream: true` 直接 400）。
   * 声明在这里，转发层就能把注定失败的请求挡在自己这一侧，并说清为什么。
   */
  stream_only?: true;
};

/** 补齐方言默认传输规则后的协议契约（仍不含任何翻译方法）。 */
export type ResolvedProtocol = {
  protocol: Protocol;
  dialect: Dialect;
  base_url?: string;
  path: (model: string) => string;
  streamPath: (model: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  modelsPath: () => string;
  session_header?: string;
  pricing?: ProtocolPricing;
  oauth?: true;
  stream_only?: true;
};

const PROTOCOL_PROFILES: Record<Protocol, ProtocolProfile> = {
  // 四条通用方言协议：全部传输规则沿用方言默认，基址由用户填写。
  'openai-chat': { dialect: 'openai-chat' },
  'openai-responses': { dialect: 'openai-responses' },
  'anthropic-messages': { dialect: 'anthropic-messages' },
  'google-gemini': { dialect: 'google-gemini' },

  /**
   * deepseek：复用 `openai-responses` 方言，只叠加官方基址与分时两档价目。
   * 基址填 `https://api.deepseek.com`（与 DeepSeek LB 的 upstream_base 同一个）。
   */
  deepseek: {
    dialect: 'openai-responses',
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
  },

  /**
   * opencode-go：复用 `openai-chat` 方言，叠加 OpenCode Go 推理面的三条契约：
   *   1. 基址钉死为官方推理面 `https://opencode.ai/inference/go`；
   *   2. 路径自带版本段 `/openai/v1/chat/completions`（清单同在 `/openai/v1/models`）；
   *   3. 每个请求必须带 `x-opencode-session: ses_<64 hex>`（缺了上游回 `400 MissingSessionID`）。
   */
  'opencode-go': {
    dialect: 'openai-chat',
    base_url: 'https://opencode.ai/inference/go',
    path: () => '/openai/v1/chat/completions',
    modelsPath: () => '/openai/v1/models',
    session_header: SESSION_HEADER,
  },

  /**
   * openai-oauth：复用 `openai-responses` 方言，把一份 ChatGPT 订阅接成一条上游
   * （Codex CLI 走的就是这条路）。叠加的只有凭据与传输契约：
   *   1. 基址钉死 `https://chatgpt.com/backend-api/codex`，路径 `/responses`；
   *   2. 请求头由 `oauth.ts` 给：Bearer + `chatgpt-account-id` + `originator: codex_cli_rs`；
   *   3. 凭据是一对 OAuth 令牌（`oauth: true`）：转发前先换新，换完写回库；
   *   4. 上游只认流式（`stream_only: true`）：非流式调用在 Norm 这一侧就被挡住。
   *
   * 已知边界：它的清单端点要一个 `client_version`、回的形状是 `{models:[{slug}]}`——不是
   * 任何一种方言的清单。本版不探它的清单（`modelsPath` 沿用方言默认，问出来就是上游的 400
   * 原话）：选址把清单未知的上游当可用，一次跑错型号会被 `isModelNotServed` 划掉。
   */
  'openai-oauth': {
    dialect: 'openai-responses',
    base_url: 'https://chatgpt.com/backend-api/codex',
    headers: openaiHeaders,
    oauth: true,
    stream_only: true,
  },
};

function resolveProtocol(protocol: Protocol): ResolvedProtocol {
  const profile = PROTOCOL_PROFILES[protocol];
  const codec = dialectCodecFor(profile.dialect);
  return {
    protocol,
    dialect: profile.dialect,
    ...(profile.base_url === undefined ? {} : { base_url: profile.base_url }),
    path: profile.path ?? codec.defaultPath,
    streamPath: profile.streamPath ?? profile.path ?? codec.streamPath,
    headers: profile.headers ?? codec.defaultHeaders,
    modelsPath: profile.modelsPath ?? codec.defaultModelsPath,
    ...(profile.session_header === undefined ? {} : { session_header: profile.session_header }),
    ...(profile.pricing === undefined ? {} : { pricing: profile.pricing }),
    ...(profile.oauth === undefined ? {} : { oauth: profile.oauth }),
    ...(profile.stream_only === undefined ? {} : { stream_only: profile.stream_only }),
  };
}

const RESOLVED_PROTOCOLS: Record<Protocol, ResolvedProtocol> = {
  'openai-chat': resolveProtocol('openai-chat'),
  'openai-responses': resolveProtocol('openai-responses'),
  'anthropic-messages': resolveProtocol('anthropic-messages'),
  'google-gemini': resolveProtocol('google-gemini'),
  deepseek: resolveProtocol('deepseek'),
  'opencode-go': resolveProtocol('opencode-go'),
  'openai-oauth': resolveProtocol('openai-oauth'),
};

/** 取一条上游协议的传输与计价契约（编解码请按 `.dialect` 调 `dialectCodecFor`）。 */
export function protocolFor(protocol: Protocol): ResolvedProtocol {
  return RESOLVED_PROTOCOLS[protocol];
}

/** 一条协议的上游契约（`GET /api/v1/protocols` 的一条）。 */
export function schemaOf(protocol: Protocol): ProtocolSchema {
  const profile = protocolFor(protocol);
  const fixed = profile.base_url ?? null;
  return {
    protocol,
    dialect: profile.dialect,
    base_url: fixed,
    fields: fixed === null ? ['base_url', 'provider_key'] : ['provider_key'],
    oauth: profile.oauth === true,
    stream_only: profile.stream_only === true,
  };
}

/** 全部协议的契约，一次算好：这是「先选协议、再渲染字段」的唯一一份数据。 */
export const PROTOCOL_SCHEMAS: ProtocolSchema[] = PROTOCOLS.map(schemaOf);

/** 这条协议对这个型号的官方价目；null = 这条协议没有自定义定价。 */
export function tariffFor(protocol: Protocol, model: string): Tariff | null {
  const tariffs = protocolFor(protocol).pricing?.tariffs;
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

/** 流式推理路径：由协议契约决定（默认继承其方言的流式路径，如 Gemini 的 `:streamGenerateContent?alt=sse`）。 */
export function streamPathFor(protocol: Protocol, model: string): string {
  return protocolFor(protocol).streamPath(model);
}

export function protocolUrlFor(protocol: Protocol, baseUrl: string, model: string, stream: boolean): string {
  const base = baseUrl.replace(/\/+$/, '');
  const resolved = protocolFor(protocol);
  return `${base}${stream ? resolved.streamPath(model) : resolved.path(model)}`;
}
