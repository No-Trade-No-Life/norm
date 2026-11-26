-- 一次性不再靠一张 nonces 表：时间窗只管新鲜度，幂等键落在被改的那一行上。
--
-- 旧做法对**每一次**签名调用都写两行（nonces 的表行 + 主键索引），读也一样，而 D1 按行
-- 计费；这张表还只能靠手工脚本清理。新做法（见 src/idempotent.ts）：
--
--   · 读（GET / HEAD）不查也不写任何去重状态 —— 重放一次读没有副作用；
--   · 创建类的行 id 由幂等键派生，`INSERT ... ON CONFLICT DO NOTHING` 落空即「已应用」；
--   · 修改 / 删除类把幂等键写进这一行的 last_nonce，条件更新落空即「重放」。
--
-- 于是去重不产生任何额外写入：它本身就是那次真正的改动。
--
-- 只删这张表与新加两列，别的数据一行都不动。
DROP TABLE IF EXISTS nonces;

ALTER TABLE providers ADD COLUMN last_nonce TEXT;
ALTER TABLE consumers ADD COLUMN last_nonce TEXT;
