# Norm API

Base: `https://norm.ntnl.io`。所有 `/api/v1/*`（除 health/stats/attestation/provenance）与 `/v1/*` 都需要请求签名。

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
| GET | `/api/v1/provenance` | 公开凭证的来源与核验信号数组 |
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
  "provider": "openai",              // openai | deepseek | anthropic | google | self-hosted | other
  "base_url": "https://api.openai.com/v1",
  "key_hint": "sk-…1234",
  "sealed_key": "base58 密文",
  "kdf": "pbkdf2-sha256-600000+xchacha20poly1305",
  "declared_source": "official-api-key"
}
```

## 转发（签名）

`POST /v1/chat/completions` — 严格 OpenAI 兼容，支持 `stream: true`。

| 头 | 必填 | 说明 |
|---|---|---|
| `X-Norm-Credential` | 是 | 用于归属与来源核验的凭证 id |
| `X-Norm-Upstream-Key` | 是 | 上游明文密钥，仅本次请求有效 |
| `X-Norm-Base-Url` | 否 | 覆盖凭证的 base_url（用于自部署端点） |

Non-stream 响应在标准 body 之外附带 `norm` 对象：

```jsonc
{
  "...": "OpenAI 响应原样",
  "norm": { "request_id": "req_…", "fee_micros": 500, "balance_micros": 999500, "latency_ms": 812,
            "provenance": { "declared_source": "official-api-key", "verified": true, "signals": ["host","key_prefix","models_probe"] } }
}
```

Stream 响应在最后一个 SSE 事件之前插入一条 `data: {"norm":{...}}` 事件。
