-- 一次性清理：转发面只认 Token 之前，「签名直连」留下的历史。
--
-- 那时 `/v1/*` 也接受 Ed25519 签名，于是那些消费没有挂在任何一把下游 Token 上
-- （`requests.consumer_id IS NULL`）。规矩改掉之后这批行再也解释不清「这段代码是谁」，
-- 只剩一个地址——而账本要回答的是「哪把钥匙花了这笔钱」。所以把这些请求连同它们
-- 对应的 Gas 扣费流水一起删掉，再按幸存流水把余额重算一遍。
--
-- 只碰 `consumer_id IS NULL` 的行：挂得住钥匙的历史一行不动。重复执行是安全的
-- （第二次开始子查询为空，重算也不会改变什么）。
--
-- 用法：wrangler d1 execute norm --remote --file=scripts/cleanup-signed-relay.sql

-- 1. 这批请求的扣费流水先走（grant 不动：授信不是消费，与身份无关）。
DELETE FROM ledger
WHERE kind = 'charge'
  AND request_id IN (SELECT id FROM requests WHERE consumer_id IS NULL);

-- 2. 请求记录本身。
DELETE FROM requests WHERE consumer_id IS NULL;

-- 3. 余额是流水的缓存：表格三列一律按幸存流水重算，不靠增量加减。
--    （有些地址只剩 grant，余额就回到授信额——那正是它们真实的账面。）
UPDATE principals SET
  balance_nanos = (SELECT COALESCE(SUM(l.amount_nanos), 0) FROM ledger l WHERE l.address = principals.address),
  granted_nanos = (SELECT COALESCE(SUM(l.amount_nanos), 0) FROM ledger l WHERE l.address = principals.address AND l.kind = 'grant'),
  spend_nanos   = (SELECT COALESCE(-SUM(l.amount_nanos), 0) FROM ledger l WHERE l.address = principals.address AND l.kind = 'charge');

-- 4. 顺手收掉签名 nonce 的存量：重放防护只需要覆盖时间窗（±120s），
--    一小时以前的 nonce 不会再被任何合法请求用到。
DELETE FROM nonces WHERE seen_at < CAST(strftime('%s', 'now') AS INTEGER) - 3600;
