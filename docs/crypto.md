# Norm 密码学契约（前后端唯一真相）

所有编码都是 **base58（Bitcoin 字母表）**，无填充。字符串比较一律按字节。

## 1. 身份

```
私钥 = 32 字节随机种子   →   ed25519 keypair（RFC 8032）
公钥 = 32 字节            →   address = base58(publicKey)
```

- 浏览器用 `@noble/curves/ed25519` 的 `ed25519.getPublicKey(seed)` 与 `ed25519.sign(msg, seed)`。
- 服务端用 `@noble/curves/ed25519` 的 `ed25519.verify(sig, msg, publicKey)`。
- 私钥落在浏览器 `localStorage['norm.identity.seed']`（base58）。没有服务端会话。

## 2. 请求签名

请求头（都存在时才算签名请求）：

```
X-Norm-Address   base58(publicKey)
X-Norm-Timestamp 十进制 unix 秒
X-Norm-Nonce     16 字节随机 → base58（22~24 字符）
X-Norm-Signature base58(64 字节签名)
```

待签名串（UTF-8，`\n` 分隔，末尾无换行）：

```
norm-v1\n{METHOD}\n{PATH}\n{timestamp}\n{nonce}\n{sha256hex(body)}
```

- `METHOD` 大写；`PATH` 是 `new URL(request.url).pathname`（不含 query）。
- `body` 是原始请求体字节；无 body 时用空字节串（`sha256hex("")` = `e3b0c442…`）。
- 服务端校验顺序：头部齐全 → 时间戳在 ±`SIGNATURE_WINDOW_SECONDS` 内 → `(address, nonce)` 首次出现 → 验签。
- nonce 一经落库即作废；同一 nonce 第二次到达一律 401 `nonce_replayed`。

## 3. 上游密钥的封装（拖库拿不到明文）

```
key     = base64url 解码 NORM_MASTER_KEY（必须是 32 字节，Worker secret，不进仓库、不进 D1）
sealed  = base64url( iv12 || AES-256-GCM(key, iv12, plaintext = utf8(upstreamKey), aad = utf8(address + "|" + credentialId)) )
kdf     = "aes-256-gcm+worker-secret"
```

- 封装与解封都在 Worker 里：`POST /api/v1/credentials` 收到明文 `upstream_key`，立刻封装后丢弃；
  `POST /v1/chat/completions` 现解现用，只在本次请求的作用域里存在。
- AAD 把密文绑到「哪个账户的哪条凭证」，两条记录被互换也会解密失败，不需要额外的完整性字段。
- 库里只有 `sealed_key`、`kdf`、`key_hint`（前 4 + `…` + 后 4）。
- 为什么不早先那套「用户口令派生」：口令只保护**存储中的副本**，而中转站每次调用都必然看见明文，
  它防不住运行期、只能防拖库；既然如此，一把由系统配置的高熵密钥就够了，也不引入弱口令与「每次调用重输」的负担。
- 代价要说清：拿到 `NORM_MASTER_KEY` 又拿到库，就能解开全部上游密钥。所以它是 Worker secret，
  轮换等于全量重封（旧密文解不开，必须重录或做一次迁移）。

## 3b. 下游消费者密钥（`sk-norm-…`）

```
key       = "sk-norm-" + base58(32 字节随机)        → 只在创建与轮换的响应里出现一次
key_sha256 = sha256hex(utf8(key))                    → 库里唯一存的形态（UNIQUE 索引即查表）
key_hint  = "sk-norm-" + 前 4 + "…" + 后 4           → 列表与页面只用它
```

- 查表即鉴权：`Authorization: Bearer sk-norm-…` → `key_sha256` → 账户。
- 轮换就地替换哈希，旧钥立刻失效，备注名与使用历史留在同一行。
- 管理面（`/api/v1/*`）只认签名，所以一把下游密钥不能再铸钥匙、也撤销不了凭证。

## 4. 计费计数器

- 全部是**整数微美元**（`1e-6 USD`），不用浮点。
- `REQUEST_FEE_MICROS` 每次成功转发扣一次；失败请求（上游 4xx/5xx、网络错误）**不扣**（`fee_micros = 0`），
  但照样记一条 `requests`，因为隔离执行的成本由站点承担——这是给用户的诚实账。
- 账本 `balance_after_micros` 必须与 `principals.balance_micros` 在同一事务里一致。
