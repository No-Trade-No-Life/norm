-- 上游提供商的启用/禁用开关。
--
-- 禁用不是撤销：密钥、历史记账、公开看板上的计数都还在，只是这条上游提供商
-- 不再参与选址，也不能被 X-Norm-Provider 指名。两者回答的是不同的问题——
-- 「暂时不用它」应该随时能拨回来，而撤销（revoked_at）是永久退场。
--
-- 默认启用：新加的这条就是拿来用的。禁用是用户主动做的减法。
ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
