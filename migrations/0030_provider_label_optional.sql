-- 标签是给人看的，不是必填项。
--
-- 此前 label 是 NOT NULL，创建时缺了它直接 400：于是「加一条上游」多了一道与功能无关的
-- 填空题。跑一条上游只需要三件事——base_url（打到哪）、protocol（说什么方言）、
-- provider_key（用什么打）；名字只影响回头认人，不该挡住前两件。
--
-- 空值统一成 NULL（历史的空串一并归过来，免得同一件事有两种空法）：
--   * 读出来是 null：怎么显示由前端决定，它退回到主机名；
--   * 写的时候 null / 空串 / 不填都是「没有标签」。
--
-- SQLite 不能 DROP NOT NULL，只能重建表；列、默认值与约束逐字照抄现状（0029 之后），
-- 只把 label 放开成可空，其余一个字都不动。
CREATE TABLE providers_new (
  id                TEXT PRIMARY KEY,
  address           TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  label             TEXT,
  base_url          TEXT NOT NULL,
  key_hint          TEXT NOT NULL,
  sealed_key        TEXT NOT NULL,
  kdf               TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  protocol          TEXT NOT NULL DEFAULT 'openai-chat',
  enabled           INTEGER NOT NULL DEFAULT 1,
  scope             TEXT NOT NULL DEFAULT 'private',
  models_fetched_at INTEGER NOT NULL DEFAULT 0,
  sealed_proxy      TEXT NOT NULL DEFAULT '',
  proxy_hint        TEXT NOT NULL DEFAULT ''
);

INSERT INTO providers_new (
  id, address, label, base_url, key_hint, sealed_key, kdf, created_at, revoked_at,
  protocol, enabled, scope, models_fetched_at, sealed_proxy, proxy_hint
)
SELECT
  id, address, NULLIF(label, ''), base_url, key_hint, sealed_key, kdf, created_at, revoked_at,
  protocol, enabled, scope, models_fetched_at, sealed_proxy, proxy_hint
FROM providers;

DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;

-- DROP TABLE 会连索引一起带走，重建回原来那两条。
CREATE INDEX IF NOT EXISTS providers_address ON providers(address, created_at DESC);
CREATE INDEX IF NOT EXISTS providers_base_url ON providers(base_url);
