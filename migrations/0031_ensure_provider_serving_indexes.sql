-- 补建 providers 选址覆盖索引：
-- PR #103 新增的 0027_provider_serving_indexes.sql 编号落在 0030_provider_label_optional.sql 之前，
-- 在全新库/本地测试库按文件名顺序执行迁移时，0030 的 DROP TABLE providers 会把这两条索引一并带走。
-- 线上库已执行过 0027，这里用 IF NOT EXISTS 幂等补齐，保证线上与全新库索引完全一致。
CREATE INDEX IF NOT EXISTS providers_serving_address ON providers(address, enabled, created_at, id);
CREATE INDEX IF NOT EXISTS providers_serving_pool ON providers(scope, enabled, created_at, id);
