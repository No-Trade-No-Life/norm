import { translate, type CopyKey, type Lang } from '../copy';
import type { Attestation } from '../types';

const PROTOCOL_KEYS: Record<string, CopyKey> = {
  'openai-chat': 'proto.openai-chat',
  'openai-responses': 'proto.openai-responses',
  'anthropic-messages': 'proto.anthropic-messages',
  'google-gemini': 'proto.google-gemini',
  deepseek: 'proto.deepseek',
  'opencode-go': 'proto.opencode-go',
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
 * ZDR 策略：后端只报「是哪一条」（no-bodies / billing-fields-only / sealed-at-rest），
 * 句子留在字典里——否则英文界面会原样显示中文。
 */
const POLICY_KEYS: Record<keyof Attestation['policy'], Record<string, CopyKey>> = {
  logs: { 'no-bodies': 'at.policy_logs_none' },
  storage: { 'billing-fields-only': 'at.policy_storage_billing_only' },
  keys: { 'sealed-at-rest': 'at.policy_keys_sealed' },
};

export function policyLabel(kind: keyof Attestation['policy'], code: string, lang: Lang): string {
  return labelOf(POLICY_KEYS[kind], code, lang);
}

/**
 * 「官方 key」不是后端概念，而是一份 base_url 清单的判断结果。
 * 清单在 Worker 的 TRUSTED_BASE_URLS 里，后端只回 trusted 布尔，这里只负责文案。
 */
export function trustLabel(trusted: boolean, lang: Lang): string {
  return translate(lang, trusted ? 'trust.trusted' : 'trust.untrusted');
}
