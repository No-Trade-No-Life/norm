/**
 * Qwen（阿里云百炼 / DashScope）的厂商事实：一条协议要接的几样本事都写在这里。
 *
 * 抄的是 Qwen LB（`~/Projects/Qwen-LB/src/proxy.rs`）——那是这套适配的权威实现：
 * 它的下游是 OpenAI 的音频接口，上游是 Qwen 的原生接口，中间那层「标准请求 → 原生请求
 * → 归一化应答」正是本文件与 `audio.ts` 合起来做的事。唯一的差别是它把每个型号的调用
 * 方式与计价方式存在库里给人配，而 Norm 把它们写在代码里：价目与调用方式是「公开可复现
 * 的转发规则」的一部分，改一行就是一次可被审查的合并。
 *
 * Qwen 的能力分两处：文本与视觉走 OpenAI 兼容层（`/compatible-mode/v1`，图片照
 * `image_url` 内容块原样透传，Norm 一个字段都不碰）；转写与合成走原生接口——官方兼容层
 * **没有** `/audio/transcriptions`，`qwen-audio-3.0-asr-flash` 只认原生多模态生成，
 * 这正是 Qwen LB 存在的理由。
 */
import type { AudioKind } from './audio';
import { longestMatch } from './pricing';

/** 百炼的根。兼容层与原生接口共用这一个主机，只是路径不同。 */
export const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com';

/** OpenAI 兼容推理面：文本 + 视觉（`image_url` / `video_url` 内容块）。 */
export const QWEN_CHAT_PATH = '/compatible-mode/v1/chat/completions';

/** 兼容层的清单端点。它只列兼容层的型号——音频型号由本文件补进清单。 */
export const QWEN_MODELS_PATH = '/compatible-mode/v1/models';

/** 原生多模态生成：转写与 Qwen3-TTS 合成。 */
export const QWEN_GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/** 原生语音合成器（非实时）：CosyVoice 与 Qwen-Audio-TTS。 */
export const QWEN_SPEECH_SYNTHESIZER_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/** 合成走哪条原生接口。与计价方式相互独立（Qwen LB 的「调用方式」）。 */
export type QwenSpeechSurface = 'generation' | 'synthesizer';

/**
 * 一条 Qwen 音频型号的事实。`match` 是模型名前缀，最长匹配优先——带日期的快照名
 * （`qwen3-tts-flash-2026-05-01`）因此不用另起一行，但换个系列就会掉出去。
 */
export type QwenAudioModel = {
  match: string;
  kind: AudioKind;
  /** 转写恒走多模态生成：Qwen 没有第二条转写接口。 */
  surface: QwenSpeechSurface;
};

/**
 * 可调用的音频型号与它们各自的调用方式（数值与 Qwen LB 的设置页同一组）。
 *
 * 不在表里的型号在到达上游之前就被拒：音频没有「兜底价」这回事——按秒与按字符不是同一个
 * 单位，猜错方向会差几个数量级，而账单不能靠猜。加一行就是加一个型号。
 */
export const QWEN_AUDIO_MODELS: QwenAudioModel[] = [
  { match: 'qwen-audio-3.0-asr-flash', kind: 'transcriptions', surface: 'generation' },
  { match: 'qwen3-tts-flash', kind: 'speech', surface: 'generation' },
  { match: 'qwen-audio-3.1-tts-flash', kind: 'speech', surface: 'synthesizer' },
  { match: 'cosyvoice-v3.5-flash', kind: 'speech', surface: 'synthesizer' },
  { match: 'cosyvoice-v3.5-plus', kind: 'speech', surface: 'synthesizer' },
];

/** 这个型号在 Qwen 音频表里是哪一行；不是音频型号就是 null。 */
export function qwenAudioModelOf(model: string): QwenAudioModel | null {
  return longestMatch(QWEN_AUDIO_MODELS, model);
}

/**
 * 音频格式：转写的原生命令要求显式的 `format`，而下游只会给 MIME 与文件名。
 *
 * 先看扩展名（`.mp4` 与 `audio/…` 里没有的那几种靠它），再看 MIME 的子类型；都认不出
 * 就交回 null，由调用方拒绝——拿不准格式时让上游猜，只会得到一句看不懂的 400。
 */
const FORMAT_BY_EXTENSION: Record<string, string> = {
  wav: 'wav',
  mp3: 'mp3',
  mp4: 'mp4',
  m4a: 'm4a',
  ogg: 'ogg',
  opus: 'opus',
  webm: 'webm',
  flac: 'flac',
  aac: 'aac',
  amr: 'amr',
  wma: 'wma',
  mov: 'mov',
  avi: 'avi',
  flv: 'flv',
  wmv: 'wmv',
};

export function audioFormatOf(mime: string, filename: string): string | null {
  const byMime = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (byMime.startsWith('audio/')) {
    const subtype = byMime.slice('audio/'.length);
    // `audio/mpeg` / `audio/x-ms-wma` 这类 MIME 与 Qwen 的格式名不是同一套写法。
    if (subtype === 'mpeg' || subtype === 'mp3') return 'mp3';
    if (subtype === 'x-m4a' || subtype === 'mp4') return 'm4a';
    if (subtype === 'x-ms-wma') return 'wma';
    if (subtype in FORMAT_BY_EXTENSION) return subtype;
  }
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

/** 转写的原生请求体：音频以 data URI 形式进 `input_audio` 内容块（与 Qwen LB 同形）。 */
export function qwenTranscriptionBody({
  model,
  format,
  language,
  mime,
  audioBase64,
}: {
  model: string;
  format: string;
  language: string | null;
  mime: string;
  audioBase64: string;
}): unknown {
  const data = `data:${mime};base64,${audioBase64}`;
  const parameters: Record<string, unknown> = { format };
  if (language !== null && language !== '' && language !== 'auto') parameters.language_hints = [language];
  return {
    model,
    input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }] },
    parameters,
  };
}

/** 合成的原生请求：调用方式决定端点与请求体，计价方式不影响它。 */
export function qwenSpeechRequest({
  surface,
  model,
  input,
  voice,
}: {
  surface: QwenSpeechSurface;
  model: string;
  input: string;
  voice: string;
}): { path: string; body: unknown } {
  if (surface === 'generation') {
    return { path: QWEN_GENERATION_PATH, body: { model, input: { text: input, voice } } };
  }
  return {
    path: QWEN_SPEECH_SYNTHESIZER_PATH,
    body: { model, input: { text: input, voice, format: 'wav', sample_rate: 24000 } },
  };
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** 上游报的时长（秒）：只在是一个非负有限数时才算数，其余一律当「没说」。 */
const secondsOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const countOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/**
 * 转写的上游应答 → 识别文本 + 上游报告的音频秒数。
 *
 * 原生多模态生成的转写应答把文本放在 `output.text`（Qwen LB 只认这一处，实测口径）；
 * `usage.duration` 是这次识别覆盖的音频时长，也是计费的唯一依据。缺了它，文本照回、
 * 时长记 0——「上游没报」与「报了 0」是两件事，但账本上都是没收到钱，不该替它编一个数。
 */
export function readQwenTranscription(json: unknown): { text: string; seconds: number | null } {
  const body = recordOf(json);
  const output = recordOf(body.output);
  const text = typeof output.text === 'string' ? output.text : typeof body.text === 'string' ? body.text : '';
  return { text, seconds: secondsOf(recordOf(body.usage).duration) };
}

/**
 * 合成的上游应答 → 音频地址与用量。
 *
 * 两个数分别来自不同的计价方式：按字符的型号报 `usage.characters`，按 token 的型号报
 * `usage.input_tokens` / `usage.output_tokens`。都读出来、缺的记 0，怎么算钱由价目表说。
 */
export function readQwenSpeech(json: unknown): {
  audioUrl: string;
  characters: number;
  inputTokens: number;
  outputTokens: number;
} {
  const body = recordOf(json);
  const usage = recordOf(body.usage);
  const audioUrl = recordOf(recordOf(body.output).audio).url;
  return {
    audioUrl: typeof audioUrl === 'string' ? audioUrl : '',
    characters: countOf(usage.characters),
    inputTokens: countOf(usage.input_tokens),
    outputTokens: countOf(usage.output_tokens),
  };
}
