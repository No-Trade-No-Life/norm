import { afterEach, describe, expect, it, vi } from 'vitest';

import { audioCodecFor, readSpeechAsk, readTranscriptionAsk } from '../src/audio';
import { receiptHeaders } from '../src/routes/billing';
import { audioRateFor, quoteAudio, ZERO_AUDIO_USAGE } from '../src/pricing';
import {
  audioFormatOf,
  QWEN_AUDIO_MODELS,
  qwenSpeechRequest,
  qwenTranscriptionBody,
  readQwenSpeech,
  readQwenTranscription,
} from '../src/qwen';

describe('Qwen 的原生音频接口（Qwen LB 那一层适配）', () => {
  it('格式：MIME 与扩展名都认得，认不出就交回 null', () => {
    expect(audioFormatOf('audio/wav', 'clip.bin')).toBe('wav');
    expect(audioFormatOf('audio/mpeg', 'clip')).toBe('mp3');
    expect(audioFormatOf('audio/x-m4a', 'clip')).toBe('m4a');
    expect(audioFormatOf('application/octet-stream', 'clip.webm')).toBe('webm');
    expect(audioFormatOf('video/mp4', 'clip.mov')).toBe('mov');
    expect(audioFormatOf('application/octet-stream', 'clip.unknown')).toBeNull();
  });

  it('转写请求：音频折成 data URI 进 input_audio，语言只在上游认得出时带', () => {
    const body = qwenTranscriptionBody({
      model: 'qwen-audio-3.0-asr-flash',
      format: 'wav',
      language: 'zh',
      mime: 'audio/wav',
      audioBase64: 'AAAA',
    }) as Record<string, any>;
    expect(body.model).toBe('qwen-audio-3.0-asr-flash');
    expect(body.parameters).toEqual({ format: 'wav', language_hints: ['zh'] });
    expect(body.input.messages[0].content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: 'data:audio/wav;base64,AAAA' },
    });

    // `auto` 与空值都不带 language_hints：让上游自己认，不替它猜。
    const auto = qwenTranscriptionBody({
      model: 'm',
      format: 'wav',
      language: 'auto',
      mime: 'audio/wav',
      audioBase64: 'AAAA',
    }) as Record<string, any>;
    expect(auto.parameters).toEqual({ format: 'wav' });
  });

  it('合成的两条原生接口由型号的调用方式决定，与计价无关', () => {
    const multi = qwenSpeechRequest({ surface: 'generation', model: 'qwen3-tts-flash', input: '你好', voice: 'Cherry' });
    expect(multi.path).toBe('/api/v1/services/aigc/multimodal-generation/generation');
    expect(multi.body).toEqual({ model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry' } });

    const synth = qwenSpeechRequest({ surface: 'synthesizer', model: 'cosyvoice-v3.5-flash', input: '你好', voice: 'v' });
    expect(synth.path).toBe('/api/v1/services/audio/tts/SpeechSynthesizer');
    expect(synth.body).toEqual({
      model: 'cosyvoice-v3.5-flash',
      input: { text: '你好', voice: 'v', format: 'wav', sample_rate: 24000 },
    });
  });

  it('转写应答：文本来自 output.text，时长来自 usage.duration；没报时长就是 null', () => {
    expect(readQwenTranscription({ output: { text: '你好世界' }, usage: { duration: 2.5 } })).toEqual({
      text: '你好世界',
      seconds: 2.5,
    });
    expect(readQwenTranscription({ output: { text: '嗯' } })).toEqual({ text: '嗯', seconds: null });
    expect(readQwenTranscription({ output: {} })).toEqual({ text: '', seconds: null });
  });

  it('合成应答：音频地址 + 两种计价方式的用量都读出来', () => {
    expect(
      readQwenSpeech({
        output: { audio: { url: 'https://oss.example/a.wav' } },
        usage: { characters: 12 },
      }),
    ).toEqual({ audioUrl: 'https://oss.example/a.wav', characters: 12, inputTokens: 0, outputTokens: 0 });
    expect(
      readQwenSpeech({
        output: { audio: { url: 'https://oss.example/a.wav' } },
        usage: { input_tokens: 7, output_tokens: 108 },
      }),
    ).toEqual({ audioUrl: 'https://oss.example/a.wav', characters: 0, inputTokens: 7, outputTokens: 108 });
    expect(readQwenSpeech({ output: {} })).toEqual({ audioUrl: '', characters: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('音频型号表：转写只有一条原生接口，合成按型号分两条', () => {
    expect(QWEN_AUDIO_MODELS.filter((row) => row.kind === 'transcriptions').every((row) => row.surface === 'generation')).toBe(
      true,
    );
    expect(QWEN_AUDIO_MODELS.map((row) => row.match)).toContain('cosyvoice-v3.5-plus');
  });
});

describe('回执头：文本与音频同一套', () => {
  it('四个头把这次的钱与请求 ID 说全', () => {
    const headers = receiptHeaders({
      request_id: 'r1', fee_nanos: 80390, gas_fee_nanos: 4000, gas_billed_nanos: 4000,
      token_nanos: 76390, token_billed_nanos: 76390, input_tokens: 0, cached_tokens: 0,
      output_tokens: 0, audio_ms: 2500, audio_characters: 0, image_count: 0, image_pixels: 0,
      unbilled_nanos: 0,
      balance_nanos: null, latency_ms: 820, host: 'h', pool: false,
    });
    expect(headers).toEqual({
      'X-Norm-Request-Id': 'r1',
      'X-Norm-Fee-Nanos': '80390',
      'X-Norm-Gas-Billed-Nanos': '4000',
      'X-Norm-Token-Billed-Nanos': '76390',
    });
  });
});

describe('上游音频方言', () => {
  it('qwen-native 只接自己表里的型号，而且类型要对得上', () => {
    const qwen = audioCodecFor('qwen-native');
    expect(qwen.serves({ kind: 'transcriptions', model: 'qwen-audio-3.0-asr-flash', language: null, file: {} as any })).toBe(
      true,
    );
    // 拿合成的型号去转写：这条路不存在，不能让它打出去换来一句看不懂的 400。
    expect(qwen.serves({ kind: 'transcriptions', model: 'qwen3-tts-flash', language: null, file: {} as any })).toBe(false);
    expect(qwen.serves({ kind: 'speech', model: 'qwen3-tts-flash', input: 'x', voice: 'Cherry' })).toBe(true);
    expect(qwen.serves({ kind: 'speech', model: 'gpt-4o-mini-tts', input: 'x', voice: 'alloy' })).toBe(false);
  });

  it('openai-audio 什么都接：请求体原样转发', () => {
    const passthrough = audioCodecFor('openai-audio');
    const wire = { contentType: 'application/json', body: '{"model":"m","input":"hi","voice":"v"}' };
    expect(passthrough.serves({ kind: 'speech', model: 'anything', input: 'hi', voice: 'v' })).toBe(true);
    expect(passthrough.encode({ kind: 'speech', model: 'anything', input: 'hi', voice: 'v' }, wire)).toEqual({
      path: '/audio/speech',
      wire,
    });
  });

  it('qwen-native 的清单：音频型号带 audio 模态，音频调用才选得中它', () => {
    const items = audioCodecFor('qwen-native').catalog();
    const asr = items.find((item) => item.id === 'qwen-audio-3.0-asr-flash');
    const tts = items.find((item) => item.id === 'qwen3-tts-flash');
    expect(asr?.modalities).toEqual({ input: ['audio'], output: ['text'] });
    expect(tts?.modalities).toEqual({ input: ['text'], output: ['audio'] });
    expect(audioCodecFor('openai-audio').catalog()).toEqual([]);
  });
});

describe('音频计价：秒 / 字符 / token 三种单位', () => {
  it('转写按秒：毫秒 × 每秒单价', () => {
    const quote = quoteAudio('qwen-audio-3.0-asr-flash', { ...ZERO_AUDIO_USAGE, milliseconds: 2500 });
    expect(quote).toEqual({ match: 'qwen-audio-3.0-asr-flash', unit: 'second', nanos: 76_390 });
  });

  it('合成按字符：字符数 × 每字单价', () => {
    const quote = quoteAudio('qwen3-tts-flash', { ...ZERO_AUDIO_USAGE, characters: 9 });
    expect(quote).toEqual({ match: 'qwen3-tts-flash', unit: 'character', nanos: 99_999 });
  });

  it('合成按 token：输入输出各按自己的单价（纳美元 / 1M token）', () => {
    const quote = quoteAudio('qwen-audio-3.1-tts-flash', { ...ZERO_AUDIO_USAGE, input: 1_000_000, output: 1_000_000 });
    expect(quote).toEqual({
      match: 'qwen-audio-3.1-tts-flash',
      unit: 'token',
      nanos: 208_333_333 + 1_666_666_667,
    });
  });

  it('音频没有兜底价：认不出型号就不报价，转发之前就该拒', () => {
    expect(audioRateFor('totally-unknown-audio-model')).toBeNull();
    expect(quoteAudio('totally-unknown-audio-model', { ...ZERO_AUDIO_USAGE, milliseconds: 1000 })).toBeNull();
  });

  it('前缀匹配最长优先：mini 转写不会按大号的价算', () => {
    expect(audioRateFor('gpt-4o-mini-transcribe-2026-01-01')?.match).toBe('gpt-4o-mini-transcribe');
    expect(audioRateFor('tts-1-hd')?.unit).toBe('character');
  });
});

describe('音频入口：把下游那两种形状读成规范请求', () => {
  it('转写：multipart 里读 file / model / language，原始字节留给直通方言', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'clip.wav', { type: 'audio/wav' }));
    form.set('model', 'qwen-audio-3.0-asr-flash');
    form.set('language', 'zh');
    const request = new Request('https://norm.ntl.io/v1/audio/transcriptions', { method: 'POST', body: form });

    const { ask, wire } = await readTranscriptionAsk(request);
    expect(ask).toEqual({
      kind: 'transcriptions',
      model: 'qwen-audio-3.0-asr-flash',
      language: 'zh',
      file: { bytes: new Uint8Array([1, 2, 3, 4]), filename: 'clip.wav', mime: 'audio/wav' },
    });
    // 直通方言发出去的必须是客户端送来的那一段 multipart，不是我们重拼的一份。
    expect((wire.body as ArrayBuffer).byteLength).toBeGreaterThan(0);
    expect(wire.contentType).toContain('multipart/form-data');
  });

  it('转写：缺 file 或 model 直接 400，不打上游', async () => {
    const noFile = new Request('https://norm.ntl.io/v1/audio/transcriptions', { method: 'POST', body: new FormData() });
    await expect(readTranscriptionAsk(noFile)).rejects.toThrow(/file/);

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1])], 'a.wav', { type: 'audio/wav' }));
    const noModel = new Request('https://norm.ntl.io/v1/audio/transcriptions', { method: 'POST', body: form });
    await expect(readTranscriptionAsk(noModel)).rejects.toThrow(/model/);
  });

  it('合成：三个字段缺一不可', () => {
    expect(() => readSpeechAsk({ rawBody: '{"model":"m","input":"hi"}', contentType: 'application/json' })).toThrow(/voice/);
    expect(() => readSpeechAsk({ rawBody: '{"model":"m","voice":"v"}', contentType: 'application/json' })).toThrow(/input/);
    expect(
      readSpeechAsk({ rawBody: '{"model":"m","input":"hi","voice":"v"}', contentType: 'application/json' }).ask,
    ).toEqual({ kind: 'speech', model: 'm', input: 'hi', voice: 'v' });
  });
});

describe('qwen-native 读合成应答：音频要再下载一次', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把上游给的地址下载成字节，用量按型号的计价方式读', async () => {
    const downloaded = new Uint8Array([82, 73, 70, 70]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(downloaded, { headers: { 'Content-Type': 'audio/wav' } })),
    );

    const answer = await audioCodecFor('qwen-native').read(
      { kind: 'speech', model: 'qwen3-tts-flash', input: '你好', voice: 'Cherry' },
      Response.json({ output: { audio: { url: 'https://oss.example/a.wav' } }, usage: { characters: 2 } }),
    );

    expect(answer).toEqual({
      kind: 'speech',
      audio: downloaded,
      contentType: 'audio/wav',
      usage: { ...ZERO_AUDIO_USAGE, characters: 2 },
    });
  });

  it('上游没给音频地址：502，交回一句能查的话', async () => {
    await expect(
      audioCodecFor('qwen-native').read(
        { kind: 'speech', model: 'qwen3-tts-flash', input: '你好', voice: 'Cherry' },
        Response.json({ output: {} }),
      ),
    ).rejects.toThrow(/音频地址/);
  });
});
