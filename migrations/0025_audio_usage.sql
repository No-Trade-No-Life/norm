-- 音频调用（转写 / 合成）的用量。
--
-- 三种 token 列回答不了音频：一次转写没有 token，只有它覆盖的音频时长；一次按字符计价的
-- 合成没有 token，只有念了多少个字。两列都是**用量**，不是钱——钱仍然只落在
-- gas_fee_nanos / token_nanos 上，口径与文本那条路一模一样（token_nanos 是转给上游
-- 提供方的价值，调用自有上游时为 0）。
--
-- 毫秒用整数而不是 REAL：纳美元这一路一个浮点都不进来，别在进门第一步就破例。
ALTER TABLE requests ADD COLUMN audio_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN audio_characters INTEGER NOT NULL DEFAULT 0;
