-- 选址与上游列表都是「先按 address = ? 或 scope = 'pool' 收窄，再按 (created_at, id) 排」：
-- 没有覆盖索引时，SQLite 只能扫全表再临时排序（线上实测每次推理读 13–15 行，全站上游多少就读多少）。
-- 这两条索引让收窄只读匹配的行，且 (created_at, id) 直接在索引里有序，不再排序。
-- providers 一天只写几次，多两条索引的写代价可以忽略。
CREATE INDEX IF NOT EXISTS providers_serving_address ON providers(address, enabled, created_at, id);
CREATE INDEX IF NOT EXISTS providers_serving_pool ON providers(scope, enabled, created_at, id);
