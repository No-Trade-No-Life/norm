# Norm — 无站的中转站

> Serverless, 无站胜有站。BYOK + Ed25519 身份 + 逐请求隔离计费 + 可核验的上游来源 + 可信发布。

## 1. 灵魂

Norm 不是「一台你租给我的机器」，而是**一份公开可复现的转发规则**。
任何人都可以部署它，任何人都可以核对它的字节，因此「中转站可信」不再是一份承诺，而是一个可以自己跑一遍的构建。

## 2. 五条硬承诺

| # | 承诺 | Param Norm 的落地方式 |
|---|---|---|
| 1 | Serverless，单一部署 | 一个 Cloudflare Worker（Hono）+ 一个 D1 + 静态资源同源。没有运维机器、没有后台进程 |
| 2 | 用户 BYOK | 上游密钥只在请求里出现。仓库里没有任何上游密钥；数据库里只有客户端加密后的密文，服务端读不懂 |
| 3 | Ed25519（base58）身份 | 公钥即地址，私钥永不离开浏览器。每个请求都要签名，服务端不签发会话、不存密码 |
| 4 | ZDR，可信发布 | 不留请求体、不留响应体、不留上游密钥；构建产物哈希公开，任何人可 `pnpm build` 复算 |
| 5 | 上游来源可核验 | 每个凭证都要声明来源（官方 API Key / 官方订阅 / 自部署 / 其他），平台自动做信号核验并**公开**，掺水立刻可见 |

## 3. 身份

- 用户身份 = Ed25519 密钥对。地址 = `base58(publicKey)`（32 字节公钥 → 44 字符左右）。
- 私钥只存在于用户浏览器（IndexedDB/localStorage），可导出为 base58 以便换设备。
- 没有注册、没有邮箱、没有密码、没有 cookie 会话。
- 每个 API 请求自带签名：

```
X-Norm-Address:   <base58 公钥>
X-Norm-Timestamp: <unix 秒>
X-Norm-Nonce:     <22 字符 base58 随机串>
X-Norm-Signature: <base58 的 ed25519 签名>

message = "norm-v1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
```

服务端校验：时间窗 ±120 秒、nonce 未用过（D1 唯一键）、签名通过公钥验证。地址首次出现时自动开户。

## 4. BYOK

- 添加凭证时，浏览器用口令派生密钥（PBKDF2-SHA256 60 万轮 → XChaCha20-Poly1305）加密上游密钥，
  **只把密文**上传。服务端保存：label、provider、base_url、key_hint（前 4 后 4）、ciphertext、声明的来源。
- 真正调用模型时，用户在 Playground 里解锁，浏览器把明文密钥放进 `X-Norm-Upstream-Key` 头随请求发出。
  Worker 用完即弃，不写日志、不进 D1。
- 结论：站点被拖库，也拿不到任何人的上游密钥。

## 5. 计费：请求隔离纳入计费

- 因为 BYOK，上游的 Token 账单由用户直接付给上游，Norm 不碰这部分钱。
- Norm 只收**请求隔离费**：每一个会被隔离执行的请求都实实在在消耗 Worker 调用、D1 读写与日志额度。
  - 默认 `REQUEST_FEE_MICROS = 500`（$0.0005 / 请求），可在 `wrangler.jsonc` 的 `vars` 里调整。
- 账本是纯追加的 `ledger` 表：每一条 charge 都带 `request_id`，可以逐条回溯到那次调用。
- 余额单位为微美元（integer），不用浮点。新地址自动获得 $1.00 演示授信（`GRANT_MICROS = 1000000`）。
- 演示版不接入真实支付网络；链上 USDC 结算由 Midas 线路承担，见 `docs/roadmap.md`。

## 6. 上游来源可核验

每条凭证必须声明 `declared_source`：

- `official-api-key` — 官方 API Key
- `official-subscription` — 官方订阅（如网页版/订阅制额度）
- `self-hosted` — 自己部署的模型
- `other` — 其他

平台在**创建时**与**每次调用前**做的自动核验信号（写入 `provenance` JSON，公开可读）：

- `host`：`base_url` 的 host 是否命中官方主机表（openai.com / deepseek.com / anthropic.com / googleapis.com …）
- `key_prefix`：密钥格式是否匹配该 provider（`sk-`、`sk-ant-` 等）
- `models_probe`：用该密钥请求 `/models`，看返回的模型清单是否是官方集合的子集
- `checked_at`

`GET /api/v1/provenance` 公开列出所有打开「公开透明」开关的凭证及其核验结果。
`ASSUMPTION`：这些是**信号**而不是证明——一个伪造的官方 base_url 也能通过 host 检查。
所以 Norm 同时公开 base_url 原文与核验时间，让任何人都能自己重跑一次核验。

## 7. ZDR 与可信发布

- 不留请求体、不留响应体、不留上游密钥。唯一的持久化是记账所需的最小字段（模型名、token 数、状态、延迟、费用）。
- `GET /api/v1/attestation` 返回：git commit、构建时间、Worker 产物 sha256、前端产物 sha256、GitHub Actions Run 链接。
- 任何人 `git clone && pnpm i && pnpm build` 后算一次 sha256，与本页数字对比即可确认线上跑的代码就是这个仓库。
- 发布走 GitHub Actions + Cloudflare API Token，`main` 合并即上线，没有手工 `wrangler deploy`。

## 8. 这一版不做什么

- 不做协议转换：/v1/chat/completions 只做 OpenAI 兼容转发（上游的 `-LB` 负责把各家协议标准化）。
- 不做多租户运营后台、不做限速策略、不做模型路由。
- 不做真实支付。
