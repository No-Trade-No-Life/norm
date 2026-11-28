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
| 5 | 上游提供商可核验 | 后端不对上游提供商做价值判断，只存事实：base_url（只有本人能改、转发时不可改写）、协议、是否进公共池。信任是一份 base_url 清单，命中与否由 `/api/v1/base-urls` 公开 |

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
X-Norm-Signature: <base58 的 ed25519 签名>

message = "norm-v1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + sha256hex(body)
```

服务端校验：时间窗 ±60 秒、签名通过公钥验证。鉴权本身不写任何行；传输层全程走 TLS，不维护 nonce 或重放状态。地址首次出现时自动开户。

细节见 `docs/crypto.md` 第 2 节。

## 4. BYOK 与两侧身份

### 4.1 上游提供商密钥的存放

- `label` 只是人看的名字，**可选、可空**（库里 `NULL` = 没有标签）：它不是选址依据，也不是信任依据，缺了它一条上游照样完整。
- 添加一个上游提供商时明文只经过一次请求体。服务端立刻用 `NORM_MASTER_KEY`（Worker secret，32 字节）
  做 AES-256-GCM 封装，AAD 绑 `address|providerId`。库里存：label、base_url、
  `sealed_key`、`kdf`、`key_hint`（前 4 后 4），以及三个用户配置项（上游提供商协议、是否进公共池、启停）。
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

走哪条上游是**每次转发自己的决定**，而调用方不参与：**自己的上游优先，公共池兜底**，
同一个 `thread-id` / `session-id` 粘在同一条上（判定全在 `src/routing.ts` 与
`store.resolveProvider`）。在此之前这里要求请求头 `X-Norm-Provider` 指名、多条又没指名就
`409 provider_ambiguous`；那个头删掉了——它要求每个客户端多填一个参数，而下游不肯采纳的
正是这一部分。规则挪到服务端之后，「添一条上游、建一条 Token、当普通 api key 用」才是真的全部；
换上游也不必重新发钥匙，因为绑定从来不是身份的一部分。

粘性为什么是一张会过期的表、而不是一个纯哈希：候选集是会变的（上游被禁用、被撤销、自己的
上游恢复后把池子挤掉），纯哈希会随着候选集变化把会话整批搬到另一台上去；有表就能钉住一条，
直到它真的不可用。没有亲和键的请求按 rendezvous 摊开——候选增减时只有该搬的那部分会话搬家。

这条边界同时是权限边界，而且**两侧互不越界**：`/api/v1/*` 只认签名（管理面），`/v1/*` 只认 Token（转发面）。
一把 Token 因此不能凭空再铸一把 Token，也撤销不了上游提供商；反过来，签名也换不来一次推理——
签名能管资源，不能花钱，所以每一笔消费都必然落在一条具体的钥匙上，账本永远答得出「这段代码是谁」。
推理接口上带着签名头来，得到的是 `401 consumer_key_required`，而不是一次免费或匿名直连。

## 5. 计费：Gas 费与 Token 费分开处理

一次调用涉及两笔性质完全不同的钱，必须分开结算、分开统计：

| 项 | 归属 | 怎么算 | 为什么 |
|---|---|---|---|
| `gas_fee_nanos` / `gas_billed_nanos` | **付给 Norm**（基础设施费） | 动态 Gas：从 300 纳美元（Worker 调用）起步，按实际经过的付费点逐项累加，结算前冻结，见 `src/gas.ts` 与 `GET /api/v1/pricing` | 如实覆盖 Cloudflare Serverless 侧的边际资源成本（Worker 调用、D1 行写、日志、CPU）——当前 1.0× 纯成本价，与 token 无关、与成败无关 |
| `token_nanos` / `token_billed_nanos` | **上游那边的 Token 价值**（自有上游 = 自转自；他人/公共池 = 价值转移） | 三项 token 各自乘单价，见 `src/pricing.ts` 与 `GET /api/v1/pricing` | **调用自有上游（`provider_user === address`）也按真价记**：`token_spend_nanos` 与 `earn_nanos` 同增（自己转给了自己），余额只减 Gas，`token_self_nanos` 标出这部分，记账结果绝不写成 0；**调用他人/公共池上游（`provider_user !== address`）时，实扣的 `token_billed_nanos` 直接转入上游提供方的 `earn_nanos`**，Norm 不截留任何 Token 费用 |

三种 token 分开记，因为它们的价不同、含义也不同：

- `input_tokens`：输入总量，**含**缓存命中
- `cached_tokens`：其中命中上游提供商缓存的（便宜一个量级）
- `output_tokens`：输出（最贵）

四家上游提供商的用量口径不一致（Anthropic 的 `input_tokens` 不含缓存读，OpenAI 的 `prompt_tokens` 含），
归一化只发生在 `src/dialects.ts` 的四个 extract 与流式嗅探器里，账本只认上面这三种数字。

其他约定：

- 价目表写在代码里而不是部署变量里：价格是「公开可复现的转发规则」的一部分，
  改价 = 改代码 = 一次可被审查的合并；没定价的模型走兜底价，不会变成免费。
- 账户维护六块只增累计数：`recharge_nanos`（充值）、`voucher_nanos`（抵扣券，不可提现）、`earn_nanos`（作为上游提供方收到的 Token 收入）、`gas_spend_nanos`（付给 Norm 的 Gas 支出）、`token_spend_nanos`（转给他人上游的 Token 支出）、`withdraw_nanos`（提现）。
  可用余额永远由算式得出：`recharge + voucher + earn − gas_spend − token_spend − withdraw`。
- 消费与收入的账都在请求表里：每条请求带 `gas_billed_nanos` / `token_billed_nanos`、`spend_before_nanos` / `spend_after_nanos` 与（跨用户时的）`earn_before_nanos` / `earn_after_nanos`。
- `ledger` 只记账户级的钱，纯追加：`voucher`（券）/ `recharge`（充值）/ `withdraw`（提现）。
- 余额单位是**纳美元**（integer，1e9 = $1），不用浮点：一次便宜的调用可能只值几十纳美元，
  微美元会把它们四舍五入成 0，而浮点存钱迟早在某一次求和里差一分钱。
  新地址开户**不再赠金**：测试期的余额由管理员的欠费开关（`principals.overdraft`）兜住，不给每个新地址发券。
- 失败收 Gas、不收 token：上游提供商报错或不可达时 `token_nanos = 0`，
  `fee_nanos = gas_billed_nanos`。Gas 买的是「这次被执行」本身——上游回 500 不代表 Worker 没被调用过。
  没打到上游的请求（体不是 JSON、余额不足）不记账也不扣，因为那没有「执行」可言。
- 余额不足时**先扣 Gas、余下扣 Token**，余额扣到 0 永不为负，差额记在 `unbilled_nanos`；上游提供方只收到实际扣到的 `token_billed_nanos`，保证全站价值严格守恒（绝不凭空增发）。
- 演示版不接入真实支付网络；链上 USDC 结算由 Midas 线路承担，见 `docs/roadmap.md`。

## 6. Provider

### 6.1 后端只存事实，判断留给清单

一个中转站可以自称「官方 Key」，没有人能证伪。Norm 的做法不是让中转站自证，而是**把可证伪的部分剥离出去**：

- 上游提供商创建时填写 `base_url`（`deepseek` 这类厂商协议的基址由协议给定，不填），之后只有主人能改。
  转发只用库里那条上游提供商的地址，**不读任何请求头**
  （早期版本的 `X-Norm-Base-Url` 已删除；它一存在，「钉死」就只是句口号）。e2e 有专门一条断言盯着。
  可编辑的字段是 `label` / `protocol` / `enabled` / `base_url` / `provider_key`；
  密钥**可换不可看**：替换时重新封装并更新 `key_hint`，明文任何路径都不回。
- 后端**不做**「官方 / 第三方」这类判断。它只回事实：`base_url`、`protocol`，以及两项
  配置（`scope`：进不进公共池；`enabled`：现在用不用）。
- 「可信」是一份**主机名清单**（`wrangler.jsonc` 的 `TRUSTED_BASE_URLS`），精确匹配而非后缀匹配：
  `api.openai.com.evil.tld` 与 `api.openai.com` 是两台机器。命中与否作为 `trusted` 布尔返回。
- 因此「官方 key」退化成**前端的渲染概念**：换一份清单，同一个上游提供商就换个说法，数据层不动。

### 6.2 两层分离：四种线缆方言 + 可复用的上游协议

Norm 把**线缆方言（`Dialect`）**和**上游协议契约（`Protocol`）**拆成两层：

- **线缆方言只有四种**（`openai-chat` / `openai-responses` / `anthropic-messages` / `google-gemini`），入站与出站共用同一套方言名。
- **上游协议是「方言 + 厂商契约」**：四条通用方言协议由用户填写 `base_url`；厂商协议（如 `deepseek`、`opencode-go`）在 `src/protocols.ts` 里声明复用哪一种 `dialect` 并叠加固定基址、路径前缀、会话头或分时计价，**不包含任何翻译代码**。

直通判定只比较线缆方言（`entry.dialect === profile.dialect`）：同方言时**不转换**——请求体按原始字节发出去，响应体原样回来，一个字段都不碰（包括我们不打算理解的 `tools`、`response_format`）。

例外只有一个：流式请求打向 `openai-chat` 方言的上游（含 `opencode-go`）时补 `stream_options.include_usage`，
因为那种上游默认不回用量，而账本必须知道这次花了多少 token。多出来的那条用量帧
客户端没要就不转发。

跨方言请求才经过规范中间态（Hub）桥接：入口方言 → `ChatBody`（`src/dialects.ts`）→ 上游方言编解码（`src/codecs.ts`）→ 回来时经 `AnswerCore` / `StreamEvent` 渲染成入口方言。
桥只在规范中间态居中出现，因此翻译是 **4 段入站 + 4 段出站（复杂度 $M + N$）**，不是 $M \times N$ 矩阵：每新增一个上游厂商协议，新增翻译量为 **0**；即使未来引入第 5 种线缆方言，也只需补 1 份「方言 ↔ 规范中间态」编解码。

**工具调用同样过桥**：四家的 `tools` / `tool_choice` / `tool_calls` / 工具结果的形状各不相同，
所以规范形式只留扁平的「工具声明」「一次调用」「一条结果」三样（见 `src/codecs.ts` 的
`ChatTool` / `ChatToolCall`）。入口读进来、出口说回去，`finish_reason` / `stop_reason` 也跟着
改成「在等工具」。同方言直通不受影响，因为那一路我们根本不看请求体。

这条边界是为了让「直通」有意义：如果一切都先归一化再重建，`responses → responses`
这种本来一致的调用也会丢字段、白费 CPU，直通就成了借口而不是承诺。

| `protocol` | 复用方言（`dialect`） | 协议路径 | 关键差异 |
|---|---|---|---|
| `openai-chat` | `openai-chat` | `{base}/chat/completions` | 通用方言，基址由用户填 |
| `openai-responses` | `openai-responses` | `{base}/responses` | 请求用 `input`；响应用 `output[].content[].text`；usage 是 `input/output_tokens` |
| `anthropic-messages` | `anthropic-messages` | `{base}/v1/messages` | `x-api-key` + `anthropic-version` 头；`system` 独立字段；content blocks |
| `google-gemini` | `google-gemini` | `{base}/v1beta/models/{model}:generateContent` | `x-goog-api-key`；`contents/parts`；流式走 `:streamGenerateContent?alt=sse` |
| `deepseek` | `openai-responses` | `{base}/responses` | 零翻译复用 `openai-responses`；叠加官方固定基址与高峰 / 低谷两档分时计价（见 `src/deepseek.ts`） |
| `opencode-go` | `openai-chat` | `{base}/openai/v1/chat/completions` | 零翻译复用 `openai-chat`；叠加官方推理面基址（`https://opencode.ai/inference/go`）、版本段路径与必带会话头（`x-opencode-session: ses_<sha256>`，由 `src/sessions.ts` 派生） |
| `openai-oauth` | `openai-responses` | `{base}/responses` | 零翻译复用 `openai-responses`；叠加**凭据契约**（一对 OAuth 令牌而不是 API key：用之前拿 `refresh_token` 换新的，换完写回库——上游会轮换 `refresh_token`，不写回这条上游就只剩重连，见 `src/oauth.ts` / `src/credentials.ts`）、两个头（`chatgpt-account-id` + `originator: codex_cli_rs`）、**基址由用户填**（必须是一跳自己的转发：Worker 出站被盖 `cf-worker`，chatgpt.com 回 403；一跳同时决定出口 IP，等同 LB 的 `http_proxy_url`）与**只认流式**（缺 `stream: true` 上游直接 400，转发层提前挡住） |

| `openai-audio` | `openai-chat` | `{base}/chat/completions`（同一个基址上还有音频） | 把一条**已经说 OpenAI 音频**的上游接进来（Qwen LB / OpenAI / 任何兼容实现）：`{base}/audio/transcriptions` 与 `{base}/audio/speech` 零翻译直通，基址由用户填——这正是 Qwen LB 接进 NormAI 的那种接法，只是换了个入口 |
| `qwen` | `openai-chat` | `{base}/compatible-mode/v1/chat/completions` | 百炼：文本与视觉零翻译复用 `openai-chat`（`image_url` 内容块原样透传）；音频走 `qwen-native` 方言（原生多模态生成 / 语音合成器），因为兼容层没有转写端点 |
| `naive` | `openai-chat` | `{base}/chat/completions` | NaiveAI（`api.naive.ai/v1`，官方只有 Chat Completions 与 Anthropic Messages，没有 Responses）：零翻译复用 `openai-chat`；钉死官方基址，并叠加一条请求契约 `drop_service_tier`——`ultrafast` 贵 10 倍且上游不回显档位，接住了就无法核对，转发层在发出去之前把它删掉 |

四种方言都支持流式：同方言直通时上游 SSE 原样透传（仅 `openai-chat` 入口在流末补一条 `norm` 事件与 `data: [DONE]`）；跨方言时由 `src/codecs.ts` 拆成规范事件，再由 `src/dialects.ts` 渲染成入口方言自己的 SSE 帧。

### 6.3 三件该由用户配置的事

| 字段 | 取值 | 含义 |
|---|---|---|
| `protocol` | 上表那些（四种通用方言 + 厂商契约协议） | 上游提供商说哪种协议 |
| `enabled` | `true` / `false` | 这条上游提供商现在用不用。禁用后不参与选址 |
| `scope` | `private` / `pool` | `private` 只给主人用；`pool` 进公共池，全站在自己的上游不可用时兜底用它。只有站点地址（`POOL_ADMIN_ADDRESSES`）能写 `pool` |

「公开」只有一个语义，就是 `scope = 'pool'`。曾经另有两列在说同一件事：
`visibility`（公开可用）从不参与选址，只是一列文案；`public_listed`（挂上看板）
只影响看板上的一个计数。两者叠在一起，同一条上游可以同时显示「公开可用」和
「未公开」。两列已删（`0019`），公开 = 进公共池，其余一律私有——别人用不到它，
就该说私有，而不该在「公开可用」和「未公开」之间二选一地自相矛盾。

三者都与信任无关。

`enabled` 与撤销（`revoked_at`）也不是一回事：禁用是**可逆**的减法——密钥、历史记账、
看板计数都留着，拨回来立刻恢复；撤销是永久退场，那条 id 再也不会被用到。所以「这个月
先不用它」应该禁用，「这个 key 泄露了」才撤销。

### 6.4 公开视图

`GET /api/v1/base-urls` 按 `base_url` 聚合，返回每个上游提供商的 `host`、`trusted`、上游提供商数、
公共池条数（`pool`）、协议集合、最近添加时间。只统计**启用**的上游提供商：禁用的那条不在服务，
把它算进「这个上游有几条」会让看板替用户声称一件不成立的事。
这是后端关于上游提供商的唯一视图——没有官方/第三方，只有地址与计数。

### 6.5 模型清单：一句问话，四条方言各自回答

`GET /v1/models`（以及 `GET /v1/models/{model}`）走转发面，所以同样只认消费者 Token：
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

### 6.6 转发按模型筛上游：`provider_models`

选址不是只有「账户 + 会话」两件事。这张表补上第三件：**这次要跑的型号，上游到底有没有**。

数据只有两个来源，都是上游自己的清单端点（`GET /models`）：读模型总表时
（`GET /api/v1/models`），以及新增 / 编辑一条上游时（响应之后的 `waitUntil`）。转发路径上
**不**联网探测——那会把一次调用变成两次，而选址得是毫秒级的。

于是每个候选有三种处境，必须分得开：

| 处境 | 判定 | 选址怎么用 |
|---|---|---|
| 抓过清单、有它 | `models_fetched_at > 0` 且 `provider_models` 里有这一行 | 参与 |
| 抓过清单、没有它 | `models_fetched_at > 0` 且表里没有这一行 | 这次不参与——不是优先级低，是跑不了 |
| 从没抓过清单 | `models_fetched_at = 0` | 保留：没有证据不等于有证据说没有 |

筛选在「自有优先」**之前**：模型跑得了是硬约束，自有优先是偏好。反过来的顺序会让「自己那条
不支持这个型号的上游」把请求卡死在它身上，而池子里那条能跑的反而用不上。

筛完一条不剩时回 `404 model_not_served`，明确说出「没有上游提供这个模型」，而不是把请求丢给
一条明知道没有它的上游、让下游去读上游的 400 原话。

还有一条兜底：上游用 400 / 404 并且在原话里点了这次的模型（`isModelNotServed`），说明清单里
那一行是错的——删掉它、忘掉这条会话的亲和，换一条候选重试一次。没有这一步，一次按错清单的
选择会让同一条会话错满亲和表的整个 TTL（7 天）。

### 6.7 音频：一种入口线缆，两种上游方言

文本那层的「四方言」在音频这边只剩一种：下游只有 OpenAI 的 `/v1/audio/transcriptions` 与
`/v1/audio/speech`。四家 SDK 里只有它把这件事件说成公共语言，Qwen LB 与 NormAI 也都对齐在
它这一侧，所以音频入口不带方言参数——方言只在上游：

| 上游音频方言 | 谁在用 | 怎么转发 |
|---|---|---|
| `openai-audio` | Qwen LB、OpenAI、任何兼容实现（`openai-audio` 协议） | 请求体按原始字节转发，应答原样读：转写读 `text` 与用量，合成直接把字节交回 |
| `qwen-native` | 百炼（`qwen` 协议） | 构造原生请求、归一化应答：转写折成 `input_audio` data URI，合成按型号的调用方式走两条原生接口，音频再从上游给的地址下载一次 |
| `chatgpt-desktop` | 一份 ChatGPT 订阅（`openai-oauth` 协议） | 请求体按原始字节转发到桌面专属的 `/backend-api/transcribe`（地址在 Codex 根旁边），身份换成桌面客户端；应答读 `text` 与可选的时长。只接转写——订阅额度里没有合成的路 |

音频的型号表与价目都在代码里：`qwen.ts` 说「哪个型号是转写还是合成、走哪条原生接口」，
`pricing.ts` 说「按秒、按字符还是按 token」。音频**没有兜底价**——认不出的型号在转发之前就
回 `400 audio_model_unpriced`，0 次上游请求、0 笔记账：按秒与按字符不是同一个单位，猜错方向
会差几个数量级。型号表还替上游补进清单（`provider_models`），所以 `/v1/models` 与模型总表上
看得见 `qwen3-tts-flash` 这类型号，音频调用才选得中那条上游。

同一条道理对图像也成立：ChatGPT 订阅没有 `/images/generations` 可列，图片型号表在
`OPENAI_IMAGE_MODELS` 里。数据面清单因此不只看「这一次被选中的那条上游答了什么」——
问不出来的型号按账户里启用的协议一并报出（`mergeDeclaredModels`）。漏掉这一步的代价是
可观测的：下游网关同步模型时只看得见文本型号，图片调用在它自己那一侧就被判成
「没有上游提供这个型号」，永远走不到 Norm 的图像入口。

记账沿用同一本账：`gas_fee_nanos` 照收（这次执行真的发生过），`token_nanos` 仍是「转给上游
提供方的价值」（调用自有上游时为 0），只是用量多了两列——`audio_ms` 与 `audio_characters`。
音频的账单也随响应回去：转写把 `cost_usd_nanos` 写进响应体，合成挂在 `X-Norm-Fee-Nanos`
头上。**没有事后回捞的接口**——上层网关拿到的就是实扣金额，一次往返结清；异步对账那套在
Worker 上要多一次调用与一次 D1 读，换的还是同一个数。

音频不走重试：文本那条「换一条候选再试一次」是为了纠正清单里错的一行，而音频的型号表是代码
里钉死的或上游自己列的，没有那种误差可纠。

### 6.8 联网搜索：一条独立端点，下游选协议不选模型

搜索不是一次对话。DeepSeek 的 Search API（`/v1/tools/search`）本身就是搜索引擎：一次 JSON
请求、一页结构化结果、按次计费，中间**没有任何模型**。所以它是一个独立端点：

```
POST /v1/web-search   { source: "deepseek" | "openai", query, ...这条协议自己的参数 }
      │
      ├─ 解析：只有 source 与 query 是公共的；其余参数交给方言逐个认领，不认识和拒
      ├─ 选址：按**搜索方言**筛候选——方言挂在协议上，不挂在模型上
      └─ 转发：`{base_url}` + 方言自己的路径，一页结果回来就结算
```

**两条协议，同一封信封。**

| 方言 | 谁在用 | 怎么把搜索做出来 | 计价 |
|---|---|---|---|
| `deepseek-search` | `deepseek` 协议 | 直连 Search API：没有模型、没有 tool 循环 | 按成功的调用，一次 750,000 纳美元 |
| `openai-search` | `openai-search` 协议（基址由用户填）· `openai-oauth` 订阅 | 上游把**宿主模型 + `web_search` 工具**包成同一条搜索信封（OpenAI LB 的 `/v1/web-search`）；订阅没有这个端点，由 Norm 自己包一次只调 `web_search` 的 Responses 请求 | 按上游报的 token，通用价目表折价 |

**同一条方言，不止一条上游。** `openai-search` 有两个来源：一种是把信封已经做好、整件事
卖给我们的服务（`openai-search` 协议，基址由用户填）；另一种是一条 ChatGPT 订阅
（`openai-oauth`）——它只有 `/responses`，`web_search` 在那里是一个**工具**，于是 Norm
自己把「宿主模型 + `web_search`」包成一次搜索（`tool_choice` 钉死、`include` 要
`web_search_call.action.sources`，来源再从文本消息的 `url_citation` 注解里补齐 title）。
所以编解码按**协议**取（`searchCodecForProtocol`），不按方言名取：方言说的是「这是什么
能力」，协议说的是「跟谁说、怎么说」。对下游一个字都没变：`source` 仍是 `openai`。

**为什么下游没有模型选项。** 搜索不挑型号，这不是「省掉了一步」，是这一步本来就不存在：
`deepseek-search` 根本不跑模型；`openai-search` 的宿主模型是那条上游部署时定下的
（`web_search_host_model`），订阅那条则是 `hosts.ts` 里的一张候选表（同一个订阅里可达的
型号不同，按序试，只有上游说「这个型号不认」时才换下一个）——两种都不是调用方的参数。调用
方能选的是**走哪条搜索协议**——这才是两条路的真实区别：一条直连搜索引擎，一条把模型回合封
在上游那一侧。所以 `source` 写 `deepseek` 还是 `openai`，写别的（比如一个模型名）回
`400 source_invalid`。

**为什么对下游不暴露 `tools`。** 那条路要求先有一个能调工具的宿主模型：模型读题、决定搜
什么、再写一段散文把结果复述回来。代价是三重的——多一次推理（贵且慢）、多一份不确定性
（同一句 query 两次可能搜出两页东西）、同一次搜索按 token 再收一遍钱。宿主模型那条路只活
在上游一侧（`openai-search` 协议），或者在订阅上游上由 Norm 替它包成**一次只调工具的**
请求——两次都是「上游的形状」，`/v1/web-search` 的信封不变。

**方言挂在协议上，不挂在模型上。** `ProtocolProfile.search` 存的是**方言名**，与 `audio`
存方言名同一个道理：对外一条线缆，对内可以有多条实现。将来别的搜索引擎——Tavily、Exa、
Bing，或者一家自己的搜索服务——都可以包成同一条方言，各给一条路径、一个请求体、一个读法、
一个报价，`/v1/web-search` 这一层一个字都不用改。选址时「能不能搜」由协议回答，连
`provider_models` 都不查。

**计价按各自的方式。** `deepseek-search` 按**成功的调用**（`deepseek.ts` 的
`DEEPSEEK_SEARCH_CALL_NANOS = 750_000`，每 1,000 次 0.75 美元，美元价、不经汇率折算）；
`openai-search` 按上游回的 **token** 用通用价目表折价——宿主模型不在 `pricing.ts` 的模型表
里（自有上游那条 Norm 看不见它，订阅那条虽然看得见名字，价目表里也没有那一行），猜只会猜
错，改价只改价目表。两条都不进 `pricing.ts` 里那张按 token 记价的通用模型表：搜索既没有
模型也没有型号，硬塞进去只会让「这个模型花了多少钱」多出假答案。失败、超时与「一条
结果都没有」只收 Gas；调用自有上游时按真价记成**自转自**（余额只减 Gas），不记 0。

## 7. ZDR 与可信发布

- 不留请求体、不留响应体、不留上游提供商密钥。唯一的持久化是记账所需的最小字段（模型名、token 数、状态、延迟、费用）。
- `GET /api/v1/attestation` 返回：git commit、构建时间、Worker 产物 sha256、前端产物 sha256、GitHub Actions Run 链接。
- 任何人 `git clone && pnpm i && pnpm build` 后算一次 sha256，与本页数字对比即可确认线上跑的代码就是这个仓库。
- 发布走 GitHub Actions + Cloudflare API Token，`main` 合并即上线，没有手工 `wrangler deploy`。

## 8. 这一版不做什么

- 不做多租户运营后台、不做限速策略。
- 不做下游的额度与限速：消费者密钥只标识账户，花的仍是同一个余额。按钥匙分账留给下一版。
- 不做真实支付。
