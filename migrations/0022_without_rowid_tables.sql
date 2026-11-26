-- 把高频写入的 requests 与 affinities 重建为 WITHOUT ROWID 聚簇表，彻底消除冗余 B-tree 行写：
--
--   1. requests：全仓所有查询都按 address 过滤并按 id（UUID v7）倒序翻页，
--      没有任何一处按单 id 查表。改为 PRIMARY KEY (address, id) WITHOUT ROWID 后，
--      表行与主键索引合并为一棵聚簇 B-tree、0 条二级索引：
--      INSERT INTO requests 从 3 行写（表 + PK + requests_address_id）降到 1 行写（省 2,000 纳/次）。
--
--   2. affinities：改为 PRIMARY KEY (address, affinity_hash) WITHOUT ROWID、
--      去掉二级索引 affinities_address：
--      UPSERT / DELETE 从 3 行写降到 1 行写（省 2,000 纳/次），同时完整保留单候选写亲和语义
--      （以后新增上游时老会话不丢 Prompt Cache），且不再在每次写亲和时顺手删过期行。

CREATE TABLE requests_new (
  id                 TEXT NOT NULL,
  address            TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  provider_id        TEXT,
  provider_user      TEXT,
  consumer_id        TEXT,
  consumer_user      TEXT,
  base_url           TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL,
  status             TEXT NOT NULL,
  status_code        INTEGER,
  latency_ms         INTEGER NOT NULL,
  first_token_ms     INTEGER,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  gas_fee_nanos      INTEGER NOT NULL DEFAULT 0,
  token_nanos        INTEGER NOT NULL DEFAULT 0,
  fee_nanos          INTEGER NOT NULL,
  unbilled_nanos     INTEGER NOT NULL DEFAULT 0,
  spend_before_nanos INTEGER NOT NULL DEFAULT 0,
  spend_after_nanos  INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (address, id)
) WITHOUT ROWID;

INSERT INTO requests_new (
  id, address, provider_id, provider_user, consumer_id, consumer_user,
  base_url, model, status, status_code, latency_ms, first_token_ms,
  input_tokens, cached_tokens, output_tokens,
  gas_fee_nanos, token_nanos, fee_nanos, unbilled_nanos,
  spend_before_nanos, spend_after_nanos, created_at
)
SELECT
  id, address, provider_id, provider_user, consumer_id, consumer_user,
  base_url, model, status, status_code, latency_ms, first_token_ms,
  input_tokens, cached_tokens, output_tokens,
  gas_fee_nanos, token_nanos, fee_nanos, unbilled_nanos,
  spend_before_nanos, spend_after_nanos, created_at
FROM requests;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

CREATE TABLE affinities_new (
  address       TEXT NOT NULL,
  affinity_hash TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (address, affinity_hash)
) WITHOUT ROWID;

INSERT INTO affinities_new (address, affinity_hash, provider_id, expires_at, updated_at)
SELECT address, affinity_hash, provider_id, expires_at, updated_at
FROM affinities;

DROP TABLE affinities;
ALTER TABLE affinities_new RENAME TO affinities;
