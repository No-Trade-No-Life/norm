import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/http';
import { imageCodecFor, OPENAI_IMAGE_MODELS, readImageAsk, readImageStream } from '../src/images';
import { IMAGE_RATES, imageRateFor, quoteImage } from '../src/pricing';
import { protocolFor, schemaOf } from '../src/protocols';

/** 只认这一种失败：状态码 + 错误码，别让一个别的异常混成「校验通过」。 */
function failsWith(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`期望 ${code}，但这次没有失败`);
}

const png = 'data:image/png;base64,iVBORw0KGgo=';

describe('图像入口：把 Image API 的请求读成规范请求', () => {
  it('只给 prompt 与 model 时，其余字段都有明确默认值', () => {
    const ask = readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: '  a red circle  ' }));
    expect(ask).toEqual({
      model: 'gpt-image-2',
      prompt: 'a red circle',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      outputFormat: 'png',
      outputCompression: 100,
      moderation: 'auto',
      referenceImages: [],
    });
  });

  it('prompt / model 缺一不可', () => {
    failsWith(() => readImageAsk('{}'), 'model_required');
    failsWith(() => readImageAsk(JSON.stringify({ model: 'gpt-image-2' })), 'image_prompt_required');
    failsWith(() => readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: '   ' })), 'image_prompt_required');
    failsWith(() => readImageAsk('not json'), 'body_invalid');
  });

  it('一次只画一张：n 只接受 1，流式与 url 形式一律拒', () => {
    const base = { model: 'gpt-image-2', prompt: 'x' };
    failsWith(() => readImageAsk(JSON.stringify({ ...base, n: 2 })), 'image_n_unsupported');
    expect(readImageAsk(JSON.stringify({ ...base, n: 1 })).model).toBe('gpt-image-2');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, stream: true })), 'image_stream_unsupported');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, response_format: 'url' })), 'image_response_format_unsupported');
  });

  it('size 只收 auto 或合法 WIDTHxHEIGHT，不合法就说清规则', () => {
    const ask = readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: 'x', size: '2048x1152' }));
    expect(ask.size).toBe('2048x1152');
    // 边长不是 16 的倍数 / 太窄 / 太小，都是上游的硬规则，在这里先拒。
    failsWith(() => readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: 'x', size: '1000x1000' })), 'image_size_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: 'x', size: '3840x256' })), 'image_size_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: 'x', size: '4096x4096' })), 'image_size_invalid');
  });

  it('枚举字段只认自己声明的那几个值', () => {
    const base = { model: 'gpt-image-2', prompt: 'x' };
    failsWith(() => readImageAsk(JSON.stringify({ ...base, quality: 'xhigh' })), 'image_quality_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, background: 'black' })), 'image_background_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, output_format: 'gif' })), 'image_output_format_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, moderation: 'high' })), 'image_moderation_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, output_compression: 120 })), 'image_output_compression_invalid');
  });

  it('参考图只收 base64 data URL，最多 4 张', () => {
    const base = { model: 'gpt-image-2', prompt: 'x' };
    expect(readImageAsk(JSON.stringify({ ...base, reference_images: [png] })).referenceImages).toEqual([png]);
    failsWith(() => readImageAsk(JSON.stringify({ ...base, reference_images: ['https://example.com/a.png'] })), 'image_reference_invalid');
    failsWith(() => readImageAsk(JSON.stringify({ ...base, reference_images: ['data:text/plain;base64,AAAA'] })), 'image_reference_invalid');
    failsWith(
      () => readImageAsk(JSON.stringify({ ...base, reference_images: [png, png, png, png, png] })),
      'image_reference_too_many',
    );
  });
});

describe('openai-image-tool：说成一次 Responses 请求', () => {
  const codec = imageCodecFor('openai-image-tool');

  it('只认型号表里的型号', () => {
    const ask = readImageAsk(JSON.stringify({ model: 'gpt-image-2', prompt: 'x' }));
    expect(codec.serves(ask)).toBe(true);
    expect(codec.serves({ ...ask, model: 'dall-e-3' })).toBe(false);
    // 型号表与价目表是同一个集合：认得的型号必须都能算出钱。
    for (const model of OPENAI_IMAGE_MODELS) expect(imageRateFor(model)).not.toBeNull();
  });

  it('请求体：宿主模型 + image_generation 工具 + 只许流式、不许落库', () => {
    const ask = readImageAsk(
      JSON.stringify({ model: 'gpt-image-2', prompt: 'a red circle', size: '1024x1024', quality: 'low', reference_images: [png] }),
    );
    const call = codec.encode(ask, 'gpt-6-luna');
    expect(call.path).toBe('/responses');
    const body = JSON.parse(call.body) as Record<string, any>;
    expect(body.model).toBe('gpt-6-luna');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'image_generation' });
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'a red circle' },
      { type: 'input_image', image_url: png, detail: 'auto' },
    ]);
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'low',
    });
    // PNG 不收压缩字段：上游会把它当成非法参数。
    expect(body.tools[0].output_compression).toBeUndefined();
  });

  it('宿主模型有退路：账户之间可达的型号不同', () => {
    expect(codec.hostModels.length).toBeGreaterThan(1);
    expect(codec.hostModels[0]).toBe('gpt-6-luna');
  });
});

describe('读事件流：图在 output_item.done 里，尺寸与质量按上游回显', () => {
  const sse = (events: unknown[]) =>
    events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n`).join('') + 'data: [DONE]\n';

  it('一张图 + 用量 + 回显的尺寸/质量', () => {
    const answer = readImageStream(
      sse([
        { type: 'response.created', response: { id: 'resp_1' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            status: 'completed',
            result: 'iVBORw0KGgo=',
            revised_prompt: 'a red circle, flat vector',
            quality: 'low',
            size: '1024x1024',
          },
        },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 2200, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } } },
        },
      ]),
    );
    expect(answer.images).toEqual([{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'a red circle, flat vector' }]);
    expect(answer.size).toBe('1024x1024');
    expect(answer.quality).toBe('low');
    expect(answer.usage).toEqual({ input: 2200, cached: 100, output: 30 });
  });

  it('只在收尾帧给出图时也能取到', () => {
    const answer = readImageStream(
      sse([
        {
          type: 'response.completed',
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
            output: [{ type: 'image_generation_call', result: 'AAAA', size: '1536x1024' }],
          },
        },
      ]),
    );
    expect(answer.images).toHaveLength(1);
    expect(answer.size).toBe('1536x1024');
  });

  it('没有图就是一次失败，原因要带上游原话与最后一条事件', () => {
    try {
      readImageStream(
        sse([
          { type: 'response.created' },
          { type: 'error', message: 'Your request was rejected by the safety system.' },
          { type: 'response.failed' },
        ]),
      );
      throw new Error('期望失败');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const failure = error as HttpError;
      expect(failure.code).toBe('image_data_missing');
      expect(failure.message).toContain('safety system');
      expect(failure.message).toContain('response.failed');
    }
  });
});

describe('图像计价：按张、按质量、按像素折算', () => {
  it('价目表覆盖同一批型号，认不得的型号没有价', () => {
    expect(IMAGE_RATES.map((rate) => rate.match)).toEqual(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'gpt-image-1']);
    expect(imageRateFor('gpt-image-2')).not.toBeNull();
    // 最长匹配：1.5 不能被 gpt-image-1 那一行吃掉。
    expect(imageRateFor('gpt-image-1.5')?.match).toBe('gpt-image-1.5');
    expect(imageRateFor('gpt-image-1-mini')?.match).toBe('gpt-image-1-mini');
    expect(imageRateFor('gpt-image-1')?.match).toBe('gpt-image-1');
    expect(imageRateFor('dall-e-3')).toBeNull();
  });

  it('一张 1K 方图按档收费，多张相乘', () => {
    const low = quoteImage('gpt-image-2', { count: 1, pixels: 1024 * 1024, quality: 'low' });
    expect(low).toEqual({ match: 'gpt-image-2', unit: 'image', per_image_nanos: 6_000_000, nanos: 6_000_000 });
    const two = quoteImage('gpt-image-2', { count: 2, pixels: 1024 * 1024, quality: 'high' });
    expect(two?.nanos).toBe(422_000_000);
  });

  it('尺寸按像素等比折算，且被夹在 1/4 到 4 倍之间', () => {
    // 1536×1024 = 1.5 倍的 1K 方图。
    const wide = quoteImage('gpt-image-1.5', { count: 1, pixels: 1536 * 1024, quality: 'medium' });
    expect(wide?.per_image_nanos).toBe(51_000_000);
    // 没有尺寸（上游没回显、请求又是 auto）时按 1K 方图算，不按 0 算。
    const unknown = quoteImage('gpt-image-1.5', { count: 1, pixels: 0, quality: 'medium' });
    expect(unknown?.per_image_nanos).toBe(34_000_000);
    // 离谱的大尺寸只按 4 倍收：那是上游回了坏数据，不是价格问题。
    const absurd = quoteImage('gpt-image-1.5', { count: 1, pixels: 100_000_000, quality: 'medium' });
    expect(absurd?.per_image_nanos).toBe(136_000_000);
  });
});

describe('协议契约：只有 openai-oauth 声称自己能出图', () => {
  it('schema 上说清能力，profile 上是那条方言', () => {
    expect(schemaOf('openai-oauth').image).toBe(true);
    expect(protocolFor('openai-oauth').image).toBe('openai-image-tool');
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini', 'deepseek', 'opencode-go', 'openai-audio', 'qwen'] as const) {
      expect(schemaOf(protocol).image).toBe(false);
      expect(protocolFor(protocol).image).toBeUndefined();
    }
  });

  it('图像型号进得了清单（带 image 输出模态），文本协议不声明任何型号', () => {
    const catalog = imageCodecFor('openai-image-tool').catalog();
    expect(catalog.map((item) => item.id)).toEqual(OPENAI_IMAGE_MODELS);
    for (const item of catalog) expect(item.modalities).toEqual({ input: ['text', 'image'], output: ['image'] });
  });
});
