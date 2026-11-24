# Norm API

Base: `https://norm.ntnl.io`。所有 `/api/v1/*`（除 health/stats/base-urls/attestation）与 `/v1/*` 都需要请求签名。

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
| GET | `/api/v1/me` | `{address, label, balance_micros, granted_micros, requests, spend_micros}` |
| GET | `/api/v1/usage?limit=50&cursor=` | 请求记录（不含内容） |
| GET | `/api/v1/ledger?limit=50` | 记账流水 |

## 凭证（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/credentials` | 本人凭证（含密文与 hint，不含明文密钥） |
| POST | `/api/v1/credentials` | 新建，body 见下 |
| POST | `/api/v1/credentials/:id/visibility` | `{public_listed: bool}` |
| DELETE | `/api/v1/credentials/:id` | 撤销 |

```jsonc
// POST /api/v1/credentials
{
  "label": "OpenAI 个人",
  "provider": "openai",                       // 只是个标签：openai | deepseek | anthropic | google | xai
                                              // | moonshot | zhipu | qwen | self-hosted | other
  "base_url": "https://api.openai.com/v1",    // 任意上游，创建后钉死，转发时不可改写
  "key_hint": "sk-…1234",
  "sealed_key": "base58 密文",
  "kdf": "pbkdf2-sha256-600000+xchacha20poly1305",

  // 可选，默认最保守：openai-chat / private
  "upstream_protocol": "openai-chat",         // openai-chat | openai-responses
                                              // | anthropic-messages | google-gemini
  "upstream_visibility": "private"            // public | private（上游本身是否对公众可用）
}
```

响应里的每条凭证还带一个 `trusted` 布尔：`base_url` 的主机名是否在 Worker 的
`TRUSTED_BASE_URLS` 清单里。后端只回这个事实，「官方 / 清单外」的措辞是前端的事。

## 转发（签名）

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
| `X-Norm-Credential` | 是 | 凭证 id，决定发往哪个上游 |
| `X-Norm-Upstream-Key` | 是 | 上游明文密钥，仅本次请求有效 |

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
