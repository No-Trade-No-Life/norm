/**
 * 图像能力（文生图 / 带参考图的生成）的线缆层。
 *
 * 下游只有一种图像线缆：OpenAI 的 `POST /v1/images/generations`。各家 SDK 里只有它把
 * 「给一句话，要一张图」说成公共语言，OpenAI 与所有兼容实现都对齐在这一侧，所以入口不必
 * 有方言参数——图像方言只在上游。
 *
 * 上游目前只有一种图像方言：
 *
 *   openai-image-tool   ChatGPT 订阅（`openai-oauth`）。上游没有 `/images/generations`：
 *                       出图的入口是 Responses 的 `image_generation` 工具，由一条文本模型
 *                       替调用方发起。于是「要一张图」在这里被说成一次只调这个工具的
 *                       Responses 请求，答是一个 SSE 流，图在 `image_generation_call`
 *                       的 `result`（base64）里。
 *
 * 图像不进 `Dialect`：四条文本方言的编解码都是「进门 JSON、出门 JSON」，而这一侧进门是
 * JSON、出门是 SSE、回来又折成 JSON。硬塞进方言联合类型，只会让文本那侧每个分支多一个
 * 与它无关的可能。
 */
import type { ModelInfo } from './codecs';
import { HOST_MODELS } from './hosts';
import { fail } from './http';
import type { Usage } from './pricing';

/** 图像的两类调用：只给一句话，或再带几张参考图（图生图 / 编辑）。 */
export type ImageDialect = 'openai-image-tool';

/** 一次图像调用的规范形式：下游要什么，与上游怎么说无关。 */
export type ImageAsk = {
  model: string;
  prompt: string;
  /** `auto` 或 `WIDTHxHEIGHT`；合法范围由上游定，校验在 `readImageAsk` 里做一次。 */
  size: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  background: 'auto' | 'opaque' | 'transparent';
  outputFormat: 'png' | 'jpeg' | 'webp';
  outputCompression: number;
  moderation: 'auto' | 'low';
  /** 参考图，`data:image/…;base64,…` 形式；最多 4 张。 */
  referenceImages: string[];
};

/** 上游回来的图与它自己报的规格。 */
export type ImageAnswer = {
  /** 每张图的 base64 与上游改写过的那句提示词（没有就不编）。 */
  images: Array<{ b64_json: string; revised_prompt: string | null }>;
  /**
   * 上游回显的**实际**质量与尺寸：请求里写 `auto` 时这两个字段才是真的答案，
   * 算账按它而不是按请求。拿不到就是 null，由调用方按「上界」处理。
   */
  quality: string | null;
  size: string | null;
  /** 宿主模型那一次调用的 token 用量（图的用量不在 token 里，见 `quoteImage`）。 */
  usage: Usage;
};

/** 一种上游图像方言：怎么问、怎么读、能往清单里贡献哪些型号。 */
export type ImageCodec = {
  dialect: ImageDialect;
  /** 这条方言能不能满足这次调用：选址在打出去之前问，问不过的候选不参与。 */
  serves: (ask: ImageAsk) => boolean;
  /**
   * 宿主模型候选：账户不同，能用来「替调用方调工具」的文本模型不同（同一个订阅里
   * 有的型号可达、有的回 `model_not_found`）。按顺序试第一个能用的。
   */
  hostModels: readonly string[];
  /** 规范请求 + 宿主模型 → 上游路径与请求体。 */
  encode: (ask: ImageAsk, hostModel: string) => { path: string; body: string };
  /** 上游的成功应答（SSE 原文）→ 规范应答。 */
  read: (text: string) => ImageAnswer;
  /** 这条方言替上游补进清单的型号（ChatGPT 的清单端点答不上话，型号表在代码里）。 */
  catalog: () => ModelInfo[];
  /** 这条方言钉死的上游路径（相对于协议基址）。 */
  path: string;
};

/** 一次最多带 4 张参考图（上游工具的上限）。 */
export const MAX_REFERENCE_IMAGES = 4;
/** 提示词上限：上游按字符数截断，超过就是一次白跑。 */
export const MAX_IMAGE_PROMPT_CHARS = 32_000;

/**
 * 这条上游支持的图像型号。
 *
 * 型号表写在代码里而不是问上游：ChatGPT 的清单端点要一个 `client_version`、回的形状是
 * `{models:[{slug}]}` 且只列文本型号（实测这个账户回的是空表），问不出图像型号。价目
 * 表（`pricing.ts` 的 `IMAGE_RATES`）是同一批名字——**没有价目的型号在入口就被拒**，
 * 所以「能不能出图」与「按什么算钱」在这里是同一个答案。
 */
export const OPENAI_IMAGE_MODELS = [
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
];

const MODEL_SET = new Set(OPENAI_IMAGE_MODELS);

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 上游的 `size`：`auto` 或 `WIDTHxHEIGHT`，两个数字都是 16 的倍数、边长不超过 3840。 */
function validSize(size: string): boolean {
  if (size === 'auto') return true;
  const match = /^([0-9]+)x([0-9]+)$/.exec(size);
  if (match === null) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false;
  if (width % 16 !== 0 || height % 16 !== 0) return false;
  if (width > 3840 || height > 3840) return false;
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) return false;
  return Math.max(width, height) <= 3 * Math.min(width, height);
}

/**
 * 一张参考图是不是一段合法的 data URL。
 *
 * 只收 base64 的 data URL：上游要的是能直接塞进 `input_image.image_url` 的字符串，接受
 * 一个 http 地址就等于让上游去替我们打一次任意地址，那是另一件事（且无法审计）。
 */
function validReferenceImage(url: string): boolean {
  const comma = url.indexOf(';base64,');
  if (comma < 0) return false;
  const meta = url.slice(0, comma);
  if (!meta.startsWith('data:')) return false;
  const mime = meta.slice('data:'.length);
  if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(mime)) return false;
  return url.length > comma + ';base64,'.length;
}

/**
 * 下游入口：`POST /v1/images/generations` 的 JSON 体 → 规范请求。
 *
 * 校验放在这一层，是为了让「注定失败」的请求在 Norm 这一侧就停住：0 次上游请求、0 笔记账。
 * 每一条拒绝都说清是哪一项、为什么，以及可接受的值——比上游那句 400 原话有用。
 */
export function readImageAsk(rawBody: string): ImageAsk {
  let raw: Record<string, unknown>;
  try {
    raw = recordOf(JSON.parse(rawBody));
  } catch {
    fail(400, 'body_invalid', '图像请求必须是 JSON');
  }

  const model = textOf(raw.model);
  if (model === '') fail(400, 'model_required', '图像请求缺少 model 字段（如 gpt-image-2）');

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt === '') fail(400, 'image_prompt_required', '图像请求缺少 prompt');
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    fail(413, 'image_prompt_too_long', `提示词最多 ${MAX_IMAGE_PROMPT_CHARS} 个字符，这次是 ${prompt.length}`);
  }

  // 一次只画一张：上游的工具一次调出一张，`n` 大于 1 只能靠多调几次，而那是「按请求
  // 排队」的事，不该混进一次调用里假装它是一张图的价格。
  if (raw.n !== undefined && raw.n !== 1) {
    fail(400, 'image_n_unsupported', '一次图像生成只画一张：请去掉 n，或让 n = 1');
  }
  if (raw.stream === true) {
    fail(400, 'image_stream_unsupported', '图像入口不支持流式：上游一次性交出整张图，请去掉 stream');
  }
  if (raw.response_format !== undefined && raw.response_format !== 'b64_json') {
    fail(400, 'image_response_format_unsupported', 'response_format 只支持 b64_json（图不在本站存储里）');
  }

  const size = raw.size === undefined ? 'auto' : textOf(raw.size);
  if (!validSize(size)) {
    fail(400, 'image_size_invalid', `size 只接受 auto 或 WIDTHxHEIGHT（边长为 16 的倍数、不超过 3840、宽高比不超过 3:1），这次是 ${size}`);
  }

  const quality = raw.quality === undefined ? 'auto' : textOf(raw.quality);
  if (!['auto', 'low', 'medium', 'high'].includes(quality)) {
    fail(400, 'image_quality_invalid', `quality 只接受 auto / low / medium / high，这次是 ${quality}`);
  }

  const background = raw.background === undefined ? 'auto' : textOf(raw.background);
  if (!['auto', 'opaque', 'transparent'].includes(background)) {
    fail(400, 'image_background_invalid', `background 只接受 auto / opaque / transparent，这次是 ${background}`);
  }

  const outputFormat = raw.output_format === undefined ? 'png' : textOf(raw.output_format);
  if (!['png', 'jpeg', 'webp'].includes(outputFormat)) {
    fail(400, 'image_output_format_invalid', `output_format 只接受 png / jpeg / webp，这次是 ${outputFormat}`);
  }

  let outputCompression = 100;
  if (raw.output_compression !== undefined) {
    const value = raw.output_compression;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      fail(400, 'image_output_compression_invalid', 'output_compression 只接受 0-100 的整数');
    }
    outputCompression = value;
  }

  const moderation = raw.moderation === undefined ? 'auto' : textOf(raw.moderation);
  if (!['auto', 'low'].includes(moderation)) {
    fail(400, 'image_moderation_invalid', `moderation 只接受 auto / low，这次是 ${moderation}`);
  }

  const referenceImages: string[] = [];
  if (raw.reference_images !== undefined) {
    if (!Array.isArray(raw.reference_images)) {
      fail(400, 'image_reference_invalid', 'reference_images 必须是 data URL 字符串数组');
    }
    if (raw.reference_images.length > MAX_REFERENCE_IMAGES) {
      fail(400, 'image_reference_too_many', `reference_images 最多 ${MAX_REFERENCE_IMAGES} 张`);
    }
    for (const item of raw.reference_images) {
      const url = typeof item === 'string' ? item : '';
      if (!validReferenceImage(url)) {
        fail(400, 'image_reference_invalid', 'reference_images 只接受 PNG / JPEG / WEBP / GIF 的 base64 data URL');
      }
      referenceImages.push(url);
    }
  }

  return {
    model,
    prompt,
    size,
    quality: quality as ImageAsk['quality'],
    background: background as ImageAsk['background'],
    outputFormat: outputFormat as ImageAsk['outputFormat'],
    outputCompression,
    moderation: moderation as ImageAsk['moderation'],
    referenceImages,
  };
}

/** 让宿主模型只做一件事：把调用方的提示词原样搬进工具参数，别自己改写。 */
const INSTRUCTIONS =
  "You are an image generator. You MUST call image_generation exactly once and return only that tool call. Mirror the user's request verbatim into the prompt argument.";

const openaiImageTool: ImageCodec = {
  dialect: 'openai-image-tool',
  // 型号表与价目表是同一个集合：认得的型号才进来，认不得的在入口就拒了。
  serves: (ask) => MODEL_SET.has(ask.model),
  hostModels: HOST_MODELS,
  path: '/responses',
  encode: (ask, hostModel) => {
    const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: ask.prompt }];
    for (const url of ask.referenceImages) {
      content.push({ type: 'input_image', image_url: url, detail: 'auto' });
    }
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      model: ask.model,
      size: ask.size,
      quality: ask.quality,
      background: ask.background,
      output_format: ask.outputFormat,
      moderation: ask.moderation,
    };
    // 压缩只对真有损的格式有意义：PNG 收这个字段会被上游拒，索性不发。
    if (ask.outputFormat !== 'png') tool.output_compression = ask.outputCompression;
    return {
      path: '/responses',
      body: JSON.stringify({
        model: hostModel,
        instructions: INSTRUCTIONS,
        input: [{ type: 'message', role: 'user', content }],
        tools: [tool],
        tool_choice: { type: 'image_generation' },
        // 上游只认流式（与文本那条同一个契约），图在事件流里回来。
        stream: true,
        store: false,
      }),
    };
  },
  read: (text) => readImageStream(text),
  catalog: () =>
    OPENAI_IMAGE_MODELS.map((id) => ({
      id,
      owned_by: 'openai',
      // 吃文字（以及参考图）吐图：模态是这条能力自己的事实。
      modalities: { input: ['text', 'image'], output: ['image'] },
    })),
};

const IMAGE_CODECS: Record<ImageDialect, ImageCodec> = {
  'openai-image-tool': openaiImageTool,
};

/** 取一条上游图像方言的编解码（与文本 `.dialect → dialectCodecFor` 同一个思路）。 */
export function imageCodecFor(dialect: ImageDialect): ImageCodec {
  return IMAGE_CODECS[dialect];
}

/**
 * 从响应事件流里读图。
 *
 * 图出现在两处，按优先级取：`response.output_item.done` 里那一项（最完整，带上游改写的
 * 提示词与实际尺寸），以及 `response.completed` 的 `response.output` 数组（有的上游只在
 * 收尾帧里给全）。一个都取不到就是一次失败，原因要从上游的原话里凑出来——「200 + 空白」
 * 是这条路上最难查的一种败法。
 */
export function readImageStream(text: string): ImageAnswer {
  const images: ImageAnswer['images'] = [];
  let usage: Usage = { input: 0, cached: 0, output: 0 };
  let quality: string | null = null;
  let size: string | null = null;
  let eventCount = 0;
  let lastEvent: string | null = null;
  let upstreamError: string | null = null;
  let completedOutput: unknown[] = [];

  const noteUsage = (value: unknown) => {
    const usageRecord = recordOf(value);
    if (Object.keys(usageRecord).length === 0) return;
    const input = Number(usageRecord.input_tokens);
    const output = Number(usageRecord.output_tokens);
    const cached = Number(recordOf(usageRecord.input_tokens_details).cached_tokens);
    usage = {
      input: Number.isFinite(input) ? Math.max(input, 0) : usage.input,
      cached: Number.isFinite(cached) ? Math.max(cached, 0) : usage.cached,
      output: Number.isFinite(output) ? Math.max(output, 0) : usage.output,
    };
  };

  const noteError = (event: Record<string, unknown>) => {
    if (upstreamError !== null) return;
    const candidates = [
      recordOf(event.error).message,
      recordOf(recordOf(event.response).error).message,
      recordOf(recordOf(event.response).incomplete_details).reason,
      recordOf(event.item).refusal,
      recordOf(recordOf(event.item).error).message,
      // 有的上游把原因直接摊在事件顶上（`{"type":"error","message":"…"}`）。
      event.message,
    ];
    for (const candidate of candidates) {
      const message = textOf(candidate);
      if (message !== '') {
        upstreamError = message;
        return;
      }
    }
  };

  const takeItem = (item: unknown) => {
    const record = recordOf(item);
    if (record.type !== 'image_generation_call') return;
    const result = typeof record.result === 'string' ? record.result : '';
    if (result === '') return;
    images.push({ b64_json: result, revised_prompt: textOf(record.revised_prompt) || null });
    const echoedQuality = textOf(record.quality);
    if (echoedQuality !== '') quality = echoedQuality;
    const echoedSize = textOf(record.size);
    if (echoedSize !== '') size = echoedSize;
  };

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = recordOf(JSON.parse(payload));
    } catch {
      continue;
    }
    eventCount += 1;
    const type = textOf(event.type);
    if (type !== '') lastEvent = type;
    noteError(event);
    noteUsage(event.usage);
    noteUsage(recordOf(event.response).usage);
    if (type === 'response.output_item.done') takeItem(event.item);
    if (type === 'response.completed') {
      const output = recordOf(event.response).output;
      if (Array.isArray(output)) completedOutput = output;
    }
  }

  // `output_item.done` 一个都没有时，收尾帧里的那份是唯一的来源。
  if (images.length === 0) for (const item of completedOutput) takeItem(item);

  if (images.length === 0) {
    const detail = upstreamError === null ? '' : ` 上游的原话：${upstreamError}。`;
    const summary =
      lastEvent === null
        ? '上游的响应里没有可读的图像事件。'
        : `最后一条事件是 ${lastEvent}，整段响应里有 ${eventCount} 条可读事件。`;
    fail(502, 'image_data_missing', `图像生成失败：上游没有返回图。${detail}${summary}`);
  }

  return { images, quality, size, usage };
}
