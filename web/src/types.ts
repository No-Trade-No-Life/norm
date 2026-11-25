/** 与 docs/api.md、src/store.ts 对齐的响应形状。 */

export type LoginResponse = {
  address: string;
  balance_nanos: number;
  created: boolean;
};

/** 三项 token 的合计口径：input 含 cache 命中，cached 是其中命中的那部分。 */
export type TokenTotals = {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
};

/** 钱的构成：一次服务费 + 三项 token 折出来的钱，以及没收上来的部分。 */
export type MoneyTotals = {
  service_fee_nanos: number;
  token_nanos: number;
  unbilled_nanos: number;
};

export type Me = {
  address: string;
  label: string;
  balance_nanos: number;
  granted_nanos: number;
  spend_nanos: number;
  requests: number;
  providers: number;
  usage: TokenTotals;
  billed: MoneyTotals;
  created_at: number;
};

/** 一次调用里关于 provider 的唯一事实：它落在哪台主机上。 */
export type CallFacts = { host: string };

/** 按 base_url 聚合的Provider。后端不做价值判断，trusted 只是清单命中与否。 */
export type BaseUrlGroup = {
  base_url: string;
  host: string;
  trusted: boolean;
  providers: number;
  public_listed: number;
  protocols: string[];
  last_seen_at: number;
};

export type Provider = {
  id: string;
  address: string;
  label: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  kdf: string;
  protocol: Protocol;
  visibility: Visibility;
  public_listed: number;
  /** 主机名是否在信任清单里；由后端用同一份清单算出，前端只负责措辞。 */
  trusted: boolean;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 一条请求记录。账本要回答的四件事都在这里：
 * 打给谁（base_url / provider_id）、谁发起（consumer_id）、用了多少 token、
 * 钱怎么算出来的（service_fee + token − unbilled = fee）。
 */
export type RequestRow = {
  id: string;
  address: string;
  provider_id: string | null;
  consumer_id: string | null;
  base_url: string;
  model: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  service_fee_nanos: number;
  token_nanos: number;
  fee_nanos: number;
  unbilled_nanos: number;
  created_at: number;
};

export type LedgerRow = {
  /** 翻页游标（D1 rowid）：这张表只追加，rowid 序就是时间序。 */
  cursor: number;
  id: string;
  address: string;
  request_id: string | null;
  kind: 'grant' | 'charge';
  amount_nanos: number;
  balance_after_nanos: number;
  created_at: number;
};

/** 下游消费者：库里只有 sha256 与提示，明文只在创建/轮换那一次出现。 */
export type Consumer = {
  id: string;
  address: string;
  name: string;
  /** 建的时候就绑死的 provider：调用时一条 Bearer 就够，不用再带第二个头。 */
  provider_id: string;
  /** LEFT JOIN 带上来的昵称与地址；Provider 被撤销后为 null。 */
  provider_label: string | null;
  provider_base_url: string | null;
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
  policy: { logs: string; storage: string; keys: string };
};

/** 一次调用的账单结论（响应里的 `norm` 字段，流式里是末帧）。 */
export type CallBill = {
  request_id: string;
  /** 真正从余额里扣掉的数 = service_fee + token − unbilled。 */
  fee_nanos: number;
  service_fee_nanos: number;
  token_nanos: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  /** 余额不足时没能收上来的部分；正常为 0。 */
  unbilled_nanos: number;
  balance_nanos: number | null;
  latency_ms: number;
  host: string;
};

/** 按下游消费者密钥聚合的用量：哪把钥匙花了多少。 */
export type ConsumerUsage = {
  consumer_id: string | null;
  consumer_name: string | null;
  key_hint: string | null;
  requests: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  fee_nanos: number;
};

/** 按 provider 聚合的用量：钱花在哪个Provider。 */
export type ProviderUsage = {
  provider_id: string | null;
  provider_label: string | null;
  requests: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  fee_nanos: number;
};

/** 公开价目表：纳美元 / 每百万 token。 */
export type Pricing = {
  unit: string;
  default: { input: number; cached: number; output: number };
  models: Array<{ match: string; input: number; cached: number; output: number }>;
  service_fee: { nanos: number; note: string };
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
  norm?: CallBill;
  error?: { message?: string } | string;
  message?: string;
};

/**
 * Provider 说哪种协议：决定 Norm 打 /chat/completions 还是 /responses。
 * 与「base_url 能不能自定义」无关——base_url 永远可自定义，创建后钉死。
 */
export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Provider 本身是否对公众可用。私有不代表掺水，只代表不对外。 */
export const VISIBILITIES = ['public', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
