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

/** 一次调用里关于上游的唯一事实：它落在哪台主机上。 */
export type CallFacts = { host: string };

/** 按 base_url 聚合的上游渠道。后端不做价值判断，trusted 只是清单命中与否。 */
export type BaseUrlGroup = {
  base_url: string;
  host: string;
  trusted: boolean;
  credentials: number;
  public_listed: number;
  protocols: string[];
  last_seen_at: number;
};

export type Credential = {
  id: string;
  address: string;
  label: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  kdf: string;
  upstream_protocol: UpstreamProtocol;
  upstream_visibility: UpstreamVisibility;
  public_listed: number;
  /** 主机名是否在信任清单里；由后端用同一份清单算出，前端只负责措辞。 */
  trusted: boolean;
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

/** 下游消费者：库里只有 sha256 与提示，明文只在创建/轮换那一次出现。 */
export type Consumer = {
  id: string;
  address: string;
  name: string;
  /** 不绑定上游：走哪条上游是每次转发自己的决定。 */
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type Attestation = {
  service: string;
  repository: string;
  commit: string | null;
  built_at: string | null;
  source_sha256: string | null;
  assets_sha256: string | null;
  run_url: string | null;
  /** 机器可读的策略编号：措辞留在前端字典里，后端只报「是哪一条」。 */
  policy: { logs: string; storage: string; keys: string };
};

export type ChatChunk = {
  id?: string;
  model?: string;
  choices?: Array<{ delta?: { content?: string; role?: string }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  norm?: {
    request_id: string;
    fee_micros: number;
    balance_micros: number | null;
    latency_ms: number;
    host: string;
  };
  error?: { message?: string } | string;
  message?: string;
};

/**
 * 上游说哪种协议：决定 Norm 打 /chat/completions 还是 /responses。
 * 与「base_url 能不能自定义」无关——base_url 永远可自定义，创建后钉死。
 */
export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'] as const;
export type UpstreamProtocol = (typeof PROTOCOLS)[number];

/** 上游本身是否对公众可用。私有不代表掺水，只代表不对外。 */
export const VISIBILITIES = ['public', 'private'] as const;
export type UpstreamVisibility = (typeof VISIBILITIES)[number];
