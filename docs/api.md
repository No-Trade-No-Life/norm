# Norm API

Base: `https://norm.ntnl.io`。

两种身份，职责不同，按前缀划分：

| 前缀 | 接受什么 | 用来干什么 |
|---|---|---|
| `/api/v1/*` | **只**接受 Ed25519 请求签名 | 管理面：账户、上游提供商、下游消费者 Token，都是「浏览器里的人在操作」 |
| `/v1/*` | **只**接受 `Authorization: Bearer sk-norm-…`（`x-api-key` / `x-goog-api-key` 同义） | 转发面：消费。程序拿一条 Token 就能调用，没有任何 Norm 专有的头 |

一句话：**身份只管资源，消费只用一个 api key。** 转发面没有签名入口——签名能管资源，不能花钱，
所以 `POST /v1/chat/completions` 带着 `X-Norm-Address` 那四个头来，只会拿到 `401 consumer_key_required`。
下游 Token 不绑定上游提供商，消费侧也没有任何 Norm 专有的头：走哪条上游由服务端按
「自己的上游优先、公共池兜底、会话粘住」自己挑。

公开接口（`health` / `stats` / `base-urls` / `attestation`）两种都不需要。

## 签名

```
message = "norm-v1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
```

请求头：`X-Norm-Address`、`X-Norm-Timestamp`、`X-Norm-Nonce`、`X-Norm-Signature`（均为 base58）。

签名格式不变，但 `X-Norm-Nonce` 的**语义**是「这次请求的幂等键」：

| 请求 | 重放同一个签名会怎样 |
|---|---|
| 读（`GET` / `HEAD`） | 直接放行，仍然是 200 —— 时间窗只管新鲜度，读没有副作用 |
| 创建（`POST /providers`、`POST /consumers`） | 200 + `replayed: true`；不会产生第二行（`consumers` 的明文密钥只在第一次响应里） |
| 修改 / 删除（scope / enabled / `PATCH` / `DELETE` / 下游改名·吊销） | 200 + `replayed: true`（或 `DELETE` 的 204 → 本仓库一律 200 JSON）；不会产生第二次副作用 |
| `POST /consumers/:id/rotate` | **409 `nonce_replayed`**，且不会再签发第二把密钥 |

所以「客户端超时了再发一次」现在是安全的：同一个 nonce 就是同一个意图。换个意图请换一把 nonce。
超过时间窗（60 秒）的签名一律 `401 timestamp_out_of_window`。

## 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | `{ok, service, version, now}` |
| GET | `/api/v1/stats` | `{principals, providers, requests, gas_spend_nanos, token_spend_nanos, earn_nanos, spend_nanos, window_hours}`（`providers` 只计启用的） |
| GET | `/api/v1/base-urls` | 按 base_url 聚合的上游提供商（含 `trusted` 布尔） |
| GET | `/api/v1/attestation` | 构建证明 |

`/api/v1/attestation` 的 `policy` 只给机器可读的编号，措辞由客户端自己决定（英文界面不该显示中文句子）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `policy.logs` | `no-bodies` | 不留请求体、不留响应体、不留上游提供商密钥 |
| `policy.storage` | `billing-fields-only` | D1 只存记账所需的最小字段 |
| `policy.keys` | `sealed-at-rest` | 上游提供商密钥仅在创建/更换时提交一次，服务端 AES-256-GCM 封装存库，库里只有密文 |

不在表里的取值原样显示——后端新增一条策略不会让前端白屏或吞掉信息。

## 身份

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 签名访问一次即开户。返回 `{address, balance_nanos, created}` |

## 账户（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/account/me` | `{address, label, balance_nanos, recharge_nanos, voucher_nanos, earn_nanos, gas_spend_nanos, token_spend_nanos, spend_nanos, withdraw_nanos, requests, providers, usage:{input_tokens,cached_tokens,output_tokens}, billed:{gas_fee_nanos,gas_billed_nanos,token_nanos,token_billed_nanos,unbilled_nanos}, earned:{requests,input_tokens,cached_tokens,output_tokens,token_nanos}}` |
| GET | `/api/v1/account/usage?limit=50&before=<request_id>` | 消费请求记录（不含内容），按 `request_id`（UUID v7）倒序游标翻页 |
| GET | `/api/v1/account/earnings?limit=50&before=<request_id>` | 上游 Token 收入记录（他人调用本账户上游转入的 Token 明细，含 `earn_before_nanos` / `earn_after_nanos`） |
| GET | `/api/v1/account/ledger?limit=50&cursor=<rowid>` | 账户级记账流水（券 / 充值 / 提现），游标是上一页最后一行的 `cursor` |
| GET | `/api/v1/account/usage/by-consumer` | 按下游消费者密钥聚合：`{consumer_id, consumer_name, key_hint, requests, input_tokens, cached_tokens, output_tokens, gas_fee_nanos, token_nanos, fee_nanos}` |
| GET | `/api/v1/account/usage/by-provider` | 按上游提供商聚合（同上，`provider_id` / `provider_label` / `is_own`） |

请求记录里每一行都能自己重算一遍：

```
fee_nanos = gas_billed_nanos + token_billed_nanos = gas_fee_nanos + token_nanos − unbilled_nanos
```

Gas 费（付给 Norm）与 Token 费（用户间价值转移）分开处理：
- 调用**自己的上游**（`provider_user === address`）：只收 Gas，`token_nanos = 0`、`token_billed_nanos = 0`；
- 调用**他人/公共池上游**（`provider_user !== address`）：先扣 Gas，余下余额扣 `token_billed_nanos` 并等额转入 `provider_user` 的 `earn_nanos`（记录在 `earn_before_nanos` / `earn_after_nanos`）。

`input_tokens` **含**缓存命中，`cached_tokens` 是其中命中上游提供商缓存的量（按便宜的价算），
`output_tokens` 单独计价。余额不够时 `unbilled_nanos` 大于 0，上游提供方仅收到实际扣到的 `token_billed_nanos`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/pricing` | 公开价目表：`{unit, default, models, protocols, gas_fee}`，单位是**纳美元 / 每百万 token** |
| GET | `/api/v1/protocols` | 协议契约：`{items:[{protocol, dialect, base_url, fields}]}`，前端据此「先选协议、再渲染字段」 |

`models` 是通用平表（一个型号一个价）；`protocols` 是协议自带的定价模式——目前只有
`deepseek`：同一批型号两档价（`peak` / `off_peak`），外加 `peak_windows_utc`、
`peak_weekdays`（ISO：1 = 周一）与 `off_peak_days`（法定节假日）。平表里 DeepSeek 只有
高峰价，低谷价只在那条协议上生效。

## 上游提供商（签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/providers` | 本人的上游提供商（含密文与 hint，不含明文密钥） |
| POST | `/api/v1/providers` | 新建，body 见下 |
| PATCH | `/api/v1/providers/:id` | 编辑已保存的配置，body 同下（全部可选，密钥留空即不改） |
| POST | `/api/v1/providers/:id/scope` | `{scope: 'private' \| 'pool'}`，进 / 出公共池（只有站点地址能写 `pool`） |
| POST | `/api/v1/providers/:id/enabled` | `{enabled: bool}`，禁用/启用 |
| DELETE | `/api/v1/providers/:id` | 撤销 |

基址从哪来由**协议**决定（见 `GET /api/v1/protocols` 的 `base_url` / `fields`）：四条通用方言
要 `base_url` + `provider_key`；`deepseek` 的基址固定为 DeepSeek 官方地址，只填密钥。
给固定基址的协议另填一个不同的 `base_url` 会被拒（`400 base_url_fixed`）——那不是在配置，
是在以为它能选。

`openai-oauth` 的基址**必须填你自己的一跳**（`https://<你的跳板>`，内部转发到
`https://chatgpt.com/backend-api/codex`）：Worker 的 `fetch` 会在出站请求上盖 `cf-worker`，
chatgpt.com 见到直接 403（实测直连 200、从边缘出去 403，把 `cf-worker` 置空也依旧 403）。
一跳同时决定这次调用的出口 IP——就是 OpenAI-LB 里 `http_proxy_url` 在做的那件事。
配方见 `docs/deploy.md` 末节。

```jsonc
// POST /api/v1/providers  → 201 { id }
{
  "label": "OpenAI 个人",                     // 必填，人看的名字；没有默认值
  "base_url": "https://api.openai.com/v1",    // 通用方言必填；创建后只有本人能改。
                                            // deepseek / opencode-go 的基址由协议给定，
                                            // 不能也不用填
  "provider_key": "sk-…",                     // 明文，只在这一次请求里；服务端立刻 AES-256-GCM 封装

  // 可选。protocol 默认最通用的 openai-chat；scope 默认 private，不写就绝不会进池子；
  // enabled 默认 true——新加的一条上游提供商就是拿来用的，禁用是用户主动做的减法。
  "protocol": "openai-chat",         // openai-chat | openai-responses
                                     // | anthropic-messages | google-gemini
                                     // | deepseek（说 Responses，按官方时段分两档计价）
                                     // | opencode-go（说 Chat，基址是 OpenCode Go 官方推理面，
                                     //    每个请求自动带 x-opencode-session）
  "scope": "private",                // private | pool（pool = 公开：进公共池，全站兜底用它；
                                     // 只有 POOL_ADMIN_ADDRESSES 里的地址能写 pool）
  "enabled": true                   // 禁用后不参与选址
}
```

`key_hint` 由服务端从明文算出（前 4 + `…` + 后 4），不接受客户端自报——否则提示与真实密钥可以不一致。
这也是已保存密钥**唯一**的展示方式：`PATCH` 只能替换它（`provider_key` 给新值就重新封装并更新提示），
没有任何一条路径能把明文读回来。

`PATCH /api/v1/providers/:id` 的字段全部可选：`label` / `protocol` / `enabled` /
`base_url` / `provider_key`。基址仍由协议决定——固定基址的协议不接受另一个地址（`400 base_url_fixed`）；
从固定基址换到通用方言时要带上新的 `base_url`，否则 `400 base_url_invalid`。

响应里的每条上游提供商还带一个 `trusted` 布尔：`base_url` 的主机名是否在 Worker 的
`TRUSTED_BASE_URLS` 清单里。后端只回这个事实，「官方 / 清单外」的措辞是前端的事。

`GET /api/v1/providers` 的响应另外带一个 `can_own_pool` 布尔：本账户在不在
`POOL_ADMIN_ADDRESSES` 里，也就是那个「公开」开关拨不拨得动。

`enabled = 0` 只是暂时不用它：密钥、历史记账、看板计数都还在，拨回来立刻恢复。
撤销（`DELETE`）才是永久退场。禁用同时影响三处：自动选址跳过它、`/v1/models` 拒绝它、
`/api/v1/base-urls` 与 `/api/v1/stats` 不再计入它。

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

## 转发（只认 Bearer 消费者密钥）

线缆方言只有**四种**（入站与出站共用同一套方言名）；上游协议在方言之上声明厂商契约（`deepseek` 与 `openai-oauth` 复用 `openai-responses`、`opencode-go` 复用 `openai-chat`，新增厂商协议零新增翻译代码）。**直通判定只比线缆上的方言**（`entry.dialect === profile.dialect`）：

| 入口 | 客户端 | 上游方言 `openai-chat`（含 `opencode-go`） | `openai-responses`（含 `deepseek`、`openai-oauth`） | `anthropic-messages` | `google-gemini` |
|---|---|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI SDK / curl | 直通 | 桥接 | 桥接 | 桥接 |
| `POST /v1/responses` | Codex CLI | 桥接 | 直通 | 桥接 | 桥接 |
| `POST /v1/messages` | Anthropic SDK / Claude Code | 桥接 | 桥接 | 直通 | 桥接 |
| `POST /v1/models/{model}:generateContent` | Google SDK | 桥接 | 桥接 | 桥接 | 直通 |

**同方言直通不转换。** 入口方言等于上游协议所声明的线缆方言（`dialect`）时，请求体按原始字节发给上游提供商，
响应体原样返回（只多一个 `norm` 字段）。一个字段都不碰，包括 `tools`、`tool_choice`、
`response_format` 这些我们没打算理解的字段。

**唯一会改请求体的地方**：流式请求打向 chat 方言的上游（`openai-chat` 与 `opencode-go`）时，Norm 会补一个
`stream_options.include_usage: true`——那种上游默认不回 token 用量，而账本就靠它算钱。
它额外产生的那条用量帧（`choices: []`，只带 `usage`）由 Norm 吃掉：客户端没要，就不会
突然收到一条它没预期的帧；客户端本来就要了（`include_usage: true`），就原样转发。

**跨方言才过规范中间态桥接**：入口方言 → 规范中间态（`src/dialects.ts`）→ 上游方言编解码（`src/codecs.ts`）→ 回来时渲染成入口方言。
桥只按 4 种线缆方言组织（4 段入站 + 4 段出站，复杂度 $M + N$），厂商协议只复用方言，不产生新的翻译路径。

**跨方言翻译工具调用。** 四家的 `tools` / `tool_choice` / `tool_calls` / 工具结果形状各不相同，
Norm 把它们归一成一份扁平的规范形式再各自说回去：Chat 套一层 `function`、Anthropic 用
`tool_use` / `tool_result` 块、Responses 用独立的 `function_call` 条目、Gemini 用
`functionCall` / `functionResponse`。工具结果按调用 id 对齐（Gemini 只说得出函数名，按名字回溯）。
有工具调用的回答，Chat 的 `finish_reason` 是 `tool_calls`、Anthropic 的 `stop_reason` 是
`tool_use`；`tool_choice` 的四种说法（`auto` / `none` / `required` / 点名一个）同样互译。
同格式直通不受影响（我们不碰请求体）。

流式：`stream: true` 或 Gemini 的 `:streamGenerateContent`。跨方言时上游提供商 SSE 被翻译成
入口方言自己的帧（`response.output_text.delta` / `content_block_delta` / `candidates`
裸 data 帧）。用量一边转发一边从上游提供商的帧里嗅出来（四家的位置各不相同：chat 在末帧、
Anthropic 在 `message_start` + `message_delta`、Gemini 每帧累计、Responses 在
`response.completed`），所以**收尾帧里的 token 数就是记账用的那一份**；上游提供商一次都没给时
三项都是 0，账单也就只有 Gas 费。
同格式直通时上游提供商的帧原样到达，一个事件都不加——`request_id` 从 `X-Norm-Request-Id` 响应头读。
唯一的例外是 `/v1/chat/completions` 直通：流末插一条 `{"norm":…}`，因为 Playground 是它的客户端。

| 头 | 是否必填 |
|---|---|
| `Authorization: Bearer sk-norm-…` | 三选一（OpenAI SDK 的形状） |
| `x-api-key: sk-norm-…` | 三选一（Anthropic SDK / Claude Code 的形状） |
| `x-goog-api-key: sk-norm-…` | 三选一（Google SDK 的形状） |
| `thread-id` / `session-id` | 可选：只影响「粘在哪条上游上」，不影响能不能调通 |
| `X-Norm-Address` 等四个签名头 | 不收：本面没有签名入口 |

上游提供商密钥始终由服务端解密，客户端不接触它。

**走哪条上游由服务端决定**：自己的上游优先（启用中、未撤销），一条都不可用时落到**公共池**；
同一个 `thread-id` / `session-id` 在候选不变时粘在同一条上（`thread-id` 优先），两个头都没有的
请求按 rendezvous 摊开。两条都没有可用上游时：自己的上游都被禁用 → `409 provider_disabled`；
压根没有上游 → `400 provider_missing`。账单里的 `norm.pool` 说明这一单有没有落到公共池上。
这条规则与身份无关：绑定不是身份的一部分，是每次转发自己的决定。

三个 api key 头里只有带 `sk-norm-` 前缀的值会被当成消费者密钥；一个都没有（或放的是别家的 key）时
不会退回去验签，而是 `401 consumer_key_required`——转发面只有 Token 这一条路。

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
  "norm": { "request_id": "req_…", "fee_nanos": 2420, "gas_fee_nanos": 2420, "gas_billed_nanos": 2420,
            "token_nanos": 0, "token_billed_nanos": 0,
            "unbilled_nanos": 0, "balance_nanos": 999997580, "latency_ms": 812, "host": "api.openai.com",
            "pool": false }
}
```

**失败也收 Gas。** 上游提供商 4xx/5xx 或网络不可达时，响应体是上游的原话（一个字节都不改写，
也不带 `norm`），账单挂在响应头上：`X-Norm-Request-Id` 与 `X-Norm-Gas-Fee-Nanos`（这一次真正扣掉的
Gas）。此时 `token_nanos = 0`、`fee_nanos = gas_fee_nanos`——请求已经被执行过，只是没拿到答案。
没打到上游的请求（体不是 JSON、余额不足、没配上游提供商）不记账也不扣。

`/v1/chat/completions` 的流式在最后一个 SSE 事件之前插入一条 `data: {"norm":{...}}`；
另外三条入口的流式不插（那些 SDK 按 `type` 严格分派，插一个它们不认识的事件比丢一条记账信息更糟）。

## 音频（只认 Bearer 消费者密钥）

下游只有一种形状：OpenAI 的音频接口。上游怎么说不重要——`qwen` 协议在这里把 Qwen 的原生
接口翻成这两个端点（Qwen LB 的逻辑，落在 Norm 的一个协议里），`openai-audio` 协议则把请求
原样转给一条已经说 OpenAI 音频的上游。

```bash
# 转写：multipart，file 必填，model / language 可选（language 留空或 auto 由上游自己认）
curl https://norm.ntnl.io/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-norm-…" \
  -F 'file=@sample.wav' -F 'model=qwen-audio-3.0-asr-flash' -F 'language=zh'

# → 200 {"text":"…","norm":{…}}   norm 就是别处那个账单结论，多两项音频用量
#   audio_ms（这次转写覆盖的音频毫秒数）、audio_characters（合成念的字数，转写恒为 0）

# 合成：JSON，input / model / voice 三个字段缺一不可，回 WAV 字节
curl https://norm.ntnl.io/v1/audio/speech \
  -H "Authorization: Bearer sk-norm-…" \
  -H "Content-Type: application/json" \
  -d '{"input":"你好，世界","model":"qwen3-tts-flash","voice":"Cherry"}' --output speech.wav
```

合成回的是字节，账目挂在响应头上：`X-Norm-Request-Id`、`X-Norm-Fee-Nanos`、
`X-Norm-Token-Nanos`、`X-Norm-Gas-Billed-Nanos`。

两条限制都是硬拒绝，都在打上游之前：

- **一次转写最多 24 MiB 音频**（base64 之后仍在上游限制内），超了回 `413 audio_too_large`。
- **型号必须出现在音频价目表里**，否则回 `400 audio_model_unpriced`：音频按秒、按字符或按
  token 计价，没有兜底价可言。价目表在 `src/pricing.ts` 的 `AUDIO_RATES`，`GET /api/v1/pricing`
  回的就是它的当前值。

上游回的错原话照回（状态码与响应体都不改），那一笔只收 Gas、不收 Token 费——与推理路径同一口径。

## 模型清单（只认 Bearer 消费者密钥）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 这个上游有哪些模型。`{object:"list", data:[{id, object:"model", created?, owned_by?}]}` |
| GET | `/v1/models/{model}` | 单个模型；没有上游的清单里有它 → `404 model_not_served`；选中那条的清单里没有 → `404 model_not_found` |

选址规则与转发完全一样（自己的上游优先、公共池兜底、会话亲和）。
上游的清单在这里被归一成 OpenAI 形状，所以一个客户端不必知道自己接的是哪家：

| `upstream_protocol` | 问的上游路径 | 上游回什么 |
|---|---|---|
| `openai-chat` / `openai-responses` / `deepseek` | `{base}/models` | `data[].id` + `created` + `owned_by` |
| `opencode-go` | `{base}/openai/v1/models` | `data[].id` + `created` + `owned_by` |
| `openai-oauth` | `{base}/models` | **问不到**：它的清单端点要一个 `client_version`、回的是 `{models:[{slug}]}`，不在四种方言的清单形状里。这一版不探它——选址把「清单未知」的上游当可用，跑错型号会被上游的 400 划掉一行 |
| `anthropic-messages` | `{base}/v1/models` | `data[].id` + `created_at`（ISO 字符串 → unix 秒），没有 `owned_by` |
| `google-gemini` | `{base}/v1beta/models` | `models[].name`，`models/` 前缀被剥掉 |

### 模态是上游的原话，不是 Norm 的判断

输入 / 输出模态只在**管理面**的模型总表里出现（`GET /api/v1/models`，签名），而且只写
上游自己声明过的那一句。官方清单里本来就没有这个字段，只有 OpenRouter 那一系（以及照抄它
形状的聚合型上游）会多带一段 `architecture`；认得三种写法：

| 写法 | 说明 |
|---|---|
| `architecture.input_modalities` / `output_modalities` | 主字段，字符串数组 |
| `architecture.modality` | 老字段，一个字符串：`text+image->text` |
| `input_modalities` / `output_modalities` | 摊平在顶层的抄法 |

总表的一行因此多一个字段：

```jsonc
{
  "id": "openai/gpt-4o-mini",
  "providers": ["prv_…"],
  "modalities": { "input": ["text", "image"], "output": ["text"], "declared": 1 }
}
```

- **谁都没声明就是 `null`**，不是「只能文本」。OpenAI / Anthropic / Google 的官方清单里根本
  没有这个字段，所以 `null` 是常态，没人会替你补一个默认的 `["text"]`。
- `declared` 是这一行有几条上游真的说了。少于 `providers.length` 时，`input` / `output` 是
  **并集**：有上游说能读图，不代表随便落到一条上都能读。这个数就是给读的人判断全票还是一票的。
- 一个词认不出（不在 `[a-z0-9_.-]{1,16}` 里）就丢掉，不往表里塞；只声明了一半的照实只写一半。
- 数据面 `GET /v1/models` **不变**：它照 OpenAI 的形状回答（`id` / `created` / `owned_by`），
  模态不进来——那是给客户端列模型的，不是给人挑模型的。

`created` / `owned_by` 不是每家都给，缺了就不编——**空字段比假字段好**。模型名里可能有斜杠
（`meta-llama/Llama-3`、`models/gemini-2.0-flash`），所以 `/v1/models/{model}` 收整段剩余路径。

**这一路不扣费**：列清单不是一次生成，没有 token；它确实消耗一次 Worker 调用，那一笔由站点自己吃掉。
它不写请求记录、不动账本，响应里的 `norm` 明确写着 `fee_nanos: 0`、`gas_fee_nanos: 0`、
`balance_nanos: null`（没去读余额，所以不报一个可能过期的数）。
上游失败时它的原话原样返回，与转发同一套做法。

```bash
curl https://norm.ntnl.io/v1/models -H "Authorization: Bearer sk-norm-…"
```
