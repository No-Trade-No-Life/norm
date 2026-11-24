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

## 3. BYOK 密文（服务端读不懂）

```
key      = PBKDF2-SHA256(passphrase, salt = "norm-v1|" + address, c = 600000, dkLen = 32)
sealed   = base58( nonce24 || XChaCha20-Poly1305(key, nonce24, plaintext = utf8(upstreamKey), aad = utf8(address)) )
kdf      = "pbkdf2-sha256-600000+xchacha20poly1305"
```

- 只用 `@noble/hashes/pbkdf2` + `@noble/ciphers/chacha`（`xchacha20poly1305`）。
- 服务端只存 `sealed`、`kdf`、`key_hint`（前 4 + `…` + 后 4，明文密钥被截断后的展示用），从不接收 passphrase。
- 调用模型时由浏览器解封，把明文密钥放进 `X-Norm-Upstream-Key` 随该次请求发送；Worker 只用不存。

## 4. 计费计数器

- 全部是**整数微美元**（`1e-6 USD`），不用浮点。
- `REQUEST_FEE_MICROS` 每次成功转发扣一次；失败请求（上游 4xx/5xx、网络错误）**不扣**（`fee_micros = 0`），
  但照样记一条 `requests`，因为隔离执行的成本由站点承担——这是给用户的诚实账。
- 账本 `balance_after_micros` 必须与 `principals.balance_micros` 在同一事务里一致。
