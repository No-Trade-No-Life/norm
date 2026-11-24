import { translate, type CopyKey, type Lang } from '../copy';

const PROTOCOL_KEYS: Record<string, CopyKey> = {
  'openai-chat': 'proto.openai-chat',
  'openai-responses': 'proto.openai-responses',
  'anthropic-messages': 'proto.anthropic-messages',
  'google-gemini': 'proto.google-gemini',
};

const VISIBILITY_KEYS: Record<string, CopyKey> = {
  public: 'vis.public',
  private: 'vis.private',
};

/** 枚举值原样兜底，避免后端新增取值被前端吞掉。 */
function labelOf(table: Record<string, CopyKey>, value: string, lang: Lang): string {
  const key = table[value];
  return key ? translate(lang, key) : value;
}

export function protocolLabel(protocol: string, lang: Lang): string {
  return labelOf(PROTOCOL_KEYS, protocol, lang);
}

export function visibilityLabel(visibility: string, lang: Lang): string {
  return labelOf(VISIBILITY_KEYS, visibility, lang);
}

/**
 * 「官方 key」不是后端概念，而是一份 base_url 清单的判断结果。
 * 清单在 Worker 的 TRUSTED_BASE_URLS 里，后端只回 trusted 布尔，这里只负责文案。
 */
export function trustLabel(trusted: boolean, lang: Lang): string {
  return translate(lang, trusted ? 'trust.trusted' : 'trust.untrusted');
}
