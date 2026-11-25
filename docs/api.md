# Norm API

Base: `https://norm.ntnl.io`。

两种身份，职责不同，按前缀划分：

| 前缀 | 接受什么 | 用来干什么 |
|---|---|---|
| `/api/v1/*` | **只**接受 Ed25519 请求签名 | 管理面：账户、上游提供商、下游消费者 Token，都是「浏览器里的人在操作」 |
| `/v1/*` | 签名**或** `Authorization: Bearer sk-norm-…` | 转发面：消费。程序拿一条 Token 就能调用（账户只有一条上游提供商时无需任何专有头） |

一句话：**身份只管资源，消费只用一个 api key。** 下游 Token 不绑定上游提供商——账户里只有一条上游提供商
提供者时消费侧不需要任何 Norm 专有的头；有多条时才用 `X-Norm-Provider` 指名。

公开接口（`health` / `stats` / `base-urls` / `attestation`）两种都不需要。

## 签名

```
message = "norm-v1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
```

请求头：`X-Norm-Address`、`X-Norm-Timestamp`、`X-Norm-Nonce`、`X-Norm-Signature`（均为 base58）。

## 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | `{ok, service, version, now}` |
| GET | `/api/v1/stats` | `{principals, providers, requests, spend_nanos, window_hours}` |
| GET | `/api/v1/base-urls` | 按 base_url 聚合的上游提供商（含 `trusted` 布尔） |
| GET | `/api/v1/attestation` | 构建证明 |

`/api/v1/attestation` 的 `policy` 只给机器可读的编号，措辞由客户端自己决定（英文界面不该显示中文句子）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `policy.logs` | `no-bodies` | 不留请求体、不留响应体、不留上游提供商密钥 |
| `policy.storage` | `billing-fields-only` | D1 只存记账所需的最小字段 |
| `policy.keys` | `sealed-at-rest` | 上游提供商密钥只在请求头经过，库里只有密文 |

不在表里的取值原样显示——后端新增一条策略不会让前端白屏或吞掉信息。

## 身份

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 签名访问一次即开户。返回 `{address, balance_nanos, created}` |

## 账户（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/account/me` | `{address, label, balance_nanos, granted_nanos, spend_nanos, requests, providers, usage:{input_tokens,cached_tokens,output_tokens}, billed:{service_fee_nanos,token_nanos,unbilled_nanos}}` |
| GET | `/api/v1/account/usage?limit=50&before=<request_id>` | 请求记录（不含内容），按 `request_id`（UUID v7）倒序游标翻页 |
| GET | `/api/v1/account/ledger?limit=50&cursor=<rowid>` | 记账流水，游标是上一页最后一行的 `cursor` |
| GET | `/api/v1/account/usage/by-consumer` | 按下游消费者密钥聚合：`{consumer_id, consumer_name, key_hint, requests, input_tokens, cached_tokens, output_tokens, fee_nanos}` |
| GET | `/api/v1/account/usage/by-provider` | 按上游提供商聚合（同上，`provider_id` / `provider_label`） |

请求记录里每一行都能自己重算一遍：

```
fee_nanos = service_fee_nanos + token_nanos − unbilled_nanos
```

`input_tokens` **含**缓存命中，`cached_tokens` 是其中命中上游提供商缓存的量（按便宜的价算），
`output_tokens` 单独计价。余额不够时 `unbilled_nanos` 大于 0——那是站点承担的部分，如实记账。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/pricing` | 公开价目表：`{unit, default, models, service_fee}`，单位是**纳美元 / 每百万 token** |

## 上游提供商（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/providers` | 本人的上游提供商（含密文与 hint，不含明文密钥） |
| POST | `/api/v1/providers` | 新建，body 见下 |
| POST | `/api/v1/providers/:id/visibility` | `{public_listed: bool}` |
| DELETE | `/api/v1/providers/:id` | 撤销 |

```jsonc
// POST /api/v1/providers  → 201 { id }
{
  "label": "OpenAI 个人",                     // 必填，人看的名字；没有默认值
  "base_url": "https://api.openai.com/v1",    // 任意上游提供商，创建后不可改写
  "provider_key": "sk-…",                     // 明文，只在这一次请求里；服务端立刻 AES-256-GCM 封装

  // 可选，默认最保守：openai-chat / private
  "protocol": "openai-chat",         // openai-chat | openai-responses
                                              // | anthropic-messages | google-gemini
  "visibility": "private"            // public | private（上游提供商本身是否对公众可用）
}
```

`key_hint` 由服务端从明文算出（前 4 + `…` + 后 4），不接受客户端自报——否则提示与真实密钥可以不一致。

响应里的每条上游提供商还带一个 `trusted` 布尔：`base_url` 的主机名是否在 Worker 的
`TRUSTED_BASE_URLS` 清单里。后端只回这个事实，「官方 / 清单外」的措辞是前端的事。

## 下游消费者 Token（签名）

给下游程序用的 `sk-norm-…`。**只要一个名字**：Token 说明「这段代码是谁在调用」，
不绑定任何上游提供商。明文只在创建与轮换的响应里出现一次，之后只有 `key_hint`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/consumers` | `{items: [{id, name, key_hint, created_at, last_used_at}]}`（不含哈希） |
| POST | `/api/v1/consumers` | `{name}` → `201 {id, name, key, key_hint}`，`key` 只此一次 |
| POST | `/api/v1/consumers/:id/rotate` | → `{id, key, key_hint}`，旧钥立刻失效，名字不变 |
| POST | `/api/v1/consumers/:id/name` | `{name}` |
| DELETE | `/api/v1/consumers/:id` | 撤销 |

`name` 必填：缺少 → `400 name_missing`。请求体里若还带着旧的 `provider_id`，直接忽略。

## 转发（签名或 Bearer 消费者密钥）

四个入口，四种上游提供商，构成 4×4。**入口方言与上游提供商协议同名**：

| 入口 | 客户端 | 上游提供商协议 `openai-chat` | `openai-responses` | `anthropic-messages` | `google-gemini` |
|---|---|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI SDK / curl | 直通 | 转换 | 转换 | 转换 |
| `POST /v1/responses` | Codex CLI | 转换 | 直通 | 转换 | 转换 |
| `POST /v1/messages` | Anthropic SDK / Claude Code | 转换 | 转换 | 直通 | 转换 |
| `POST /v1/models/{model}:generateContent` | Google SDK | 转换 | 转换 | 转换 | 直通 |

**对角线不转换。** 入口方言等于上游提供商的 `protocol` 时，请求体按原始字节发给上游提供商，
响应体原样返回（只多一个 `norm` 字段）。一个字段都不碰，包括 `tools`、`tool_choice`、
`response_format` 这些我们没打算理解的字段。

**非对角线才过桥**：入口方言 → OpenAI Chat → 协议适配器 → 回来时渲染成入口方言。
桥只在一侧出现，所以矩阵是 4 段入口翻译加 4 段上游提供商适配，不是 16 条路径。

**跨方言不翻译工具调用。** 三家的 tools 形状不同，硬拼一个「尽力而为」的映射，只会在
客户端以为有 function calling 时收到一段散文。所以跨方言带 `tools` / `functions` 会直接
`400 tools_unsupported`；同格式直通不受影响（我们不碰请求体）。

流式：`stream: true` 或 Gemini 的 `:streamGenerateContent`。跨方言时上游提供商 SSE 被翻译成
入口方言自己的帧（`response.output_text.delta` / `content_block_delta` / `candidates`
裸 data 帧）。用量一边转发一边从上游提供商的帧里嗅出来（四家的位置各不相同：chat 在末帧、
Anthropic 在 `message_start` + `message_delta`、Gemini 每帧累计、Responses 在
`response.completed`），所以**收尾帧里的 token 数就是记账用的那一份**；上游提供商一次都没给时
三项都是 0，账单也就只有服务费。
同格式直通时上游提供商的帧原样到达，一个事件都不加——`request_id` 从 `X-Norm-Request-Id` 响应头读。
唯一的例外是 `/v1/chat/completions` 直通：流末插一条 `{"norm":…}`，因为 Playground 是它的客户端。

| 头 | 消费（Bearer） | 签名 |
|---|---|---|
| `Authorization: Bearer sk-norm-…` | 必填，三选一（OpenAI SDK 的形状） | — |
| `x-api-key: sk-norm-…` | 三选一（Anthropic SDK / Claude Code 的形状） | — |
| `x-goog-api-key: sk-norm-…` | 三选一（Google SDK 的形状） | — |
| `X-Norm-Provider` | 可选：账户只有一条上游提供商时可省，多条时必填 | 同样可选：只有一条上游提供商时可省 |
| `X-Norm-Address` 等四个签名头 | — | 必填（见上一节） |

上游提供商密钥始终由服务端解密，客户端不接触它。

**没有凭据头时走哪条上游提供商**：账户里恰好有一条（未撤销的）上游提供商就用它；一条都没有 →
`400 provider_missing`；有多条 → `409 provider_ambiguous`，请在请求里用 `X-Norm-Provider`
指名。指名了一条不属于本人或已撤销的上游提供商 → `404 provider_not_found`。
这条规则对签名身份与 Bearer 一视同仁：绑定不是身份的一部分，是每次转发自己的决定。

三个 api key 头里只有带 `sk-norm-` 前缀的值会被当成消费者密钥；别家的 key 会走签名那条路失败。

```bash
# 一条 api key 就是完整的一次调用：没有签名头，也没有 Norm 专有的头
curl https://norm.ntnl.io/v1/chat/completions \
  -H "Authorization: Bearer sk-norm-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

```bash
# Claude Code 的形状：x-api-key + Anthropic Messages 入口，同样不需要别的头
# （上游提供商的 protocol 是 anthropic-messages 时这一路是直通；别的协议由 Norm 翻译）
curl https://norm.ntnl.io/v1/messages \
  -H "x-api-key: sk-norm-…" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

请求头**不能**改写目的地：早期版本的 `X-Norm-Base-Url` 已删除，带上它也不会生效
（e2e 里有专门一条断言盯着这件事）。

Non-stream 响应在标准 body 之外附带 `norm` 对象：

```jsonc
{
  "...": "OpenAI 响应原样",
  "norm": { "request_id": "req_…", "fee_nanos": 500, "balance_nanos": 999500, "latency_ms": 812,
            "host": "api.openai.com" }
}
```

`/v1/chat/completions` 的流式在最后一个 SSE 事件之前插入一条 `data: {"norm":{...}}`；
另外三条入口的流式不插（那些 SDK 按 `type` 严格分派，插一个它们不认识的事件比丢一条记账信息更糟）。

## 模型清单（签名或 Bearer 消费者密钥）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 这个上游有哪些模型。`{object:"list", data:[{id, object:"model", created?, owned_by?}]}` |
| GET | `/v1/models/{model}` | 单个模型；不在上游清单里 → `404 model_not_found` |

两种上游都能用，认上游的规则与转发完全一样（`X-Norm-Credential`，或账户只有一条时省略）。
上游的清单在这里被归一成 OpenAI 形状，所以一个客户端不必知道自己接的是哪家：

| `upstream_protocol` | 问的上游路径 | 上游回什么 |
|---|---|---|
| `openai-chat` / `openai-responses` | `{base}/models` | `data[].id` + `created` + `owned_by` |
| `anthropic-messages` | `{base}/v1/models` | `data[].id` + `created_at`（ISO 字符串 → unix 秒），没有 `owned_by` |
| `google-gemini` | `{base}/v1beta/models` | `models[].name`，`models/` 前缀被剥掉 |

`created` / `owned_by` 不是每家都给，缺了就不编——**空字段比假字段好**。模型名里可能有斜杠
（`meta-llama/Llama-3`、`models/gemini-2.0-flash`），所以 `/v1/models/{model}` 收整段剩余路径。

**这一路不扣费**：列清单不是一次模型调用，没有生成、没有 token。它不写请求记录、不动账本，
响应里的 `norm` 明确写着 `fee_micros: 0`、`balance_micros: null`（没去读余额，所以不报一个可能过期的数）。
上游失败时它的原话原样返回，与转发同一套做法。

```bash
curl https://norm.ntnl.io/v1/models -H "Authorization: Bearer sk-norm-…"
```
