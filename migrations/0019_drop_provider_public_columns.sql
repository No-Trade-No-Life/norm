-- 「公开」只留一个语义：scope = 'pool'（公共池，全站在自己的上游不可用时兜底用它）。
--
-- 在此之前有三列都在说「公开」，而三种说法之间没有任何行为差别：
--   visibility     —— 从不参与选址，只是一列文案；
--   public_listed  —— 只影响看板上的一个计数，连 base_url 聚合的计入都不看它；
--   scope          —— 唯一真正决定「别人用不用得到」的那一列。
-- 于是同一条上游可以同时被标成「公开可用」和「未公开」，页面自相矛盾。
-- 删掉前两列：公开 = 进公共池，其余一律私有。
ALTER TABLE providers DROP COLUMN visibility;
ALTER TABLE providers DROP COLUMN public_listed;
