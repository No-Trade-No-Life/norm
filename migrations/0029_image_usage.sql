-- 图像调用的用量。
--
-- 与音频那两列同一个道理：token 三项回答不了「画了一张多大的图」。`image_count` 是这次
-- 画了几张，`image_pixels` 是一张图的像素数（上游回显的那个实际尺寸）。两列都只是**用量**，
-- 不是钱——钱仍然只落在 gas_fee_nanos / token_nanos 上，口径与另外两条路一模一样。
ALTER TABLE requests ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN image_pixels INTEGER NOT NULL DEFAULT 0;
