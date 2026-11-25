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
  gas_fee_nanos: number;
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
  /** 体感：平均首字（只统计有首字的调用）与平均总耗时。 */
  latency: { avg_first_token_ms: number; avg_latency_ms: number; streamed_requests: number };
  created_at: number;
};

/** 一次调用里关于上游提供商的唯一事实：它落在哪台主机上。 */
export type CallFacts = { host: string };

/** 按 base_url 聚合的上游提供商。后端不做价值判断，trusted 只是清单命中与否。 */
export type BaseUrlGroup = {
  base_url: string;
  host: string;
  trusted: boolean;
  providers: number;
  public_listed: number;
  protocols: string[];
  last_seen_at: number;
};

/** 一条上游属于谁：私有只给主人用，公共池是全站兜底。 */
export type ProviderScope = 'private' | 'pool';

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
  /** private = 只有我这条能用；pool = 公共池，全站在自己的上游不可用时兜底用它。 */
  scope: ProviderScope;
  /** true = 本账户名下的；false = 池子里站点那条（只读，密钥提示与密文都不回）。 */
  mine: boolean;
  /** 1 = 启用，0 = 禁用。禁用后不参与选址。 */
  enabled: number;
  public_listed: number;
  /** 主机名是否在信任清单里；由后端用同一份清单算出，前端只负责措辞。 */
  trusted: boolean;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 一条请求记录。账本要回答的四件事都在这里：
 * 打给谁（base_url / provider_id）、谁发起（consumer_id）、用了多少 token、
 * 钱怎么算出来的（gas_fee + token − unbilled = fee）。
 */
export type RequestRow = {
  id: string;
  address: string;
  provider_id: string | null;
  /** 收钱那一方的地址（Ed25519 公钥）：公共池时不是调用方自己。 */
  provider_user: string | null;
  /** 花钱那一方的地址：消费者密钥属于谁；签名直连时为空。 */
  consumer_user: string | null;
  consumer_id: string | null;
  base_url: string;
  model: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  /** 首字延迟：流式调用才有；非流式没有这个事件，为 null。 */
  first_token_ms: number | null;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  gas_fee_nanos: number;
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
  /** 不绑定上游提供商：走哪条是每次转发自己的决定。 */
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
  /** 真正从余额里扣掉的数 = gas_fee + token − unbilled。 */
  fee_nanos: number;
  gas_fee_nanos: number;
  token_nanos: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  /** 余额不足时没能收上来的部分；正常为 0。 */
  unbilled_nanos: number;
  balance_nanos: number | null;
  latency_ms: number;
  host: string;
  /** true = 这一单落到了公共池上（自己的上游一条都不可用）。 */
  pool: boolean;
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

/** 按上游提供商聚合的用量：钱花在哪个上游提供商。 */
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
/** 三项单价（纳美元 / 1M token）。 */
export type PricingRates = { input: number; cached: number; output: number };

/**
 * 协议自带的定价模式：同一批型号两档价，按请求时刻选档（目前只有 `deepseek`）。
 * `peak_windows_utc` 是高峰时段，`peak_weekdays` 是高峰星期（ISO：1 = 周一），
 * `off_peak_days` 是全天按低谷的法定节假日。
 */
export type ProtocolPricing = {
  protocol: Protocol;
  kind: 'time-tiered';
  peak_windows_utc: string[];
  peak_weekdays: number[];
  off_peak_days: string[];
  models: Array<{ match: string; peak: PricingRates; off_peak?: PricingRates }>;
};

/** `/api/v1/pricing`：通用平表 + 协议自带的定价模式。 */
export type Pricing = {
  unit: string;
  default: PricingRates;
  models: Array<{ match: string } & PricingRates>;
  /** 老版本后端没有这段：读的时候当空表。 */
  protocols?: ProtocolPricing[];
  gas_fee: { nanos: number; note: string };
};

/** `/v1/models` 的一个条目：四种上游的清单在服务端被归一成这一个形状。 */
export type ModelItem = {
  id: string;
  object: 'model';
  created?: number;
  owned_by?: string;
};

/**
 * 清单响应。列清单不是模型调用：不生成、不扣服务费、也没去读余额，
 * 所以账单一律是 0，`balance_nanos` 为 null（不报一个可能过期的数）。
 */
export type ModelList = {
  object: 'list';
  data: ModelItem[];
  norm?: {
    request_id: string;
    fee_nanos: number;
    gas_fee_nanos: number;
    token_nanos: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    unbilled_nanos: number;
    balance_nanos: number | null;
    latency_ms: number;
    host: string;
  };
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
 * 上游提供商说哪种协议：决定 Norm 打 /chat/completions 还是 /responses。
 * `deepseek` 是说 Responses 方言、但价目按官方时段分两档的那一条厂商变体。
 * 与「base_url 能不能自定义」无关——base_url 永远可自定义，创建后钉死。
 */
export const PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
  'deepseek',
] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/**
 * 一条协议的上游契约（`GET /api/v1/protocols`）：说哪种方言、基址从哪来、配置一条这种
 * 上游要填哪些字段。表单「先选协议、再按协议渲染字段」读的就是它——前端不再自己记
 * 「哪条协议不要 base_url」。
 */
export type ProtocolSchema = {
  protocol: Protocol;
  /** 线缆上的方言：`deepseek` 是 `openai-responses`。 */
  dialect: string;
  /** 协议钉死的上游基址；null = 由用户填。 */
  base_url: string | null;
  /** 要填的字段，按表单顺序。 */
  fields: Array<'base_url' | 'provider_key'>;
};

/** 上游提供商本身是否对公众可用。私有不代表掺水，只代表不对外。 */
export const VISIBILITIES = ['public', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** 管理面看到的模型：一行一个模型名，providers 是提供它的上游提供商 id。 */
export type CatalogModel = {
  id: string;
  providers: string[];
  created?: number;
  owned_by?: string;
  /**
   * 官方按量付费价（纳美元 / 1M token），只作锚点；没收录就是 null。
   * `input / cached / output` 是高峰价，按时段折价的上游多一个 `off_peak`。
   */
  official: {
    match: string;
    input: number;
    cached: number;
    output: number;
    off_peak?: { input: number; cached: number; output: number };
  } | null;
};

/**
 * 一次探测的结果，按上游提供商记。
 * probed 为 false 时 ok 是 null：没问，不等于失败。
 */
export type CatalogProvider = {
  id: string;
  label: string;
  base_url: string;
  host: string;
  protocol: Protocol;
  visibility: Visibility;
  public_listed: number;
  trusted: boolean;
  /** private / pool：池子那条是站点提供的兜底产能。 */
  scope: ProviderScope;
  /** true = 本账户名下；false = 池子里只读的那条。 */
  mine: boolean;
  enabled: number;
  probed: boolean;
  ok: boolean | null;
  count: number;
  latency_ms: number | null;
  error: string | null;
};

/** 账户的模型总表：所有启用中的上游提供商各自回了什么，并成一张表。 */
export type ModelCatalog = {
  fetched_at: number;
  providers: CatalogProvider[];
  models: CatalogModel[];
};
