-- Norm 初始 schema：身份即公钥，账本是纯追加流水，请求表不留内容。
PRAGMA foreign_keys = ON;

-- 身份：address = base58(ed25519 公钥)。没有密码、没有邮箱、没有会话。
CREATE TABLE principals (
  address               TEXT PRIMARY KEY,
  label                 TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  balance_micros        INTEGER NOT NULL DEFAULT 0,
  granted_micros        INTEGER NOT NULL DEFAULT 0,
  spend_micros          INTEGER NOT NULL DEFAULT 0
);

-- 每个签名的一次性随机数：唯一键即防重放。
CREATE TABLE nonces (
  address TEXT NOT NULL,
  nonce   TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (address, nonce)
);

-- BYOK 凭证：只有密文，服务端读不懂明文密钥。
CREATE TABLE credentials (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  key_hint        TEXT NOT NULL,
  sealed_key      TEXT NOT NULL,
  kdf             TEXT NOT NULL,
  declared_source TEXT NOT NULL,
  public_listed   INTEGER NOT NULL DEFAULT 0,
  provenance      TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX credentials_address ON credentials(address, created_at DESC);

-- 逐请求记账。ZDR：这里没有 prompt，也没有 completion。
CREATE TABLE requests (
  id                TEXT PRIMARY KEY,
  address           TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  credential_id     TEXT,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL,
  status_code       INTEGER,
  latency_ms        INTEGER NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  fee_micros        INTEGER NOT NULL,
  provenance        TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL
);
CREATE INDEX requests_address_created ON requests(address, created_at DESC);

-- 纯追加流水：grant 为正、charge 为负，每条 charge 都能回到那一次请求。
CREATE TABLE ledger (
  id                   TEXT PRIMARY KEY,
  address              TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  request_id           TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('grant', 'charge')),
  amount_micros        INTEGER NOT NULL,
  balance_after_micros INTEGER NOT NULL,
  created_at           INTEGER NOT NULL
);
CREATE INDEX ledger_address_created ON ledger(address, created_at DESC);
