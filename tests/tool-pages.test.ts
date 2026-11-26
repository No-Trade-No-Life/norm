import { describe, expect, it } from 'vitest';

import { candidateModels } from '../web/src/lib/catalog';
import { billFromHeaders, formatBytes, formatDuration } from '../web/src/lib/audio';
import { geminiBlockReason, readGeminiImages } from '../web/src/lib/gemini-image';
import { hostOfUrl, readSearchOutcome } from '../web/src/lib/web-search';
import type { ModelCatalog } from '../web/src/types';

/**
 * 工具页的三件「读回包」与一件「挑模型」。
 *
 * 这些函数是页面里唯一有分支的地方：挑错了模型会把一次调用打向一条做不了这件事的上游，
 * 读错了形状会把上游明明给了的图 / 出处说成没有。都在这里钉住，页面只负责画。
 */
const provider = (over: Partial<ModelCatalog['providers'][number]> & { id: string }) => ({
  label: over.id,
  base_url: `https://${over.id}.example/v1`,
  host: `${over.id}.example`,
  protocol: 'openai-chat' as const,
  trusted: false,
  scope: 'private' as const,
  mine: true,
  enabled: 1,
  probed: true,
  ok: true,
  count: 0,
  latency_ms: 10,
  error: null,
  ...over,
});

const catalog: ModelCatalog = {
  fetched_at: 0,
  providers: [
    provider({ id: 'gemini', protocol: 'google-gemini' }),
    provider({ id: 'responses', protocol: 'openai-responses' }),
    provider({ id: 'off', protocol: 'google-gemini', enabled: 0 }),
  ],
  models: [
    {
      id: 'gemini-2.5-flash-image',
      providers: ['gemini'],
      official: null,
      modalities: { input: ['text', 'image'], output: ['text', 'image'], declared: 1 },
    },
    {
      id: 'gemini-2.5-pro',
      providers: ['gemini'],
      official: null,
      modalities: { input: ['text'], output: ['text'], declared: 1 },
    },
    {
      id: 'gemini-off-image',
      providers: ['off'],
      official: null,
      modalities: { input: ['text'], output: ['image'], declared: 1 },
    },
    { id: 'deepseek-chat', providers: ['responses'], official: null, modalities: null },
    {
      id: 'qwen-audio-3.0-asr-flash',
      providers: ['responses'],
      official: null,
      modalities: { input: ['audio'], output: ['text'], declared: 1 },
    },
  ],
};

describe('candidateModels', () => {
  it('出图只认「说 Gemini 且声明了 image 输出」的模型', () => {
    expect(candidateModels(catalog, { protocols: ['google-gemini'], output: 'image' })).toEqual([
      'gemini-2.5-flash-image',
    ]);
  });

  it('禁用的上游不进清单：它现在打不出去', () => {
    expect(candidateModels(catalog, { output: 'image' })).not.toContain('gemini-off-image');
  });

  it('联网搜索只认带得上 web_search 工具的两条协议', () => {
    expect(candidateModels(catalog, { protocols: ['openai-responses', 'deepseek'] })).toEqual([
      'deepseek-chat',
      'qwen-audio-3.0-asr-flash',
    ]);
  });

  it('音频按上游自述的模态筛，不按模型名猜', () => {
    expect(candidateModels(catalog, { input: 'audio' })).toEqual(['qwen-audio-3.0-asr-flash']);
    expect(candidateModels(catalog, { output: 'audio' })).toEqual([]);
  });

  it('总表还没回来时是空清单，不是报错', () => {
    expect(candidateModels(undefined, { output: 'image' })).toEqual([]);
  });
});

describe('readGeminiImages', () => {
  it('取 inlineData，也认 snake_case 的实现', () => {
    const result = readGeminiImages({
      candidates: [
        {
          content: {
            parts: [
              { text: '这是一只猫' },
              { inlineData: { mimeType: 'image/png', data: 'AAA' } },
              { inline_data: { mime_type: 'image/jpeg', data: 'BBB' } },
            ],
          },
        },
      ],
    });
    expect(result.text).toBe('这是一只猫');
    expect(result.images).toEqual([
      { mimeType: 'image/png', data: 'AAA' },
      { mimeType: 'image/jpeg', data: 'BBB' },
    ]);
  });

  it('没有图就没有图：不拿一个空字符串冒充', () => {
    expect(readGeminiImages({ candidates: [{ content: { parts: [{ text: '画不了' }] } }] })).toEqual({
      images: [],
      text: '画不了',
    });
    expect(readGeminiImages(null)).toEqual({ images: [], text: '' });
  });

  it('被安全策略拦下时只有 blockReason，单独读得到', () => {
    expect(geminiBlockReason({ promptFeedback: { blockReason: 'SAFETY' } })).toBe('SAFETY');
    expect(geminiBlockReason({ candidates: [] })).toBeNull();
  });
});

describe('readSearchOutcome', () => {
  it('答案取自 message 条目，出处取自 url_citation 注记', () => {
    const outcome = readSearchOutcome({
      output: [
        {
          type: 'web_search_call',
          action: { query: '上证指数 收盘' },
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '今天收在 3200 点。',
              annotations: [
                { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
                { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
                { type: 'url_citation', url: 'https://b.example/2', title: '' },
              ],
            },
          ],
        },
      ],
    });
    expect(outcome.answer).toBe('今天收在 3200 点。');
    expect(outcome.queries).toEqual(['上证指数 收盘']);
    // 同一个页面引两次只留一条；空标题留 null，由页面退回主机名。
    expect(outcome.sources).toEqual([
      { url: 'https://a.example/1', title: 'A' },
      { url: 'https://b.example/2', title: null },
    ]);
  });

  it('只有扁平 output_text 时也读得出答案', () => {
    expect(readSearchOutcome({ output_text: '一句话' })).toEqual({
      answer: '一句话',
      queries: [],
      sources: [],
    });
  });

  it('多轮检索的词都收下且去重', () => {
    const outcome = readSearchOutcome({
      output: [
        { type: 'web_search_call', action: { queries: ['a', 'b'] } },
        { type: 'web_search_call', action: { query: 'b' } },
      ],
    });
    expect(outcome.queries).toEqual(['a', 'b']);
    expect(outcome.answer).toBe('');
  });

  it('出处的主机名兜底', () => {
    expect(hostOfUrl('https://news.example/a/b')).toBe('news.example');
    expect(hostOfUrl('不是 url')).toBe('不是 url');
  });
});

describe('billFromHeaders', () => {
  it('合成把账单挂在响应头上，四个头读成一个账单', () => {
    const headers = new Headers({
      'X-Norm-Request-Id': 'req_1',
      'X-Norm-Fee-Nanos': '76390',
      'X-Norm-Gas-Billed-Nanos': '2420',
      'X-Norm-Token-Billed-Nanos': '73970',
    });
    expect(billFromHeaders(headers)).toEqual({
      request_id: 'req_1',
      fee_nanos: 76390,
      gas_billed_nanos: 2420,
      token_billed_nanos: 73970,
    });
  });

  it('失败只有 Gas 头：账单条要显示一半也不能报错', () => {
    const headers = new Headers({ 'X-Norm-Request-Id': 'req_2', 'X-Norm-Gas-Fee-Nanos': '2420' });
    expect(billFromHeaders(headers)).toEqual({
      request_id: 'req_2',
      fee_nanos: null,
      gas_billed_nanos: 2420,
      token_billed_nanos: null,
    });
  });

  it('一个头都没有 = 记账之前就被拒了，没有账可说', () => {
    expect(billFromHeaders(new Headers())).toBeNull();
  });
});

describe('音频尺寸', () => {
  it('字节与时长都读成人话', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(3400)).toBe('3.4 s');
    expect(formatDuration(75_000)).toBe('1:15');
  });
});
