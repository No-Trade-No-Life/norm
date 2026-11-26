import type { ModelCatalog, Protocol } from '../types';

/**
 * 从模型总表里挑出「这条入口真的能用」的模型。
 *
 * 总表是唯一同时说清两件事的地方：一个模型由哪几条上游提供（`providers`），那几条说的
 * 是哪条协议（`protocol`）；模型自己又声明了哪些输入 / 输出模态（`modalities`）。
 * 每个工具页的入口只认其中一部分——图像走 Gemini、联网搜索走 Responses、音频看模态——
 * 所以筛选条件在这里写成一次查询，页面不各自记一套规则。
 *
 * 模态只认上游自己的声明：没声明就是没有，绝不按模型名猜（`models.tsx` 同一口径）。
 */
export type ModelFilter = {
  /** 上游协议：这条入口要求候选上游说的是这几条之一。 */
  protocols?: readonly Protocol[];
  /** 输入模态，如 `audio`。 */
  input?: string;
  /** 输出模态，如 `image` / `audio`。 */
  output?: string;
};

export function candidateModels(catalog: ModelCatalog | undefined, filter: ModelFilter): string[] {
  if (!catalog) return [];
  const wanted = filter.protocols ? new Set<string>(filter.protocols) : null;
  const byId = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  const usable = new Set<string>();

  for (const provider of catalog.providers) {
    // 禁用的上游不参与选址，这里也不该被推荐：它现在打不出去。
    if (provider.enabled !== 1) continue;
    if (wanted && !wanted.has(provider.protocol)) continue;
    for (const model of catalog.models) {
      if (!model.providers.includes(provider.id)) continue;
      if (!declares(model.modalities, filter)) continue;
      usable.add(model.id);
    }
  }

  return [...usable].sort((a, b) => a.localeCompare(b));
}

function declares(
  modalities: { input: string[]; output: string[] } | null,
  filter: ModelFilter,
): boolean {
  if (filter.input && !(modalities?.input.includes(filter.input) ?? false)) return false;
  if (filter.output && !(modalities?.output.includes(filter.output) ?? false)) return false;
  return true;
}

/** 音色清单里没收录的名字也允许手填：上游加的语音不该等前端发一版。 */
export function optionsWithFallback(options: string[], fallback: string): string[] {
  if (!fallback || options.includes(fallback)) return options;
  return [...options, fallback];
}
