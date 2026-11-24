/** 与 docs/api.md、src/store.ts 对齐的响应形状。 */

export type LoginResponse = {
  address: string;
  balance_micros: number;
  created: boolean;
};

export type Me = {
  address: string;
  label: string;
  balance_micros: number;
  granted_micros: number;
  spend_micros: number;
  requests: number;
  credentials: number;
  created_at: number;
};

export type ProvenanceSignals = {
  declared_source: string;
  verified: boolean;
  signals: string[];
  host?: string;
};

export type ProvenanceDetail = {
  declared_source: string;
  verified: boolean;
  signals: string[];
  checks: { host: boolean; key_prefix: boolean; models_probe: boolean | null };
  host: string;
  checked_at: number;
  note: string;
};

export type Credential = {
  id: string;
  address: string;
  label: string;
  provider: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  kdf: string;
  declared_source: string;
  public_listed: number;
  provenance: string;
  created_at: number;
  revoked_at: number | null;
};

export type RequestRow = {
  id: string;
  address: string;
  credential_id: string | null;
  model: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  fee_micros: number;
  provenance: string;
  created_at: number;
};

export type LedgerRow = {
  id: string;
  address: string;
  request_id: string | null;
  kind: 'grant' | 'charge';
  amount_micros: number;
  balance_after_micros: number;
  created_at: number;
};

export type ProvenanceItem = {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  key_hint: string;
  declared_source: string;
  provenance: ProvenanceDetail;
  created_at: number;
};

export type Attestation = {
  service: string;
  repository: string;
  commit: string | null;
  built_at: string | null;
  source_sha256: string | null;
  assets_sha256: string | null;
  run_url: string | null;
  policy: { logs: string; storage: string; keys: string };
};

export type ChatChunk = {
  id?: string;
  model?: string;
  choices?: Array<{ delta?: { content?: string; role?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  norm?: {
    request_id: string;
    fee_micros: number;
    balance_micros: number | null;
    latency_ms: number;
    provenance: ProvenanceSignals;
  };
  error?: { message?: string } | string;
  message?: string;
};

export const PROVIDERS = [
  'openai',
  'deepseek',
  'anthropic',
  'google',
  'xai',
  'moonshot',
  'zhipu',
  'qwen',
  'self-hosted',
  'other',
] as const;

export const SOURCES = ['official-api-key', 'official-subscription', 'self-hosted', 'other'] as const;
