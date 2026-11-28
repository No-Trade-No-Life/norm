import { describe, expect, it } from 'vitest';

import { mergeDeclaredModels } from '../src/models';

/**
 * 清单里「问不出来、只能声明」的那一半。
 *
 * 图像工具方言没有 `/images/generations` 可列，ChatGPT 的清单端点又答不上话，所以图片
 * 型号只存在于代码里。下游网关（NormAI 这类）靠 `GET /v1/models` 同步模型行，漏了这些
 * 型号它就永远没有图片行，`/v1/images/generations` 会在选址之前被它自己拒掉——
 * 2026-11-28 线上那次 400（`model is not available: gpt-image-2.5-sunburst`）就是这么来的。
 */
describe('mergeDeclaredModels', () => {
  it('把图像工具声明的型号补进清单，上游自己列过的那个只留一份', () => {
    const merged = mergeDeclaredModels(
      [{ id: 'gpt-6-luna' }, { id: 'gpt-image-2', owned_by: 'upstream' }],
      ['openai-oauth'],
    );

    const ids = merged.map((item) => item.id);
    expect(ids[0]).toBe('gpt-6-luna');
    expect(ids.filter((id) => id === 'gpt-image-2')).toHaveLength(1);
    expect(ids).toContain('gpt-image-2.5-sunburst');
    expect(ids).toContain('gpt-image-1');
    // 上游自己回过的那一行不被声明版覆盖（它带着 created / owned_by）。
    expect(merged.find((item) => item.id === 'gpt-image-2')?.owned_by).toBe('upstream');
  });

  it('同一条协议挂两遍也只补一遍', () => {
    const once = mergeDeclaredModels([], ['openai-oauth']);
    const twice = mergeDeclaredModels([], ['openai-oauth', 'openai-oauth']);
    expect(twice.map((item) => item.id)).toEqual(once.map((item) => item.id));
  });

  it('没有图像与音频能力的协议，一个字也不替它编', () => {
    const merged = mergeDeclaredModels([{ id: 'deepseek-v4-pro' }], ['opencode-go', 'deepseek']);
    expect(merged.map((item) => item.id)).toEqual(['deepseek-v4-pro']);
  });

  it('声明的型号带着自己的模态：下游因此知道它是收文字出图的那一行', () => {
    const merged = mergeDeclaredModels([], ['openai-oauth']);
    expect(merged.find((item) => item.id === 'gpt-image-2')?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['image'],
    });
  });
});
