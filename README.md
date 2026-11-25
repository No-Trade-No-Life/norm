<div align="center">

# Norm

**无站的中转站。** 一份公开可复现的转发规则，而不是一台你租给我的机器。

`https://norm.ntnl.io`

</div>

## 这是什么

Norm 是一个 **Serverless 的 AI 中转站**：一个 Cloudflare Worker + 一个 D1。它不持有任何上游提供商密钥，
不签发会话，不存请求内容。用户用自己的上游提供商密钥（BYOK）调用，身份是自己持有的 Ed25519 密钥，
每一条被隔离执行的请求都单独计费，每一个上游提供商的来源都公开可核验。

「中转站可信」在 Norm 里不是一个承诺，而是一个**可以自己跑一遍的构建**。

## 五条硬承诺

| 承诺 | 落地方式 |
|---|---|
| **Serverless，单一部署** | 一个 Worker（Hono）+ 一个 D1 + 同源静态资源。没有运维机器、没有后台进程 |
| **BYOK** | 上游提供商密钥只在请求头里经过。库里只有客户端加密后的密文，服务端读不懂 |
| **身份与消费分开** | 身份 = Ed25519 公钥（管资源，私钥永不离开浏览器，无注册无密码无 cookie；密钥是 64 字节拓展形式 `seed‖publicKey`，与 Solana 密钥种子同形）；消费 = `sk-norm-…` Token（只记名字，不绑上游提供商），一条 Bearer 就够 |
| **ZDR + 可信发布** | 不留请求体、响应体、上游提供商密钥；构建哈希公开，任何人可 `pnpm build` 复算 |
| **上游提供商来源可核验** | 每个上游提供商必须声明来源，平台自动核验并**公开**，掺水立刻可见 |

完整规格见 [`docs/spec.md`](docs/spec.md)，接口见 [`docs/api.md`](docs/api.md)，
密码学契约见 [`docs/crypto.md`](docs/crypto.md)，路线图见 [`docs/roadmap.md`](docs/roadmap.md)。

## 用起来

打开 <https://norm.ntnl.io>，浏览器会为你生成一把 Ed25519 密钥——**地址就是你的账号**，第一次签名即开户，
自动获得一笔演示授信。然后到「上游提供商」页加一把上游提供商密钥（服务端用 Worker secret 封装），
回到 Playground 发一次请求，底部会显示这次调用的扣费、余额、延迟与来源核验结论。

### 两种身份，各管一段

| | 用来 | 凭据 |
|---|---|---|
| **身份** | 管理自己的资源：账户、上游提供商、下游 Token | Ed25519 逐请求签名（私钥在浏览器里） |
| **Token** | 真正消费：调用模型 | `sk-norm-…`，只记一个名字 |

所以程序侧不需要懂签名、也不需要懂 Norm 的任何专有头：账户里只有一条上游提供商时，
**一个 api key 就是一次完整调用**。

```bash
# 在「下游消费者」页起个名字建一条 Token，之后当普通 OpenAI key 用
curl https://norm.ntnl.io/v1/chat/completions \
  -H "Authorization: Bearer sk-norm-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

`x-api-key`（Anthropic SDK / Claude Code）与 `x-goog-api-key`（Google SDK）同样认——各家 SDK 发什么就用什么。
换上游提供商不用改程序、也不用换 Token：账户里只有一条上游提供商时它自动就是那一条，有多条时在请求里加
`X-Norm-Provider: <上游提供商 id>` 指名即可。

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
node scripts/e2e.mjs  # 起假上游提供商，用真身份打真 Worker，40 项断言
pnpm attest         # 算出 source_sha256 / assets_sha256，与 /api/v1/attestation 对照
```

## 设计上的取舍

- **全连接，只有对角线不翻译。** 四条入口方言（OpenAI Chat / Responses、Anthropic Messages、
  Google Gemini）× 四种上游提供商协议，16 格全通：4 格同格式直通（请求体按原始字节发出去、
  响应体原样回来），其余 12 格过 OpenAI Chat 这座桥做转换。唯一不做的是**跨方言的工具调用**：
  三家的 `tools` 形状不同，硬拼一个「尽力而为」的映射只会在客户端以为有 function calling 时
  收到一段散文，所以跨方言带 `tools` 直接 400。协议转换是 Norm 自己的事——`-LB` 一族照样能接，
  只是不再是接入的前提。
- **不留内容。** 记账只需要模型名、token 数、状态、延迟、费用——这已经足够解释一笔账，
  再多记一个字都是对 ZDR 的破坏。
- **按 Token 记账，外加 Gas 费。** 输入 / 缓存命中 / 输出三种 token 分开计价（价目表在
  `src/pricing.ts`，公开在 `GET /api/v1/pricing`），再加一笔固定 300 纳美元（$0.0000003）的
  Gas 费——它摊的是 Cloudflare 侧的固定成本（一次 Worker 调用、几次 D1 读写）。
  每条记录都满足 `fee = gas_fee + token − unbilled`，谁都能自己重算一遍。
- **失败收 Gas，不收 Token。** Gas 买的是「这次被执行」，不是答案：上游 500、密钥被吊销、
  地址根本打不通，Worker 与 D1 的成本照样发生过了，所以 Gas 照收（响应头 `X-Norm-Gas-Fee-Nanos`
  写明扣了多少），token 那部分才是 0。没打到上游的请求（体不是 JSON、余额不足、没配上游提供商）
  不记账也不扣——那些没有「执行」可言。
- **诚实标注边界。** 来源核验是信号不是证明，官方订阅额度无法在协议层证明——所以在
  `/api/v1/provenance` 里公开 `base_url` 原文与核验时间，让任何人都能自己重跑一次。
