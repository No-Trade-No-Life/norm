import { describe, expect, it } from 'vitest';

import { isModelNotServed, mergeCatalog, unionModels } from '../src/models';
import { MODEL_ROWS_PER_STATEMENT, modelInsertChunks } from '../src/store';

/**
 * 数据面清单的并集：`GET /v1/models` 逐条问、并成一条答。
 *
 * 抽一条上游回答是线上真实坏过的形状：同一个账户连着问六次，拿到 15 条 / 50 条 /
 * 15 条 / 400 / 15 条。下游网关（NormAI）是拿这份清单同步模型行的，抽到哪一条，
 * 它就少掉其余几条上游的型号——音频型号就是这么消失的，转写随后被拒成
 * `400 model is not available`。
 */
describe('unionModels', () => {
  it('几条上游的型号都并进来，按名字排序', () => {
    const rows = unionModels([
      { id: 'gpt-5.6-luna' },
      { id: 'qwen-audio-3.0-asr-flash' },
      { id: 'deepseek-v4-pro' },
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      'deepseek-v4-pro',
      'gpt-5.6-luna',
      'qwen-audio-3.0-asr-flash',
    ]);
  });

  it('同名只留一份：先给的不被覆盖，后来的能补空', () => {
    const rows = unionModels([
      { id: 'm', created: 100 },
      { id: 'm', created: 999, owned_by: 'someone' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].created).toBe(100);
    expect(rows[0].owned_by).toBe('someone');
  });

  it('一条都没答上来就是空清单，不编一个型号出来', () => {
    expect(unionModels([])).toEqual([]);
  });
});

/**
 * 合并规则是这张表的全部逻辑：同名就是同一条、谁有它记成一列、官方价按提供它的
 * 协议的定价模式锚定（通用表平档，`deepseek` 分时）。都在这里钉住，
 * e2e 只负责验证「真打出去也确实如此」。
 */
describe('mergeCatalog', () => {
  it('同名模型跨上游合成一行，记下谁有它，结果按名字排序', () => {
    const rows = mergeCatalog([
      {
        provider_id: 'p-openai',
        protocol: 'openai-chat',
        items: [{ id: 'gpt-4o-mini' }, { id: 'b-model' }],
      },
      {
        provider_id: 'p-proxy',
        protocol: 'openai-chat',
        items: [{ id: 'gpt-4o-mini' }, { id: 'a-model' }],
      },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['a-model', 'b-model', 'gpt-4o-mini']);
    expect(rows[2].providers).toEqual(['p-openai', 'p-proxy']);
    expect(rows[1].providers).toEqual(['p-openai']);
  });

  it('created / owned_by 先给的不被覆盖，后给的能补空', () => {
    const rows = mergeCatalog([
      // Anthropic 的清单没有 owned_by：先来的这一条缺一列。
      { provider_id: 'p-a', protocol: 'anthropic-messages', items: [{ id: 'm', created: 100 }] },
      { provider_id: 'p-b', protocol: 'openai-chat', items: [{ id: 'm', created: 999, owned_by: 'someone' }] },
    ]);

    expect(rows[0].created).toBe(100);
    expect(rows[0].owned_by).toBe('someone');
  });

  it('同一家把同一个模型列两遍，谁有它只记一次', () => {
    const rows = mergeCatalog([
      { provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'm' }, { id: 'm' }] },
    ]);
    expect(rows[0].providers).toEqual(['p']);
  });

  it('官方价按最长前缀锚定：gpt-4o-mini 不能按 gpt-4o 计价', () => {
    const rows = mergeCatalog([
      { provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] },
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('gpt-4o-mini')?.official).toMatchObject({ match: 'gpt-4o-mini', input: 150_000_000 });
    expect(byId.get('gpt-4o')?.official).toMatchObject({ match: 'gpt-4o', input: 2_500_000_000 });
  });

  it('带提供者前缀的名字也能锚上（openrouter 那类 id）', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'openai/gpt-4.1-mini' }] }]);
    expect(rows[0].official?.match).toBe('gpt-4.1-mini');
  });

  it('挂 deepseek 协议的型号，锚点是高峰价 + 低谷价', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'deepseek', items: [{ id: 'deepseek-flash' }] }]);
    expect(rows[0].official).toMatchObject({ match: 'deepseek-flash', input: 300_000_000 });
    expect(rows[0].official?.off_peak).toEqual({ input: 150_000_000, cached: 3_000_000, output: 600_000_000 });
  });

  // 分时价是协议的事：同一个型号挂在通用协议上时，那条上游并没有「低谷时段」，
  // 所以锚点只有平档价（高峰价）。
  it('同一个型号挂在通用协议上，锚点没有低谷价', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'deepseek-flash' }] }]);
    expect(rows[0].official?.input).toBe(300_000_000);
    expect(rows[0].official?.off_peak).toBeUndefined();
  });

  it('几家上游都有它时，锚点以带分时价的那一条为准', () => {
    const rows = mergeCatalog([
      { provider_id: 'p-flat', protocol: 'openai-chat', items: [{ id: 'deepseek-flash' }] },
      { provider_id: 'p-ds', protocol: 'deepseek', items: [{ id: 'deepseek-flash' }] },
    ]);
    expect(rows[0].providers).toEqual(['p-flat', 'p-ds']);
    expect(rows[0].official?.off_peak?.input).toBe(150_000_000);
  });

  it('价目表里没有的型号，官方价是 null，不猜', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'deepseek', items: [{ id: 'acme-secret-model' }] }]);
    expect(rows[0].official).toBeNull();
  });

  it('模态取并集，并记下有几条上游真的说过', () => {
    const rows = mergeCatalog([
      {
        provider_id: 'p-a',
        protocol: 'openai-chat',
        items: [{ id: 'm', modalities: { input: ['image', 'text'], output: ['text'] } }],
      },
      {
        provider_id: 'p-b',
        protocol: 'openai-chat',
        items: [{ id: 'm', modalities: { input: ['text', 'audio'], output: ['text'] } }],
      },
      // 这一条什么都没说：它不该把已经说过的抹掉，也不该被算进「声明过」。
      { provider_id: 'p-c', protocol: 'anthropic-messages', items: [{ id: 'm' }] },
    ]);

    // 次序按固定表排（text 在 image / audio 前面），不按谁先答话。
    expect(rows[0].modalities).toEqual({ input: ['text', 'image', 'audio'], output: ['text'], declared: 2 });
    expect(rows[0].providers).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('谁都没声明模态时是 null，不是 [\'text\']', () => {
    const rows = mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [{ id: 'm' }] }]);
    expect(rows[0].modalities).toBeNull();
  });

  it('同一家把同一个模型列两遍，声明数不会被同一上游灌成 2', () => {
    const rows = mergeCatalog([
      {
        provider_id: 'p',
        protocol: 'openai-chat',
        items: [
          { id: 'm', modalities: { input: ['text'], output: ['text'] } },
          { id: 'm', modalities: { input: ['text'], output: ['text'] } },
        ],
      },
    ]);
    expect(rows[0].modalities).toEqual({ input: ['text'], output: ['text'], declared: 1 });
  });

  it('空清单就是空表', () => {
    expect(mergeCatalog([])).toEqual([]);
    expect(mergeCatalog([{ provider_id: 'p', protocol: 'openai-chat', items: [] }])).toEqual([]);
  });
});

/**
 * 「上游是不是在说我没有这个型号」：只认 400 / 404，且必须点名这次的模型。
 *
 * 这条判定会删掉 `provider_models` 里的一行，所以宁可少认：把一次参数错误当成
 * 「它没有这个型号」，等于让一个坏请求把一条好上游从路由里删掉。
 */
describe('isModelNotServed', () => {
  const deepseekSaid =
    '{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.","type":"invalid_request_error"}';

  it('上游点名了这次的模型 → 它就是在说「我没有这个」', () => {
    expect(isModelNotServed(400, deepseekSaid, 'deepseek-v4.1-flash')).toBe(true);
  });

  it('有的实现用 404 表示没有这个型号', () => {
    expect(isModelNotServed(404, '{"error":"model deepseek-x not found"}', 'deepseek-x')).toBe(true);
  });

  it('400 但没点名这次的模型（参数写错）→ 不动清单', () => {
    expect(isModelNotServed(400, '{"error":"messages is required"}', 'deepseek-x')).toBe(false);
  });

  it('点名了但整句不提 model（内容审核）→ 不动清单', () => {
    expect(isModelNotServed(400, '{"error":"content rejected: deepseek-x"}', 'deepseek-x')).toBe(false);
  });

  it('401 / 402 / 403 / 429 / 5xx 一律不算：那不是「没有这个型号」', () => {
    for (const status of [401, 402, 403, 429, 500, 503]) {
      expect(isModelNotServed(status, 'model deepseek-x not allowed', 'deepseek-x')).toBe(false);
    }
  });

  it('没有模型名就没什么可判的', () => {
    expect(isModelNotServed(400, 'model required', '')).toBe(false);
  });
});

/**
 * 写清单的分批：D1 每次查询最多 100 个绑定变量，越过去就是整条写入失败。
 *
 * 这一条是被线上咬出来的——夹具只有 4 个模型，凑不出 100 个变量；线上清单几十条，
 * 一写就 500。所以这里按真实体量钉住上限，而不是按夹具的体量钉。
 */
describe('modelInsertChunks', () => {
  it('每批的绑定变量都留在 100 个以内（每行 4 个）', () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({ id: `model-${index}` }));
    const chunks = modelInsertChunks(rows);
    expect(chunks.flat()).toEqual(rows);
    for (const chunk of chunks) expect(chunk.length * 4).toBeLessThanOrEqual(100);
  });

  it('一批装得下就不切', () => {
    expect(modelInsertChunks(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
  });

  it('空清单给不出批次', () => {
    expect(modelInsertChunks([])).toEqual([]);
  });

  it('每批正好是声明的行数上限', () => {
    const names = Array.from({ length: MODEL_ROWS_PER_STATEMENT * 2 + 1 }, (_, index) => `m${index}`);
    expect(modelInsertChunks(names).map((chunk) => chunk.length)).toEqual([
      MODEL_ROWS_PER_STATEMENT,
      MODEL_ROWS_PER_STATEMENT,
      1,
    ]);
  });
});
