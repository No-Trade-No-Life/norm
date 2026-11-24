# Norm API

Base: `https://norm.ntnl.io`。

两种身份，按前缀划分：

| 前缀 | 接受什么 | 用来干什么 |
|---|---|---|
| `/api/v1/*` | **只**接受 Ed25519 请求签名 | 账户、凭证、消费者密钥：都是「浏览器里的人在操作」 |
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

## 凭证（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/credentials` | 本人凭证（含密文与 hint，不含明文密钥） |
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

客户端**只**说 OpenAI Chat，上游的方言由凭证决定、由 Norm 在边界处翻译：

| 端点 | 上游路径（按 `upstream_protocol`） |
|---|---|
| `POST /v1/chat/completions` | `openai-chat` → `{base}/chat/completions` |
| | `openai-responses` → `{base}/responses` |
| | `anthropic-messages` → `{base}/v1/messages` |
| | `google-gemini` → `{base}/v1beta/models/{model}:generateContent`（流式 `:streamGenerateContent?alt=sse`） |

支持 `stream: true`；流式一律返回 OpenAI chat chunk。

| 头 | 必填 | 说明 |
|---|---|---|
| `X-Norm-Credential` | 是 | 凭证 id，决定发往哪个上游（上游密钥由服务端解密，客户端不接触） |
| `X-Norm-Address` 等四个签名头 | 二选一 | Ed25519 身份 |
| `Authorization: Bearer sk-norm-…` | 二选一 | 下游消费者密钥；与签名互斥，带上它就不再验签 |

```bash
curl https://norm.ntnl.io/v1/chat/completions \
  -H "Authorization: Bearer sk-norm-…" \
  -H "X-Norm-Credential: cred_…" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
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

Stream 响应在最后一个 SSE 事件之前插入一条 `data: {"norm":{...}}` 事件。
