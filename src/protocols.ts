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
import type { AudioDialect, AudioKind } from './audio';
import type { SearchDialect } from './search';
import type { ImageDialect } from './images';
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

export type Protocol = Dialect | 'deepseek' | 'opencode-go' | 'openai-oauth' | 'openai-audio' | 'qwen';

export const PROTOCOLS: Protocol[] = [
  ...DIALECTS,
  'deepseek',
  'opencode-go',
  'openai-oauth',
  'openai-audio',
  'qwen',
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
  /**
   * 这条协议能接的音频调用。空数组 = 这条上游没有音频能力，`/v1/audio/*` 不会选它。
   * 音频入口只有一种线缆（OpenAI 的 `/v1/audio/*`），所以这里只说「能不能」，不说「说哪种方言」。
   */
  audio: AudioKind[];
  /**
   * 这条协议能不能接图像生成（`/v1/images/generations`）。与 `audio` 同一个口径：
   * 入口只有一种线缆（OpenAI 的 Images），这里只说「能不能」，不说「说哪种方言」。
   */
  image: boolean;
  /**
   * 这条协议的上游自带搜索能力（`POST /v1/web-search` 会不会选它）。
   *
   * 与 `audio` / `image` 同一个口径：入口只有一种线缆，这里只说「能不能」，不说「说哪条
   * 方言」——方言是上游自己的事。
   */
  search: boolean;
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
  /**
   * 这条协议的上游音频方言：`openai-audio` 原样转发、`qwen-native` 走 Qwen 原生接口。
   * 不写 = 这条上游没有音频能力。方言名而不是编解码函数，与 `dialect` 同一条纪律：
   * 编解码只能活在 `audio.ts` 里。
   */
  audio?: AudioDialect;
  /**
   * 这条协议的上游搜索方言（见 `src/search.ts`）：`/v1/web-search` 只在声明了它的上游里选址。
   *
   * 不写 = 这条上游搜不了。存的是**方言名**而不是一个布尔：搜索是对外一条线缆、对内可以
   * 有多种实现的事（今天是 DeepSeek 的 Search API，将来任何搜索引擎都能包成同一条方言），
   * 与 `audio` 存方言名同一个道理——编解码只能活在 `search.ts` 里。
   *
   * 它挂在协议上、不挂在模型上：搜索不跑模型，没有 token，也没有「这次用哪个型号」可问。
   */
  search?: SearchDialect;
  /**
   * 这条协议的上游图像方言（见 `src/images.ts`）。不写 = 这条上游没有图像能力，
   * `/v1/images/generations` 不会选它。与 `audio` 同一条纪律：方言名而不是编解码函数。
   */
  image?: ImageDialect;
  /**
   * 上游只认 `store: false`（同一个端点：带上 `store` 为真、或干脆没写，回
   * `400 Store must be set to false`）。声明在这里，转发层发出去之前补上这一个字段——
   * 它是这条上游的请求契约，不是方言翻译。
   */
  store_false?: true;
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
  store_false?: true;
  audio?: AudioDialect;
  image?: ImageDialect;
  search?: SearchDialect;
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
    // 同一条基址上还挂着 Search API（`/v1/tools/search`）：搜索不走模型，直连就是一次调用。
    search: 'deepseek-search',
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
   *   1. 请求头由 `oauth.ts` 给：Bearer + `chatgpt-account-id` + `originator: codex_cli_rs`；
   *   2. 凭据是一对 OAuth 令牌（`oauth: true`）：转发前先换新，换完写回库；
   *   3. 上游只认流式（`stream_only: true`）：非流式调用在 Norm 这一侧就被挡住。
   *
   * 基址钉死为官方那一个：没有第二个合法的 ChatGPT 订阅地址，让人填只是把「该不该有出口」
   * 这个决定混进地址里。出站问题由另一维解决——`proxy_url`（`src/tunnel.ts`）：Worker 的
   * `fetch` 会在出站请求上盖 `cf-worker` / `cf-connecting-ip`，chatgpt.com 见到直接回 403
   * 一页 HTML（实测：直连 200、从边缘出去 403、换成真实 IP 也一样），隧道里的字节由代理
   * 重新发出，这些头不存在。所以「打给谁」是协议的常量，「从哪儿出去」是这条上游的配置。
   *
   * 4. 它也是唯一一条能出图的订阅上游（`image: 'openai-image-tool'`）：ChatGPT 没有
   *    `/images/generations`，出图走 Responses 的 `image_generation` 工具——宿主模型与
   *    事件流的读法都在 `src/images.ts` 里。
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
    store_false: true,
    image: 'openai-image-tool',
  },

  /**
   * openai-audio：把一条**已经说 OpenAI 音频**的上游接进来（Qwen LB、OpenAI、任何兼容实现）。
   * 零翻译复用 `openai-audio` 方言：`{base}/audio/transcriptions` 与 `{base}/audio/speech`
   * 两个端点原样转发，基址由用户填——这正是 Qwen LB 接进 NormAI 的那种接法，只是换了入口。
   * `dialect` 声明 `openai-chat`：同一个基址上的 `/chat/completions` 也归它（OpenAI 就是这样），
   * 只提供音频的上游（Qwen LB）在文本调用上会回它自己的 404，原话交回去。
   */
  'openai-audio': {
    dialect: 'openai-chat',
    audio: 'openai-audio',
  },

  /**
   * qwen：阿里云百炼。一条协议上挂着两处能力，各有各的路径：
   *   1. 文本与视觉走 OpenAI 兼容层（`/compatible-mode/v1`），零翻译复用 `openai-chat`
   *      方言——`image_url` / `video_url` 内容块按原始字节透传，多模态输入不需要 Norm 认识它；
   *   2. 转写与合成走原生接口（`audio: 'qwen-native'`），因为兼容层根本没有
   *      `/audio/transcriptions`：`qwen-audio-3.0-asr-flash` 只认原生多模态生成。
   *
   * 基址钉死为百炼的根，路径按能力分别给：兼容层带版本段，原生接口自带 `/api/v1`。
   * 音频型号与价目在 `qwen.ts` 与 `pricing.ts` 里，跟着代码进构建哈希。
   */
  qwen: {
    dialect: 'openai-chat',
    base_url: 'https://dashscope.aliyuncs.com',
    path: () => '/compatible-mode/v1/chat/completions',
    modelsPath: () => '/compatible-mode/v1/models',
    audio: 'qwen-native',
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
    ...(profile.store_false === undefined ? {} : { store_false: profile.store_false }),
    ...(profile.audio === undefined ? {} : { audio: profile.audio }),
    ...(profile.image === undefined ? {} : { image: profile.image }),
    ...(profile.search === undefined ? {} : { search: profile.search }),
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
  'openai-audio': resolveProtocol('openai-audio'),
  qwen: resolveProtocol('qwen'),
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
    audio: profile.audio === undefined ? [] : ['transcriptions', 'speech'],
    image: profile.image !== undefined,
    search: profile.search !== undefined,
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
