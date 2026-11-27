import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/http';
import { SEARCH_CALL_NANOS } from '../src/pricing';
import { SEARCH_PATH, readSearchAnswer, readSearchAsk, searchBody } from '../src/search';

/** 把一次出错读成 `状态码 + 代码`：搜索这一层的每个拒绝都是这两件事。 */
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

const ask = (body: unknown) => readSearchAsk(JSON.stringify(body));

describe('联网搜索的请求：一句话、一页条数、要不要正文', () => {
  it('一句 query 就是一次搜索，条数默认 8、正文默认不要', () => {
    expect(ask({ query: ' rust 1.93 ' })).toEqual({
      query: 'rust 1.93',
      max_results: 8,
      need_content: false,
    });
  });

  it('条数与正文原样进上游请求体（上游管它叫 count）', () => {
    const body = searchBody(ask({ query: 'rust', max_results: 50, need_content: true }));
    expect(JSON.parse(body)).toEqual({ query: 'rust', count: 50, need_content: true });
  });

  it('域名过滤折进查询语法：允许的是 OR，屏蔽的是逐个排除', () => {
    expect(ask({ query: 'rust', allowed_domains: ['a.com', 'b.com'] }).query).toBe(
      'rust site:a.com OR site:b.com',
    );
    expect(ask({ query: 'rust', blocked_domains: ['a.com', 'b.com'] }).query).toBe(
      'rust -site:a.com -site:b.com',
    );
  });

  it('拼错的搜索控制被拒，而不是悄悄换成默认值', () => {
    for (const [body, code] of [
      [{}, 'query_required'],
      [{ query: '   ' }, 'query_required'],
      [{ query: 'rust', max_results: 51 }, 'max_results_invalid'],
      [{ query: 'rust', max_results: 0 }, 'max_results_invalid'],
      [{ query: 'rust', max_results: 2.5 }, 'max_results_invalid'],
      [{ query: 'rust', need_content: 'yes' }, 'need_content_invalid'],
      [{ query: 'rust', allowed_domains: [] }, 'allowed_domains_invalid'],
      [{ query: 'rust', allowed_domains: ['https://example.com'] }, 'allowed_domains_invalid'],
      [{ query: 'rust', blocked_domains: ['a b.com'] }, 'blocked_domains_invalid'],
      [
        { query: 'rust', allowed_domains: ['example.com'], blocked_domains: ['example.org'] },
        'domains_conflict',
      ],
      [
        {
          query: 'rust',
          blocked_domains: Array.from({ length: 20 }, (_, index) => `d${index}.example.com`),
        },
        'query_too_long',
      ],
    ] as const) {
      const failure = rejection(() => ask(body));
      expect(failure.status).toBe(400);
      expect(failure.code).toBe(code);
    }
  });

  it('请求体不是 JSON 对象就直接说清楚', () => {
    for (const raw of ['', 'not json', '[1,2]', '"rust"']) {
      expect(rejection(() => readSearchAsk(raw)).code).toBe('body_invalid');
    }
  });
});

describe('联网搜索的应答：有 url 的才算一条结果', () => {
  const respond = (body: unknown) => readSearchAnswer(new Response(JSON.stringify(body)));

  it('结果折成 sources：带 url 的留下，字段改名成信封那一套', async () => {
    const sources = await respond({
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
    });
    expect(sources).toEqual([
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
  });

  it('一条结果都没有 = 这次搜索不算成功（上游按成功调用计费）', async () => {
    const empty = await asyncRejection(() => respond({ results: [] }));
    expect(empty).toMatchObject({ status: 502, code: 'search_empty' });
  });

  it('上游回的不是搜索信封，是上游违约', async () => {
    for (const body of [{}, { data: [] }]) {
      const missing = await asyncRejection(() => respond(body));
      expect(missing).toMatchObject({ status: 502, code: 'search_data_missing' });
    }
    const notJson = await asyncRejection(() =>
      readSearchAnswer(new Response('<html>bad gateway</html>')),
    );
    expect(notJson).toMatchObject({ status: 502, code: 'search_data_missing' });
  });
});

describe('联网搜索的价格：按成功的调用算', () => {
  it('每 1,000 次 0.75 美元 = 一次 750,000 纳美元', () => {
    expect(SEARCH_CALL_NANOS).toBe(750_000);
    expect((SEARCH_CALL_NANOS * 1000) / 1_000_000_000).toBe(0.75);
  });

  it('打的是 Search API 自己的路径，不是任何推理端点', () => {
    expect(SEARCH_PATH).toBe('/v1/tools/search');
  });
});
