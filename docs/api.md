# Norm API

Base: `https://norm.ntnl.io`。

两种身份，按前缀划分：

| 前缀 | 接受什么 | 用来干什么 |
|---|---|---|
| `/api/v1/*` | **只**接受 Ed25519 请求签名 | 账户、上游提供者、下游消费者密钥：都是「浏览器里的人在操作」 |
| `/v1/*` | 签名**或** `Authorization: Bearer sk-norm-…` | 转发：程序拿消费者密钥就能调用 |

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
| GET | `/api/v1/stats` | `{principals, credentials, requests, spend_micros, window_hours}` |
| GET | `/api/v1/base-urls` | 按 base_url 聚合的上游渠道（含 `trusted` 布尔） |
| GET | `/api/v1/attestation` | 构建证明 |

## 身份

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 签名访问一次即开户。返回 `{address, balance_micros, created}` |

## 账户（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/account/me` | `{address, label, balance_micros, granted_micros, requests, spend_micros}` |
| GET | `/api/v1/account/usage?limit=50` | 请求记录（不含内容） |
| GET | `/api/v1/account/ledger?limit=50` | 记账流水 |

## 上游提供者（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/credentials` | 本人的上游提供者（含密文与 hint，不含明文密钥） |
| POST | `/api/v1/credentials` | 新建，body 见下 |
| POST | `/api/v1/credentials/:id/visibility` | `{public_listed: bool}` |
| DELETE | `/api/v1/credentials/:id` | 撤销 |

```jsonc
// POST /api/v1/credentials  → 201 { id }
{
  "label": "OpenAI 个人",
  "provider": "openai",                       // 只是个标签：openai | deepseek | anthropic | google | xai
                                              // | moonshot | zhipu | qwen | self-hosted | other
  "base_url": "https://api.openai.com/v1",    // 任意上游，创建后钉死，转发时不可改写
  "upstream_key": "sk-…",                     // 明文，只在这一次请求里；服务端立刻 AES-256-GCM 封装

  // 可选，默认最保守：openai-chat / private
  "upstream_protocol": "openai-chat",         // openai-chat | openai-responses
                                              // | anthropic-messages | google-gemini
  "upstream_visibility": "private"            // public | private（上游本身是否对公众可用）
}
```

`key_hint` 由服务端从明文算出（前 4 + `…` + 后 4），不接受客户端自报——否则提示与真实密钥可以不一致。

响应里的每条凭证还带一个 `trusted` 布尔：`base_url` 的主机名是否在 Worker 的
`TRUSTED_BASE_URLS` 清单里。后端只回这个事实，「官方 / 清单外」的措辞是前端的事。

## 下游消费者（签名）

给下游程序用的 `sk-norm-…`。明文只在创建与轮换的响应里出现一次，之后只有 `key_hint`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/consumers` | `{items: [{id, name, key_hint, created_at, last_used_at}]}`（不含哈希） |
| POST | `/api/v1/consumers` | `{name}` → `201 {id, name, key, key_hint}`，`key` 只此一次 |
| POST | `/api/v1/consumers/:id/rotate` | → `{id, key, key_hint}`，旧钥立刻失效 |
| POST | `/api/v1/consumers/:id/name` | `{name}` |
| DELETE | `/api/v1/consumers/:id` | 撤销 |

## 转发（签名或 Bearer 消费者密钥）

四个入口，四种上游，构成 4×4。**入口方言与上游协议同名**：

| 入口 | 客户端 | 上游协议 `openai-chat` | `openai-responses` | `anthropic-messages` | `google-gemini` |
|---|---|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI SDK / curl | 直通 | 转换 | 转换 | 转换 |
| `POST /v1/responses` | Codex CLI | 转换 | 直通 | 转换 | 转换 |
| `POST /v1/messages` | Anthropic SDK / Claude Code | 转换 | 转换 | 直通 | 转换 |
| `POST /v1/models/{model}:generateContent` | Google SDK | 转换 | 转换 | 转换 | 直通 |

**对角线不转换。** 入口方言等于凭证的 `upstream_protocol` 时，请求体按原始字节发给上游，
响应体原样返回（只多一个 `norm` 字段）。一个字段都不碰，包括 `tools`、`tool_choice`、
`response_format` 这些我们没打算理解的字段。

**非对角线才过桥**：入口方言 → OpenAI Chat → 上游适配器 → 回来时渲染成入口方言。
桥只在一侧出现，所以矩阵是 4 段入口翻译加 4 段上游适配，不是 16 条路径。

**跨方言不翻译工具调用。** 三家的 tools 形状不同，硬拼一个「尽力而为」的映射，只会在
客户端以为有 function calling 时收到一段散文。所以跨方言带 `tools` / `functions` 会直接
`400 tools_unsupported`；同格式直通不受影响（我们不碰请求体）。

流式：`stream: true` 或 Gemini 的 `:streamGenerateContent`。跨方言时上游 SSE 被翻译成
入口方言自己的帧（`response.output_text.delta` / `content_block_delta` / `candidates`
裸 data 帧），**不报 token 用量**（上游不一定在中途给，冒充数字不如留 0，记账同样是 0）。
同格式直通时上游的帧原样到达，一个事件都不加——`request_id` 从 `X-Norm-Request-Id` 响应头读。
唯一的例外是 `/v1/chat/completions` 直通：流末插一条 `{"norm":…}`，因为 Playground 是它的客户端。

| 头 | 必填 | 说明 |
|---|---|---|
| `X-Norm-Credential` | 是 | 上游提供者 id，决定发往哪个上游（上游密钥由服务端解密，客户端不接触） |
| `Authorization: Bearer sk-norm-…` | 三选一 | OpenAI SDK 的形状 |
| `x-api-key: sk-norm-…` | 三选一 | Anthropic SDK / Claude Code 的形状 |
| `x-goog-api-key: sk-norm-…` | 三选一 | Google SDK 的形状 |
| `X-Norm-Address` 等四个签名头 | 三选一 | Ed25519 身份 |

三个 api key 头里只有带 `sk-norm-` 前缀的值会被当成消费者密钥；别家的 key 会走签名那条路失败。

```bash
# Claude Code 的形状：x-api-key + Anthropic Messages 入口
curl https://norm.ntnl.io/v1/messages \
  -H "x-api-key: sk-norm-…" \
  -H "X-Norm-Credential: cred_…" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

请求头**不能**改写目的地：早期版本的 `X-Norm-Base-Url` 已删除，带上它也不会生效
（e2e 里有专门一条断言盯着这件事）。

Non-stream 响应在标准 body 之外附带 `norm` 对象：

```jsonc
{
  "...": "OpenAI 响应原样",
  "norm": { "request_id": "req_…", "fee_micros": 500, "balance_micros": 999500, "latency_ms": 812,
            "host": "api.openai.com" }
}
```

`/v1/chat/completions` 的流式在最后一个 SSE 事件之前插入一条 `data: {"norm":{...}}`；
另外三条入口的流式不插（那些 SDK 按 `type` 严格分派，插一个它们不认识的事件比丢一条记账信息更糟）。
