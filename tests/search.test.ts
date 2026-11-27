import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/http';
import { quote } from '../src/pricing';
import { protocolFor } from '../src/protocols';
import type { Protocol } from '../src/protocols';
import { readSearchAsk, searchCodecForProtocol, searchDialectFor } from '../src/search';

/** 按上游协议取编解码：null 在这里是测试里的一份错声明，直接炸掉。 */
const codecOf = (protocol: Protocol) => {
  const codec = searchCodecForProtocol(protocol);
  if (codec === null) throw new Error(`${protocol} 没有搜索编解码`);
  return codec;
};

const deepseek = codecOf('deepseek');
const openai = codecOf('openai-search');
const oauth = codecOf('openai-oauth');
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

  it('openai-oauth：同一条记法——宿主在这里也是订阅的部署设置，不猜型号', () => {
    const usage = { input: 900, cached: 0, output: 40 };
    expect(oauth.quote({ sources: [{ url: 'https://example.com' }], usage })).toBe(
      quote('', usage).total_nanos,
    );
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

  it('openai-oauth 也说自己做 openai-search：ChatGPT 没有搜索端点，但它有 web_search 工具', () => {
    expect(protocolFor('openai-oauth').search).toBe('openai-search');
  });

  it('下游选的 source 落到方言上，路由不必认识任何一家搜索引擎', () => {
    expect(searchDialectFor('deepseek')).toBe('deepseek-search');
    expect(searchDialectFor('openai')).toBe('openai-search');
  });

  it('同一条方言可以有不止一条上游：编解码按**协议**取，不是按方言名取', () => {
    expect(searchCodecForProtocol('deepseek')).toBe(deepseek);
    expect(searchCodecForProtocol('openai-search')).toBe(openai);
    expect(searchCodecForProtocol('openai-oauth')).toBe(oauth);
    // 订阅那条虽然说自己做 openai-search，但它不是「做好信封的服务」：两条 codec 各说各的协议。
    expect(oauth.dialect).toBe('openai-search');
    expect(oauth).not.toBe(openai);
    // 不会搜索的协议拿到 null，路由据此回 search_not_served。
    expect(searchCodecForProtocol('openai-chat')).toBeNull();
  });
});

describe('openai-oauth：订阅上游没有搜索端点，Norm 自己把 web_search 包成一次搜索', () => {
  it('请求体是一次只调 web_search 的 Responses 调用；参数搬进工具对象，宿主模型来自候选表', () => {
    const body = JSON.parse(
      oauth.encode(
        ask(
          {
            query: 'rust 1.93',
            search_context_size: 'high',
            filters: { allowed_domains: ['example.com'] },
            user_location: { country: 'CN' },
          },
          'openai',
        ),
      ),
    );
    expect(body).toEqual({
      model: 'gpt-6-luna',
      instructions: expect.stringContaining('web_search'),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rust 1.93' }] }],
      tools: [
        {
          type: 'web_search',
          search_context_size: 'high',
          filters: { allowed_domains: ['example.com'] },
          user_location: { country: 'CN' },
        },
      ],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      stream: true,
      store: false,
    });
    // 没给的参数不进工具：默认值是上游的默认值，不是我们能替它填的。
    expect(JSON.parse(oauth.encode(ask({ query: 'rust' }, 'openai'))).tools).toEqual([{ type: 'web_search' }]);
  });

  it('宿主模型可以换一个候选：它属于订阅，不属于这次调用', () => {
    expect(JSON.parse(oauth.encode(ask({ query: 'rust' }, 'openai'), 'gpt-5.6-luna')).model).toBe('gpt-5.6-luna');
    expect(oauth.hostModels?.length ?? 0).toBeGreaterThan(1);
    expect(oauth.hostModels?.[0]).toBe('gpt-6-luna');
    expect(oauth.path).toBe('/responses');
  });

  it('deepseek 那条协议的语言在这里被拒（两个参数的归属说清）', () => {
    const failure = rejection(() => oauth.encode(ask({ query: 'rust', max_results: 3 }, 'openai')));
    expect(failure).toMatchObject({ status: 400, code: 'param_unsupported' });
    expect(failure.message).toContain('deepseek');
  });

  it('事件流里两处来源都读、按 url 合成一条：sources 只有 url，注解补上 title', async () => {
    const stream = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"rust","sources":[{"type":"url","url":"https://example.com/one"},{"type":"url","url":"https://example.com/two"}]}}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"…","annotations":[{"type":"url_citation","url":"https://example.com/one","title":"One"},{"type":"url_citation","url":"https://example.com/three","title":"Three"}]}]}}',
      '',
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":200},"output_tokens":80}}}',
      '',
    ].join('\n');
    const answer = await oauth.read(new Response(stream));
    expect(answer.sources).toEqual([
      { url: 'https://example.com/one', title: 'One' },
      { url: 'https://example.com/two' },
      { url: 'https://example.com/three', title: 'Three' },
    ]);
    expect(answer.usage).toEqual({ input: 1200, cached: 200, output: 80 });
  });

  it('只给收尾帧的上游也读得到：来源在 response.completed 的 output 里', async () => {
    const stream = [
      'data: {"type":"response.completed","response":{"output":[{"type":"web_search_call","action":{"type":"search","sources":[{"type":"url","url":"https://example.com/late"}]}}],"usage":{"input_tokens":300,"output_tokens":20}}}',
      '',
    ].join('\n');
    const answer = await oauth.read(new Response(stream));
    expect(answer.sources).toEqual([{ url: 'https://example.com/late' }]);
    expect(answer.usage).toEqual({ input: 300, cached: 0, output: 20 });
  });

  it('一条来源都没有 = 这次搜索不算成功；不是事件流的响应是上游违约', async () => {
    const empty = await asyncRejection(() =>
      oauth.read(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"没搜到"}]}}',
            '',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}',
            '',
          ].join('\n'),
        ),
      ),
    );
    expect(empty).toMatchObject({ status: 502, code: 'search_empty' });

    const notStream = await asyncRejection(() => oauth.read(new Response('<html>bad gateway</html>')));
    expect(notStream).toMatchObject({ status: 502, code: 'search_data_missing' });
  });
});
