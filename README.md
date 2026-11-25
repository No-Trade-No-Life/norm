<div align="center">

# Norm

**无站的中转站。** 一份公开可复现的转发规则，而不是一台你租给我的机器。

`https://norm.ntnl.io`

</div>

## 这是什么

Norm 是一个 **Serverless 的 AI 中转站**：一个 Cloudflare Worker + 一个 D1。它不持有任何 provider 密钥，
不签发会话，不存请求内容。用户用自己的 provider 密钥（BYOK）调用，身份是自己持有的 Ed25519 密钥，
每一条被隔离执行的请求都单独计费，每一个 provider 的来源都公开可核验。

「中转站可信」在 Norm 里不是一个承诺，而是一个**可以自己跑一遍的构建**。

## 五条硬承诺

| 承诺 | 落地方式 |
|---|---|
| **Serverless，单一部署** | 一个 Worker（Hono）+ 一个 D1 + 同源静态资源。没有运维机器、没有后台进程 |
| **BYOK** | Provider 密钥只在请求头里经过。库里只有客户端加密后的密文，服务端读不懂 |
| **身份与消费分开** | 身份 = Ed25519 公钥（管资源，私钥永不离开浏览器，无注册无密码无 cookie；密钥是 64 字节拓展形式 `seed‖publicKey`，与 Solana 密钥种子同形）；消费 = `sk-norm-…` Token（只记名字，不绑 provider），一条 Bearer 就够 |
| **ZDR + 可信发布** | 不留请求体、响应体、Provider 密钥；构建哈希公开，任何人可 `pnpm build` 复算 |
| **Provider 来源可核验** | 每个 provider 必须声明来源，平台自动核验并**公开**，掺水立刻可见 |

完整规格见 [`docs/spec.md`](docs/spec.md)，接口见 [`docs/api.md`](docs/api.md)，
密码学契约见 [`docs/crypto.md`](docs/crypto.md)，路线图见 [`docs/roadmap.md`](docs/roadmap.md)。

## 用起来

打开 <https://norm.ntnl.io>，浏览器会为你生成一把 Ed25519 密钥——**地址就是你的账号**，第一次签名即开户，
自动获得一笔演示授信。然后到「 provider」页加一把 provider 密钥（服务端用 Worker secret 封装），
回到 Playground 发一次请求，底部会显示这次调用的扣费、余额、延迟与来源核验结论。

### 两种身份，各管一段

| | 用来 | 凭据 |
|---|---|---|
| **身份** | 管理自己的资源：账户、Provider、下游 Token | Ed25519 逐请求签名（私钥在浏览器里） |
| **Token** | 真正消费：调用模型 | `sk-norm-…`，只记一个名字 |

所以程序侧不需要懂签名、也不需要懂 Norm 的任何专有头：账户里只有一条 provider 时，
**一个 api key 就是一次完整调用**。

```bash
# 在「下游消费者」页起个名字建一条 Token，之后当普通 OpenAI key 用
curl https://norm.ntnl.io/v1/chat/completions \
  -H "Authorization: Bearer sk-norm-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

`x-api-key`（Anthropic SDK / Claude Code）与 `x-goog-api-key`（Google SDK）同样认——各家 SDK 发什么就用什么。
换 provider 不用改程序、也不用换 Token：账户里只有一条 provider 时它自动就是那一条，有多条时在请求里加
`X-Norm-Provider: <Provider id>` 指名即可。

## 自己部署一份

```bash
pnpm install
pnpm exec wrangler d1 create norm           # 把 database_id 填进 wrangler.jsonc
pnpm exec wrangler d1 migrations apply norm --remote
pnpm deploy                                 # 构建 + 上传 Worker
```

Norm 的价值来自「大家都用同一份部署、都能核对字节」。所以自己部署也是**有意支持**的用法：
两套部署互相之间没有信任依赖，任何一方都可以把另一方视为不可信的中转站。

## 开发

```bash
pnpm dev            # wrangler dev，本地 Worker + 本地 D1
pnpm preview        # 只跑前端，/api 与 /v1 代理到 127.0.0.1:8787
pnpm check          # typecheck + vitest + build
node scripts/e2e.mjs  # 起假 provider，用真身份打真 Worker，40 项断言
pnpm attest         # 算出 source_sha256 / assets_sha256，与 /api/v1/attestation 对照
```

## 设计上的取舍

- **不做协议转换。** 一家 provider 一个代理（`-LB` 一族），Norm 只做 OpenAI 兼容转发。
- **不留内容。** 记账只需要模型名、token 数、状态、延迟、费用——这已经足够解释一笔账，
  再多记一个字都是对 ZDR 的破坏。
- **按 Token 记账，外加服务费。** 输入 / 缓存命中 / 输出三种 token 分开计价（价目表在
  `src/pricing.ts`，公开在 `GET /api/v1/pricing`），再加一笔摊 Cloudflare 固定成本的服务费。
  每条记录都满足 `fee = service_fee + token − unbilled`，谁都能自己重算一遍。
- **失败不扣费。** 隔离执行的成本由站点承担；用户只看到一条诚实的失败记录与 `fee_micros: 0`。
- **诚实标注边界。** 来源核验是信号不是证明，官方订阅额度无法在协议层证明——所以在
  `/api/v1/provenance` 里公开 `base_url` 原文与核验时间，让任何人都能自己重跑一次。
