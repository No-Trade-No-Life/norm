-- 账本改成「四块只增的累计数」，余额是算出来的：
--
--   可用余额 = 累计充值 + 累计抵扣券 − 累计消费 − 累计提现
--
-- 为什么不再存一个 balance：存着的余额和流水迟早会分叉（一次失败的写、一次并发、
-- 一次手工修库），而分叉之后没人能说清哪个是对的。四块累计数各有各的方向，
-- 每笔只加到其中一块上，余额永远是这四块的一个算式——错不了，也不需要「对账」。
--
-- 抵扣券（演示授信就是一张券）不可提现：所以提现只能花充值那部分，
-- 代码里对 withdrawals 有约束；券只能拿来抵消费。

ALTER TABLE principals RENAME COLUMN granted_nanos TO voucher_nanos;
ALTER TABLE principals ADD COLUMN recharge_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principals ADD COLUMN withdraw_nanos INTEGER NOT NULL DEFAULT 0;

-- 现有余额恰好等于「券 − 消费」（这个站从未有过真实充值），所以删掉这一列
-- 不会改变任何人的可用余额。
ALTER TABLE principals DROP COLUMN balance_nanos;

-- 流水：四种变动各记各的。SQLite 改不了 CHECK 约束，只能重建表。
CREATE TABLE ledger_new (
  id                    TEXT PRIMARY KEY,
  address               TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  request_id            TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('voucher', 'recharge', 'withdraw', 'charge')),
  amount_nanos          INTEGER NOT NULL,
  available_after_nanos INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

INSERT INTO ledger_new (id, address, request_id, kind, amount_nanos, available_after_nanos, created_at)
SELECT id, address, request_id,
       CASE kind WHEN 'grant' THEN 'voucher' ELSE kind END,
       amount_nanos, balance_after_nanos, created_at
FROM ledger;

DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ledger_address_created ON ledger(address, created_at DESC);
