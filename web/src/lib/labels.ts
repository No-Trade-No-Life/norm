import { translate, type CopyKey, type Lang } from '../copy';

const SOURCE_KEYS: Record<string, CopyKey> = {
  'official-api-key': 'src.official-api-key',
  'official-subscription': 'src.official-subscription',
  'self-hosted': 'src.self-hosted',
  other: 'src.other',
};

/** 来源声明只有四种枚举值；未知值原样显示，避免把新枚举吞掉。 */
export function sourceLabel(source: string, lang: Lang): string {
  const key = SOURCE_KEYS[source];
  return key ? translate(lang, key) : source;
}
