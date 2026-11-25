# Norm — 无站的中转站

> Serverless, 无站胜有站。BYOK + Ed25519 身份 + 逐请求隔离计费 + 按 base_url 聚合的上游提供商 + 可信发布。

## 1. 灵魂

Norm 不是「一台你租给我的机器」，而是**一份公开可复现的转发规则**。
任何人都可以部署它，任何人都可以核对它的字节，因此「中转站可信」不再是一份承诺，而是一个可以自己跑一遍的构建。

## 2. 五条硬承诺

| # | 承诺 | Param Norm 的落地方式 |
|---|---|---|
| 1 | Serverless，单一部署 | 一个 Cloudflare Worker（Hono）+ 一个 D1 + 静态资源同源。没有运维机器、没有后台进程 |
| 2 | 用户 BYOK | 上游提供商密钥只经手一次（创建时），服务端用 Worker secret 封装入 D1，调用时现解现用。仓库里没有任何上游提供商密钥 |
| 3 | Ed25519（base58）身份 | 公钥即地址，私钥永不离开浏览器。每个请求都要签名，服务端不签发会话、不存密码 |
| 4 | ZDR，可信发布 | 不留请求体、不留响应体、不留上游提供商密钥；构建产物哈希公开，任何人可 `pnpm build` 复算 |
| 5 | 上游提供商可核验 | 后端不对上游提供商做价值判断，只存事实：base_url（创建时钉死、转发时不可改写）、协议、是否公开可用。信任是一份 base_url 清单，命中与否由 `/api/v1/base-urls` 公开 |

## 3. 身份

- 用户身份 = Ed25519 密钥对。地址 = `base58(publicKey)`（32 字节公钥 → 44 字符左右）。
- 私钥以**拓展形式**存在：64 字节的 `seed || publicKey`，与 Solana 的密钥种子一致。
  只存在于用户浏览器（localStorage），可导出为 base58 或 Solana `id.json` 的 JSON 数组以便换设备。
  旧版 32 字节种子在首次读取时原地升级，地址不变。
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

## 4. BYOK 与两侧身份

### 4.1 上游提供商密钥的存放

- 添加一个上游提供商时明文只经过一次请求体。服务端立刻用 `NORM_MASTER_KEY`（Worker secret，32 字节）
  做 AES-256-GCM 封装，AAD 绑 `address|providerId`。库里存：label、base_url、
  `sealed_key`、`kdf`、`key_hint`（前 4 后 4），以及两个用户配置项（上游提供商协议、上游提供商是否公开可用）。
  没有上游提供商一列：谁家的上游提供商由 base_url 说话，品牌名只是 label 里的一段字。
- 调用模型时 Worker 现解现用，明文只在本次请求的作用域里存在——不写日志、不进 D1、不回响应。
- 结论：单拿数据库拿不到任何上游提供商密钥；拿到 `NORM_MASTER_KEY` 又拿到库才能解开，所以它是 secret 而不是配置项。

为什么不是「用户口令」：口令只保护存储中的副本，而中转站每次调用都必然看见明文，它防不住运行期、
只能防拖库。既然如此就用一把系统配置的高熵密钥，既不引入弱口令风险，也不用每次调用重输。

### 4.2 身份管资源，Token 管消费

两侧不是「同一种凭据的两个版本」，而是两件不同的事：

| | 凭据 | 谁在说 | 管什么 | 生命周期 |
|---|---|---|---|---|
| **身份** | Ed25519 逐请求签名（公钥即地址） | 人 | 自己的资源：账户、上游提供商、下游 Token | 种子在浏览器里，可导出换设备 |
| **消费** | `Authorization: Bearer sk-norm-…` | 代码 | 一次模型调用 | 库里只存 sha256；明文只在创建/轮换时出现一次 |

**Token 只回答「谁的代码在调用」，不绑定上游提供商。** 因此程序侧一次调用只要一个 api key
（Bearer、`x-api-key`、`x-goog-api-key` 三选一，取决于用哪家 SDK），
不需要签名、也不需要任何 Norm 专有的头。

走哪条上游提供商是**每次转发自己的决定**，规则只有一条：请求带了 `X-Norm-Provider` 就用它，
没带就用账户里唯一的那条上游提供商；账户里有多条又没有指名，是 `409 provider_ambiguous`——
猜一条会把钱打到别的上游提供商去，所以不猜。这样「添一条上游提供商、建一条 Token、当普通 api key 用」
就是全部；换上游提供商也不必重新发钥匙，因为绑定从来不是身份的一部分。

这条边界同时是权限边界：前缀把两者划开，`/api/v1/*` 只认签名（管理面），`/v1/*` 两者都认（转发面）。
一把 Token 因此不能凭空再铸一把 Token，也撤销不了上游提供商。

## 5. 计费：按 Token 记，外加一笔 Gas 费

一次调用的钱由两项相加：

| 项 | 怎么算 | 为什么 |
|---|---|---|
| `token_nanos` | 三项 token 各自乘单价，见 `src/pricing.ts` 与 `GET /api/v1/pricing` | 一次调用真正花掉的资源就是 token，而缓存命中与输出的价差是数量级的 |
| `gas_fee_nanos` | 每一次真的打出去的调用固定一笔（300 纳美元 = $0.0000003） | 摊 Cloudflare Serverless 侧的固定成本：Worker 调用、D1 读写、日志与观测——与 token 无关，也与成败无关 |

三种 token 分开记，因为它们的价不同、含义也不同：

- `input_tokens`：输入总量，**含**缓存命中
- `cached_tokens`：其中命中上游提供商缓存的（便宜一个量级）
- `output_tokens`：输出（最贵）

四家上游提供商的用量口径不一致（Anthropic 的 `input_tokens` 不含缓存读，OpenAI 的 `prompt_tokens` 含），
归一化只发生在 `src/dialects.ts` 的四个 extract 与流式嗅探器里，账本只认上面这三种数字。

其他约定：

- 价目表写在代码里而不是部署变量里：价格是「公开可复现的转发规则」的一部分，
  改价 = 改代码 = 一次可被审查的合并；没定价的模型走兜底价，不会变成免费。
- 账本是纯追加的 `ledger` 表：每一条 charge 都带 `request_id`（UUID v7），可以逐条回溯。
- 余额单位是**纳美元**（integer，1e9 = $1），不用浮点：一次便宜的调用可能只值几十纳美元，
  微美元会把它们四舍五入成 0，而浮点存钱迟早在某一次求和里差一分钱。
  新地址自动获得 $1.00 演示授信（`GRANT_NANOS = 1000000000`）。
- 失败收 Gas、不收 token：上游提供商报错或不可达时 `token_nanos = 0`，
  `fee_nanos = gas_fee_nanos`。Gas 买的是「这次被执行」本身——上游回 500 不代表 Worker 没被调用过。
  没打到上游的请求（体不是 JSON、余额不足）不记账也不扣，因为那没有「执行」可言。
- 余额付不起时扣到 0，差额记在 `unbilled_nanos`（站点承担），余额永不变成负数。
- 演示版不接入真实支付网络；链上 USDC 结算由 Midas 线路承担，见 `docs/roadmap.md`。

## 6. Provider

### 6.1 后端只存事实，判断留给清单

一个中转站可以自称「官方 Key」，没有人能证伪。Norm 的做法不是让中转站自证，而是**把可证伪的部分剥离出去**：

- 上游提供商创建时填写 `base_url`，之后钉死。转发只用上游提供商里的地址，**不读任何请求头**
  （早期版本的 `X-Norm-Base-Url` 已删除；它一存在，「钉死」就只是句口号）。e2e 有专门一条断言盯着。
- 后端**不做**「官方 / 第三方」这类判断。它只回三项事实：`base_url`、`protocol`、
  `visibility`。
- 「可信」是一份**主机名清单**（`wrangler.jsonc` 的 `TRUSTED_BASE_URLS`），精确匹配而非后缀匹配：
  `api.openai.com.evil.tld` 与 `api.openai.com` 是两台机器。命中与否作为 `trusted` 布尔返回。
- 因此「官方 key」退化成**前端的渲染概念**：换一份清单，同一个上游提供商就换个说法，数据层不动。

### 6.2 四种协议，两侧同名：4×4

四种协议既是**入口**（客户端怎么说），也是**上游提供商**（上游提供商怎么存）。因为两侧同名，
「入口方言 === 上游提供商协议」就是一句字符串相等，而那 4 格**不转换**——请求体按原始字节
发出去，响应体原样回来。一个字段都不碰，包括我们不打算理解的 `tools`、`response_format`。

例外只有一个：流式请求打向 `openai-chat` 上游时补 `stream_options.include_usage`，
因为那种上游默认不回用量，而账本必须知道这次花了多少 token。多出来的那条用量帧
客户端没要就不转发。

其余 12 格才经过 OpenAI Chat 这座桥。桥只在一侧出现，所以矩阵是 4 段入口翻译
加 4 段上游提供商适配（`src/providers.ts` 只管 ChatBody → 四种上游提供商），不是 16 条路径。

**不做跨方言的工具调用**：三家的 tools 形状不同，硬拼一个「尽力而为」的映射，
只会在客户端以为有 function calling 时收到一段散文。所以跨方言带 tools 直接 400。
同格式直通不受影响，因为那一路我们根本不看请求体。

这条边界是为了让「直通」有意义：如果一切都先归一化再重建，`responses → responses`
这种本来一致的调用也会丢字段、白费 CPU，那 4 格就成了借口而不是承诺。

| `protocol` | 协议路径 | 关键差异 |
|---|---|---|
| `openai-chat` | `{base}/chat/completions` | 原样透传 |
| `openai-responses` | `{base}/responses` | 请求用 `input`；响应用 `output[].content[].text`；usage 是 `input/output_tokens` |
| `anthropic-messages` | `{base}/v1/messages` | `x-api-key` + `anthropic-version` 头；`system` 独立字段；content blocks |
| `google-gemini` | `{base}/v1beta/models/{model}:generateContent` | `x-goog-api-key`；`contents/parts`；流式走 `:streamGenerateContent?alt=sse` |

四种都支持流式，全部被翻译成 OpenAI chat chunk，结尾统一补一条 `norm` 事件与 `data: [DONE]`。

### 6.3 三件该由用户配置的事

| 字段 | 取值 | 含义 |
|---|---|---|
| `protocol` | 上表四种 | 上游提供商说哪种协议 |
| `visibility` | `public` / `private` | 这个上游提供商本身是否对公众可用。自部署是 `private`——那不是掺水，只是不对外 |
| `enabled` | `true` / `false` | 这条上游提供商现在用不用。禁用后不参与选址，也不能被 `X-Norm-Provider` 指名 |

三者都与信任无关。注意 `visibility`（上游提供商别人能不能用）与 `public_listed`
（我愿不愿意把这条上游提供商挂上看板）是**两个不同的开关**，不要混。

`enabled` 与撤销（`revoked_at`）也不是一回事：禁用是**可逆**的减法——密钥、历史记账、
看板计数都留着，拨回来立刻恢复；撤销是永久退场，那条 id 再也不会被用到。所以「这个月
先不用它」应该禁用，「这个 key 泄露了」才撤销。

### 6.4 公开视图

`GET /api/v1/base-urls` 按 `base_url` 聚合，返回每个上游提供商的 `host`、`trusted`、上游提供商数、
公开条数、协议集合、最近添加时间。只统计**启用**的上游提供商：禁用的那条不在服务，
把它算进「这个上游有几条」会让看板替用户声称一件不成立的事。
这是后端关于上游提供商的唯一视图——没有官方/第三方，只有地址与计数。

### 6.5 模型清单：一句问话，四条方言各自回答

`GET /v1/models`（以及 `GET /v1/models/{model}`）走转发面，所以签名身份与消费者 Token 都能用：
「这个上游有哪些模型」只有拿着那把上游密钥的人才知道，而密钥在服务端——客户端不该为了
问一句话就去碰明文密钥。

出口只有一种方言：OpenAI 的 `/models`（`{object:"list", data:[{id, object:"model"}]}`）。
四种上游的清单形状互不相干（`data[].id` / `models[].name` / `id` + `created_at` 的 ISO 字符串），
在 `upstreams.ts` 里被归一成同一个 `ModelInfo`，与请求那条路一样：**规范形式居中，方言只在两侧**。
选 OpenAI 形状做出口不是偏袒，是因为 `/v1/messages` 与 `:generateContent` 天生没有「列模型」
这个方法，四家 SDK 里只有这一种形状是公共语言。

它是**唯一**一条打了上游却不扣 Gas 的路径：列清单不是一次生成，没有 token；它确实消耗了一次
Worker 调用，那一笔由站点自己吃掉（SDK 常在启动时先问一次模型清单，把「能不能用」也计费不划算）。
所以它不写 `requests`、不动账本，只在响应里挂一个 `fee_nanos: 0` 与 `gas_fee_nanos: 0` 的 `norm`——
「这次没花钱」也是需要被如实说明的事实。

## 7. ZDR 与可信发布

- 不留请求体、不留响应体、不留上游提供商密钥。唯一的持久化是记账所需的最小字段（模型名、token 数、状态、延迟、费用）。
- `GET /api/v1/attestation` 返回：git commit、构建时间、Worker 产物 sha256、前端产物 sha256、GitHub Actions Run 链接。
- 任何人 `git clone && pnpm i && pnpm build` 后算一次 sha256，与本页数字对比即可确认线上跑的代码就是这个仓库。
- 发布走 GitHub Actions + Cloudflare API Token，`main` 合并即上线，没有手工 `wrangler deploy`。

## 8. 这一版不做什么

- 不做多租户运营后台、不做限速策略、不做模型路由。
- 不做下游的额度与限速：消费者密钥只标识账户，花的仍是同一个余额。按钥匙分账留给下一版。
- 不做真实支付。
