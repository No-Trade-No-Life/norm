# Norm 密码学契约（前后端唯一真相）

所有编码都是 **base58（Bitcoin 字母表）**，无填充。字符串比较一律按字节。

## 1. 身份

```
种子   = 32 字节随机             →  ed25519 keypair（RFC 8032）
公钥   = 32 字节（由种子派生）    →  address = base58(publicKey)
密钥   = 种子 || 公钥 = 64 字节   →  存储与备份的单位
```

- 密钥用 **拓展形式**：64 字节的 `seed(32) || publicKey(32)`，与 **Solana 的密钥种子一致**
  （即 `solana-keygen` 写进 `id.json` 的那 64 个数字、`@solana/web3.js` 里 `secretKey` 的布局）。
- 浏览器用 `@noble/curves/ed25519`：派生用 `ed25519.getPublicKey(seed)`，签名用
  `ed25519.sign(msg, seed)`——**noble 只吃 32 字节种子**，64 字节里的后 32 字节是给人看的、
  给别的钱包用的公钥副本，签名前取 `keypair.subarray(0, 32)`。
- 服务端用 `@noble/curves/ed25519` 的 `ed25519.verify(sig, msg, publicKey)`，与密钥形态无关。
- 密钥落在浏览器 `localStorage['norm.identity.keypair']`（base58 的 64 字节）。没有服务端会话。

### 1a. 导入导出与旧格式迁移

| 形状 | 例子 | 处理 |
|---|---|---|
| base58 · 64 字节 | `4vJ9JU…`（本版导出） | 直接接受；校验公钥段 = 派生公钥 |
| JSON 数组 · 64 个整数 | `[1,2,…,64]`（Solana `id.json`） | 同上 |
| base58 · 32 字节 | 旧版 `norm.identity.seed` 的值 | 按种子派生公钥，升级为 64 字节 |
| JSON 数组 · 32 个整数 | 旧种子被转成数组 | 同上 |

- 64 字节里「公钥段 ≠ 种子派生结果」一律**拒绝**，不静默按种子重算——否则用户会以为
  自己在用那把公钥。
- 迁移在读取时进行，写新键后再删旧键（`norm.identity.seed`）：先写保证不会丢密钥，
  删旧保证不存在两份互相矛盾的身份来源。**地址与账户不变**，只是备份格式变了。
- 旧值解析失败时不清空它：那是用户手抄备份之外的最后一份副本，坏了也不该被我们删掉。

## 2. 请求签名

请求头（都存在时才算签名请求）：

```
X-Norm-Address   base58(publicKey)
X-Norm-Timestamp 十进制 unix 秒
X-Norm-Signature base58(64 字节签名)
```

待签名串（UTF-8，`\n` 分隔，末尾无换行）：

```
norm-v1\n{METHOD}\n{PATH}\n{timestamp}\n{sha256hex(body)}
```

- `METHOD` 大写；`PATH` 是 `new URL(request.url).pathname`（不含 query）。
- `body` 是原始请求体字节；无 body 时用空字节串（`sha256hex("")` = `e3b0c442…`）。
- 服务端校验顺序：头部齐全 → 时间戳在 ±`SIGNATURE_WINDOW_SECONDS`（60 秒）内 → 验签 → 放行。
  鉴权这一步**一行都不写**。
- 浏览器 ↔ Cloudflare Worker 全程走 TLS，不额外维护 nonce / 重放表；时间窗只保证签名新鲜度。

## 3. 上游提供商密钥的封装（拖库拿不到明文）

```
key     = base64url 解码 NORM_MASTER_KEY（必须是 32 字节，Worker secret，不进仓库、不进 D1）
sealed  = base64url( iv12 || AES-256-GCM(key, iv12, plaintext = utf8(providerKey), aad = utf8(address + "|" + providerId)) )
kdf     = "aes-256-gcm+worker-secret"
```

- 封装与解封都在 Worker 里：`POST /api/v1/providers` 收到明文 `provider_key`，立刻封装后丢弃；
  `POST /v1/chat/completions` 现解现用，只在本次请求的作用域里存在。
- AAD 把密文绑到「哪个账户的哪条上游提供商」，两条记录被互换也会解密失败，不需要额外的完整性字段。
- 库里只有 `sealed_key`、`kdf`、`key_hint`（前 4 + `…` + 后 4）。
- 为什么不早先那套「用户口令派生」：口令只保护**存储中的副本**，而中转站每次调用都必然看见明文，
  它防不住运行期、只能防拖库；既然如此，一把由系统配置的高熵密钥就够了，也不引入弱口令与「每次调用重输」的负担。
- 代价要说清：拿到 `NORM_MASTER_KEY` 又拿到库，就能解开全部上游提供商密钥。所以它是 Worker secret，
  轮换等于全量重封（旧密文解不开，必须重录或做一次迁移）。

## 3b. 下游消费者密钥（`sk-norm-…`）

```
key       = "sk-norm-" + base58(32 字节随机)        → 只在创建与轮换的响应里出现一次
key_sha256 = sha256hex(utf8(key))                    → 库里唯一存的形态（UNIQUE 索引即查表）
key_hint  = "sk-norm-" + 前 4 + "…" + 后 4           → 列表与页面只用它
```

- 查表即鉴权：`Authorization: Bearer sk-norm-…` → `key_sha256` → 账户。
- 轮换就地替换哈希，旧钥立刻失效，备注名与使用历史留在同一行。
- 管理面（`/api/v1/*`）只认签名，所以一把下游密钥不能再铸钥匙、也撤销不了上游提供商。
- 转发面（`/v1/*`）反过来只认 Token：签名进不了推理接口，所以每一笔消费都挂在一条 `consumer_id` 上。

## 4. 计费计数器

- 全部是**整数纳美元**（`1e-9 USD`），不用浮点。
- `GAS_FEE_NANOS` 每一次真的打出去的调用扣一次，成功失败都一样：上游提供商 4xx/5xx 或网络不可达时
  `token_nanos = 0`、`fee_nanos = gas_fee_nanos`，但照样记一条 `requests`——「这次被执行过」是事实，
  删掉它就是伪造历史。没打到上游的请求（体不是 JSON、余额不足）不记账也不扣。
- 账本 `balance_after_nanos` 必须与 `principals.balance_nanos` 在同一事务里一致。
