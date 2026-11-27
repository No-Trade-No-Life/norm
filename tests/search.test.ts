import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/http';
import { quote } from '../src/pricing';
import { protocolFor } from '../src/protocols';
import { readSearchAsk, searchCodecFor, searchCodecForProtocol } from '../src/search';

const deepseek = searchCodecFor('deepseek-search');
const openai = searchCodecFor('openai-search');
const NO_USAGE = { input: 0, cached: 0, output: 0 };

/** 把一次出错读成 `状态码 + 代码`：这一层的每个拒绝都是这两件事。 */
function rejection(run: () => unknown): { status: number; code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('这一步本应失败，却成功了');
}

async function asyncRejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('这一步本应失败，却成功了');
}

const ask = (body: Record<string, unknown>, source: 'deepseek' | 'openai' = 'deepseek') =>
  readSearchAsk(JSON.stringify({ source, ...body }));

describe('下游只选搜索协议，不选模型', () => {
  it('source 说 deepseek 还是 openai，query 是公共的那一句', () => {
    expect(ask({ query: ' rust 1.93 ' })).toEqual({
      protocol: 'deepseek',
      query: 'rust 1.93',
      params: {},
    });
    expect(ask({ query: 'rust', search_context_size: 'high' }, 'openai')).toEqual({
      protocol: 'openai',
      query: 'rust',
      params: { search_context_size: 'high' },
    });
  });

  it('没有 source、或 source 写了别的（比如一个模型名），直接说清这两条协议', () => {
    const missing = rejection(() => readSearchAsk(JSON.stringify({ query: 'rust' })));
    expect(missing).toMatchObject({ status: 400, code: 'source_invalid' });
    expect(missing.message).toContain('deepseek 或 openai');

    const asModel = rejection(() => ask({ query: 'rust' }, 'deepseek-chat' as never));
    expect(asModel).toMatchObject({ status: 400, code: 'source_invalid' });
  });

  it('请求体不是 JSON 对象、或没有 query 就直接拒', () => {
    for (const raw of ['', 'not json', '[1,2]']) {
      expect(rejection(() => readSearchAsk(raw)).code).toBe('body_invalid');
    }
    for (const body of [{}, { query: '   ' }]) {
      expect(rejection(() => ask(body)).code).toBe('query_required');
    }
  });
});

describe('deepseek：直连 Search API，一句话、一页条数、要不要正文', () => {
  it('默认 8 条、不要正文；条数与正文进上游请求体（上游管它叫 count）', () => {
    expect(JSON.parse(deepseek.encode(ask({ query: 'rust' })))).toEqual({
      query: 'rust',
      count: 8,
      need_content: false,
    });
    expect(
      JSON.parse(deepseek.encode(ask({ query: 'rust', max_results: 50, need_content: true }))),
    ).toEqual({ query: 'rust', count: 50, need_content: true });
  });

  it('域名过滤折进查询语法：允许的是 OR，屏蔽的是逐个排除', () => {
    expect(
      JSON.parse(deepseek.encode(ask({ query: 'rust', allowed_domains: ['a.com', 'b.com'] }))).query,
    ).toBe('rust site:a.com OR site:b.com');
    expect(
      JSON.parse(deepseek.encode(ask({ query: 'rust', blocked_domains: ['a.com', 'b.com'] }))).query,
    ).toBe('rust -site:a.com -site:b.com');
  });

  it('拼错的搜索控制被拒，而不是悄悄换成默认值', () => {
    for (const [body, code] of [
      [{ query: 'rust', max_results: 51 }, 'max_results_invalid'],
      [{ query: 'rust', max_results: 0 }, 'max_results_invalid'],
      [{ query: 'rust', max_results: 2.5 }, 'max_results_invalid'],
      [{ query: 'rust', need_content: 'yes' }, 'need_content_invalid'],
      [{ query: 'rust', allowed_domains: [] }, 'allowed_domains_invalid'],
      [{ query: 'rust', allowed_domains: ['https://example.com'] }, 'allowed_domains_invalid'],
      [{ query: 'rust', blocked_domains: ['a b.com'] }, 'blocked_domains_invalid'],
      [{ query: 'rust', allowed_domains: ['a.com'], blocked_domains: ['b.com'] }, 'domains_conflict'],
      [
        {
          query: 'rust',
          blocked_domains: Array.from({ length: 20 }, (_, index) => `d${index}.example.com`),
        },
        'query_too_long',
      ],
    ] as const) {
      const failure = rejection(() => deepseek.encode(ask(body)));
      expect(failure.status).toBe(400);
      expect(failure.code).toBe(code);
    }
  });

  it('另一条协议的语言在这里被拒，并点名说它属于谁', () => {
    const failure = rejection(() => deepseek.encode(ask({ query: 'rust', search_context_size: 'high' })));
    expect(failure).toMatchObject({ status: 400, code: 'param_unsupported' });
    expect(failure.message).toContain('openai');
  });

  it('结果折成 sources：带 url 的留下，字段改名成信封那一套', async () => {
    const answer = await deepseek.read(
      new Response(
        JSON.stringify({
          results: [
            {
              url: 'https://example.com/one',
              title: 'One',
              snippet: 'short',
              summary: 'longer',
              content: '# Page',
              site_name: 'Example',
              date: '2026-10-01T00:00:00+00:00',
              authority: 3,
              rerank_score: 2.4,
            },
            { url: 'https://example.com/two', title: '' },
            { title: '没有 url 的那条不是结果' },
          ],
        }),
      ),
    );
    expect(answer.sources).toEqual([
      {
        url: 'https://example.com/one',
        title: 'One',
        snippet: 'short',
        summary: 'longer',
        content: '# Page',
        published_at: '2026-10-01T00:00:00+00:00',
        site_name: 'Example',
        authority: 3,
        rerank_score: 2.4,
      },
      { url: 'https://example.com/two' },
    ]);
    expect(answer.usage).toEqual(NO_USAGE);
  });

  it('一条结果都没有 = 这次搜索不算成功（上游按成功调用计费）', async () => {
    const empty = await asyncRejection(() =>
      deepseek.read(new Response(JSON.stringify({ results: [] }))),
    );
    expect(empty).toMatchObject({ status: 502, code: 'search_empty' });
  });

  it('上游回的不是搜索信封，是上游违约', async () => {
    for (const body of [{}, { data: [] }]) {
      const missing = await asyncRejection(() => deepseek.read(new Response(JSON.stringify(body))));
      expect(missing).toMatchObject({ status: 502, code: 'search_data_missing' });
    }
    const notJson = await asyncRejection(() =>
      deepseek.read(new Response('<html>bad gateway</html>')),
    );
    expect(notJson).toMatchObject({ status: 502, code: 'search_data_missing' });
  });
});

describe('openai：上游把宿主模型 + web_search 包成同一条信封', () => {
  it('请求体是 OpenAI 那三个参数，原样转发；模型由上游部署时定下，这里没有', () => {
    const body = JSON.parse(
      openai.encode(
        ask(
          {
            query: 'rust',
            search_context_size: 'high',
            filters: { allowed_domains: ['example.com'] },
            user_location: { country: 'CN' },
          },
          'openai',
        ),
      ),
    );
    expect(body).toEqual({
      query: 'rust',
      search_context_size: 'high',
      filters: { allowed_domains: ['example.com'] },
      user_location: { country: 'CN' },
    });
    expect(body).not.toHaveProperty('model');
  });

  it('deepseek 那条协议的语言在这里被拒', () => {
    const failure = rejection(() => openai.encode(ask({ query: 'rust', max_results: 3 }, 'openai')));
    expect(failure).toMatchObject({ status: 400, code: 'param_unsupported' });
    expect(failure.message).toContain('deepseek');
  });

  it('从 web_search_call 的 action.sources 里读来源，并把 token 用量带回来', async () => {
    const answer = await openai.read(
      new Response(
        JSON.stringify({
          data: [
            {
              type: 'web_search_call',
              action: {
                type: 'search',
                query: 'rust',
                sources: [
                  { type: 'url', url: 'https://example.com/one', title: 'One' },
                  { type: 'url', url: 'https://example.com/two' },
                ],
              },
            },
          ],
          usage: { input_tokens: 1200, output_tokens: 80, cached_tokens: 200 },
        }),
      ),
    );
    expect(answer.sources).toEqual([
      { url: 'https://example.com/one', title: 'One' },
      { url: 'https://example.com/two' },
    ]);
    expect(answer.usage).toEqual({ input: 1200, cached: 200, output: 80 });
  });

  it('一条来源都没有 = 这次搜索不算成功', async () => {
    const empty = await asyncRejection(() =>
      openai.read(new Response(JSON.stringify({ data: [{ action: { sources: [] } }] }))),
    );
    expect(empty).toMatchObject({ status: 502, code: 'search_empty' });
  });
});

describe('两条协议各自报价：一条按次，一条按 token', () => {
  it('deepseek：每 1,000 次 0.75 美元 = 一次 750,000 纳美元，与搜到什么无关', () => {
    const one = deepseek.quote({ sources: [{ url: 'https://example.com' }], usage: NO_USAGE });
    expect(one).toBe(750_000);
    expect((one * 1000) / 1_000_000_000).toBe(0.75);
  });

  it('openai：宿主模型是上游的部署设置，Norm 看不到型号，所以按通用价目表折上游报的 token', () => {
    const usage = { input: 1200, cached: 200, output: 80 };
    const expected = quote('', usage).total_nanos;
    expect(openai.quote({ sources: [{ url: 'https://example.com' }], usage })).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});

describe('方言挂在协议上，不挂在模型上', () => {
  it('deepseek 走 Search API，openai-search 走上游的搜索信封', () => {
    expect(protocolFor('deepseek').search).toBe('deepseek-search');
    expect(protocolFor('openai-search').search).toBe('openai-search');
    expect(deepseek.path).toBe('/v1/tools/search');
    expect(openai.path).toBe('/v1/web-search');
  });

  it('别的协议一条搜索方言都没有', () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini', 'qwen'] as const) {
      expect(protocolFor(protocol).search).toBeUndefined();
    }
  });

  it('下游选的 source 落到方言上，路由不必认识任何一家搜索引擎', () => {
    expect(searchCodecForProtocol('deepseek')).toBe(deepseek);
    expect(searchCodecForProtocol('openai')).toBe(openai);
  });
});
