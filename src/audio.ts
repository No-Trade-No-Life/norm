/**
 * 音频能力（转写 / 合成）的线缆层。
 *
 * 下游只有**一种**音频线缆：OpenAI 的 `/v1/audio/transcriptions` 与 `/v1/audio/speech`。
 * 四家 SDK 里只有它把这件事件说成公共语言，Qwen LB 与 NormAI 也都对齐在它这一侧，
 * 所以入口不必有方言参数——音频的方言只在上游。
 *
 * 上游有两种音频方言：
 *
 *   openai-audio  上游自己就说 OpenAI 音频（Qwen LB、OpenAI、任何兼容实现）：请求体原样转发，
 *                 应答原样回来。零翻译，和文本那四条通用方言协议同一个思路。
 *   qwen-native   Qwen 原生接口（多模态生成 / 语音合成器）：由 `qwen.ts` 构造请求、归一化应答，
 *                 即 Qwen LB 那层适配逻辑。它换来的是一件原生接口不会白给的事——转写。
 *
 * 音频不进 `Dialect`：那种编解码是「请求体是 JSON、响应体是 JSON」的形状，音频这边一个入口是
 * multipart + 二进制、另一个入口回的是一段 WAV 字节。硬塞进四条方言的联合类型，只会让文本
 * 那侧每一个分支都多出一个与它无关的可能。
 */
import type { ModelInfo } from './codecs';
import { fail } from './http';
import { ZERO_AUDIO_USAGE, type AudioUsage } from './pricing';
import {
  audioFormatOf,
  QWEN_AUDIO_MODELS,
  qwenAudioModelOf,
  qwenSpeechRequest,
  qwenTranscriptionBody,
  readQwenSpeech,
  readQwenTranscription,
} from './qwen';

/** 音频的两类调用：听写（音频→文本）与合成（文本→音频）。 */
export type AudioKind = 'transcriptions' | 'speech';

/** 上游说哪一种音频方言。 */
export type AudioDialect = 'openai-audio' | 'qwen-native';

/**
 * 一次音频调用的规范形式（Hub）：下游到底要什么，与上游怎么说不相干。
 *
 * 转写带音频字节与它的身份（文件名、MIME）：原生方言要把它们折成 data URI，直通方言
 * 则连字节都不碰。合成只有三个字段——Qwen 的两条原生接口都只认这三个。
 */
export type AudioAsk =
  | {
      kind: 'transcriptions';
      model: string;
      language: string | null;
      file: { bytes: Uint8Array; filename: string; mime: string };
    }
  | { kind: 'speech'; model: string; input: string; voice: string };

/** 下游送来的原始字节与它的类型。直通方言把它们一个字节不改地发出去。 */
export type AudioWire = { contentType: string; body: BodyInit };

/** 上游的成功应答，已归一成「客户端要的东西 + 计费要的用量」。 */
export type AudioAnswer =
  | { kind: 'transcriptions'; text: string; usage: AudioUsage }
  | { kind: 'speech'; audio: Uint8Array; contentType: string; usage: AudioUsage };

/** 一种上游音频方言：能不能跑、怎么问、怎么读、能往清单里贡献哪些型号。 */
export type AudioCodec = {
  dialect: AudioDialect;
  /** 这条方言能不能满足这次调用：选址在打出去之前问，问不过的候选不参与。 */
  serves: (ask: AudioAsk) => boolean;
  /** 规范请求 + 下游原始字节 → 上游路径与请求体。 */
  encode: (ask: AudioAsk, wire: AudioWire) => { path: string; wire: AudioWire };
  /** 上游的成功应答 → 规范应答。 */
  read: (ask: AudioAsk, reply: Response) => Promise<AudioAnswer>;
  /** 这条方言能替上游清单补上的型号（原生方言才有；直通方言由上游自己列）。 */
  catalog: () => ModelInfo[];
};

/** 一次转写最多带 24 MiB 音频（与 Qwen LB 同一上限，base64 之后仍在上游限制内）。 */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isFile = (value: unknown): value is File =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as File).arrayBuffer === 'function' &&
  typeof (value as File).name === 'string';

/**
 * 转写入口：`multipart/form-data`，`file` 必填，`model` 必填，`language` 可选
 * （留空或 `auto` 由上游自己认）。
 *
 * 原始字节要先留下来：直通方言（把 Norm 指到 Qwen LB 或 OpenAI 的那种）要把这段 multipart
 * 一个字节不改地发出去，重新拼一遍只会丢掉客户端带来的那些我们没打算理解的字段。
 */
export async function readTranscriptionAsk(request: Request): Promise<{ ask: AudioAsk; wire: AudioWire }> {
  const contentType = request.headers.get('Content-Type') ?? '';
  const body = await request.arrayBuffer();
  const wire: AudioWire = { contentType, body };

  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    fail(400, 'body_invalid', '转写请求必须是 multipart/form-data，并带一个 file 字段');
  }

  const file = form.get('file');
  if (!isFile(file)) fail(400, 'audio_file_required', '转写请求缺少 file 字段');
  if (file.size === 0) fail(400, 'audio_file_empty', 'file 是一段空音频');
  if (file.size > MAX_AUDIO_BYTES) {
    fail(413, 'audio_too_large', `一次转写最多 ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MiB 音频，这次是 ${file.size} 字节`);
  }

  const model = textOf(form.get('model'));
  if (model === '') fail(400, 'model_required', '转写请求缺少 model 字段');

  return {
    ask: {
      kind: 'transcriptions',
      model,
      language: textOf(form.get('language')) || null,
      file: {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        mime: file.type === '' ? 'application/octet-stream' : file.type,
      },
    },
    wire,
  };
}

/** 合成入口：JSON，`input` / `model` / `voice` 三个字段（与 OpenAI 的 `/audio/speech` 同形）。 */
export function readSpeechAsk({ rawBody, contentType }: { rawBody: string; contentType: string }): {
  ask: AudioAsk;
  wire: AudioWire;
} {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    fail(400, 'body_invalid', '合成请求必须是 JSON');
  }

  const model = textOf(raw.model);
  const input = typeof raw.input === 'string' ? raw.input : '';
  const voice = textOf(raw.voice);
  if (model === '') fail(400, 'model_required', '合成请求缺少 model 字段');
  if (input === '') fail(400, 'audio_input_required', '合成请求缺少要念的 input');
  if (voice === '') fail(400, 'audio_voice_required', '合成请求缺少 voice：Qwen 的音色不能留空');

  return {
    ask: { kind: 'speech', model, input, voice },
    wire: { contentType: contentType === '' ? 'application/json' : contentType, body: rawBody },
  };
}

/** 一次音频上游调用失败的原话（状态码 + 响应体），与文本那侧同一个形状。 */
const upstreamJson = async (reply: Response): Promise<Record<string, unknown>> => {
  try {
    return recordOf(await reply.json());
  } catch {
    return {};
  }
};

/**
 * 非负秒数：上游只报了 `usage.seconds`（OpenAI 的转写）或 `duration`（Whisper）时才认，
 * 都没有就是 0——「没报」不等于「报了 0」，但两种情况下这一笔都收不到钱，账本只记事实。
 */
const secondsOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * 直通方言：上游自己就说 OpenAI 音频。
 *
 * 请求体原样转发，应答原样读——转写读 `text` 与用量，合成把字节直接交回去。合成那侧的
 * 字符数只能自己数（OpenAI 不回用量），这正是按字符计价要的那个数。
 */
const openaiAudio: AudioCodec = {
  dialect: 'openai-audio',
  serves: () => true,
  encode: (ask, wire) => ({ path: `/audio/${ask.kind}`, wire }),
  read: async (ask, reply) => {
    if (ask.kind === 'transcriptions') {
      const json = await upstreamJson(reply);
      const text = typeof json.text === 'string' ? json.text : '';
      if (text === '') fail(502, 'upstream_transcription_empty', '上游的转写应答里没有 text 字段');
      const seconds = Math.max(secondsOf(recordOf(json.usage).seconds), secondsOf(json.duration));
      return { kind: 'transcriptions', text, usage: { ...ZERO_AUDIO_USAGE, milliseconds: Math.round(seconds * 1000) } };
    }
    return {
      kind: 'speech',
      audio: new Uint8Array(await reply.arrayBuffer()),
      contentType: reply.headers.get('Content-Type') ?? 'audio/wav',
      usage: { ...ZERO_AUDIO_USAGE, characters: [...ask.input].length },
    };
  },
  catalog: () => [],
};

/** Workers 里没有 Buffer 也要能 base64：分段折字符串，别一次展开几千万个参数。 */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/**
 * Qwen 原生方言：把 OpenAI 音频翻成百炼的原生接口，再把应答归一回来。
 *
 * 三件事与 Qwen LB 逐一对应：转写走多模态生成（`input_audio` data URI）；合成按型号行
 * 的「调用方式」走多模态生成或语音合成器；合成的应答给的是一个临时地址，音频要再下载一次。
 */
const qwenNative: AudioCodec = {
  dialect: 'qwen-native',
  serves: (ask) => qwenAudioModelOf(ask.model)?.kind === ask.kind,
  encode: (ask, wire) => {
    if (ask.kind === 'speech') {
      const row = qwenAudioModelOf(ask.model);
      if (row === null) fail(400, 'audio_model_unpriced', `${ask.model} 不在 Qwen 音频型号表里`);
      const { path, body } = qwenSpeechRequest({ surface: row.surface, model: ask.model, input: ask.input, voice: ask.voice });
      return { path, wire: { contentType: 'application/json', body: JSON.stringify(body) } };
    }
    const format = audioFormatOf(ask.file.mime, ask.file.filename);
    if (format === null) {
      fail(400, 'audio_format_unsupported', `认不出这段音频的格式（${ask.file.mime || ask.file.filename}）：请声明 audio/* 的 MIME 或用常见扩展名`);
    }
    const body = qwenTranscriptionBody({
      model: ask.model,
      format,
      language: ask.language,
      mime: ask.file.mime,
      audioBase64: base64Of(ask.file.bytes),
    });
    // 转写只有一条原生接口，路径由 `qwenSpeechRequest` 之外的这一支单独给出。
    return { path: '/api/v1/services/aigc/multimodal-generation/generation', wire: { contentType: 'application/json', body: JSON.stringify(body) } };
  },
  read: async (ask, reply) => {
    const json = await upstreamJson(reply);
    if (ask.kind === 'transcriptions') {
      const { text, seconds } = readQwenTranscription(json);
      if (text === '') fail(502, 'upstream_transcription_empty', '上游的转写应答里没有文本');
      return {
        kind: 'transcriptions',
        text,
        usage: { ...ZERO_AUDIO_USAGE, milliseconds: Math.round((seconds ?? 0) * 1000) },
      };
    }
    const { audioUrl, characters, inputTokens, outputTokens } = readQwenSpeech(json);
    if (audioUrl === '') fail(502, 'upstream_speech_empty', '上游的合成应答里没有音频地址');
    // ASSUMPTION: 这个地址是上游自己的对象存储，不是客户端能左右的目标。
    // 取错了只会得到一次 502 与一句「音频下载失败」，不改任何账目（这一笔按未成功记账）。
    const download = await fetch(audioUrl);
    if (!download.ok) fail(502, 'audio_download_failed', `合成结果下载失败：上游回 ${download.status}`);
    return {
      kind: 'speech',
      audio: new Uint8Array(await download.arrayBuffer()),
      contentType: download.headers.get('Content-Type') ?? 'audio/wav',
      usage: { ...ZERO_AUDIO_USAGE, characters, input: inputTokens, output: outputTokens },
    };
  },
  catalog: () =>
    QWEN_AUDIO_MODELS.map(({ match, kind }) => ({
      id: match,
      owned_by: 'qwen',
      // 转写吃音频吐文本，合成吃文本吐音频：模态是这两个端点自己的事实。
      modalities: kind === 'transcriptions' ? { input: ['audio'], output: ['text'] } : { input: ['text'], output: ['audio'] },
    })),
};

const AUDIO_CODECS: Record<AudioDialect, AudioCodec> = {
  'openai-audio': openaiAudio,
  'qwen-native': qwenNative,
};

/** 取一条上游音频方言的编解码（与文本那条 `.dialect → dialectCodecFor` 同一个思路）。 */
export function audioCodecFor(dialect: AudioDialect): AudioCodec {
  return AUDIO_CODECS[dialect];
}
