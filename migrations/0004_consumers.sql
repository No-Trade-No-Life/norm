-- 下游消费者：一类新的调用者。
--
-- 两侧身份现在各有各的凭据形式：
--   浏览器 / 审计侧  Ed25519 逐请求签名（公钥即地址）
--   下游程序        Bearer sk-norm-…（库里只存 sha256，明文只在创建与轮换时出现一次）
CREATE TABLE consumers (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- 只存哈希：拖库拿不到任何可用的下游密钥。
  key_sha256  TEXT NOT NULL UNIQUE,
  key_hint    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX consumers_address ON consumers(address, created_at DESC);
