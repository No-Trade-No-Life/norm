-- 请求的账搬回请求表：每条请求自己带着「这一笔之前 / 之后」的累计消费，
-- 于是账本不必再为每一次调用记一行 charge —— 那本来就是把请求表的一行抄成两行，
-- 抄错了还要靠对账去发现。请求表是消费的唯一事实，账本只记账户级的钱：
-- 券、充值、提现。
--
-- 新的恒等式：
--
--   可用余额 = Σ 账本(券 + 充值 − 提现) − 累计消费
--   累计消费 = Σ 请求(fee_nanos) = 最后一条请求的 spend_after_nanos

ALTER TABLE requests ADD COLUMN spend_before_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN spend_after_nanos INTEGER NOT NULL DEFAULT 0;

-- 回填：按调用发生的顺序滚动求和。id 是 UUID v7，同秒内也能定序；
-- created_at 先排是为了让历史行与当时的写入顺序一致。
WITH running AS (
  SELECT id,
         COALESCE(SUM(fee_nanos) OVER (
           PARTITION BY address ORDER BY created_at, id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_nanos,
         SUM(fee_nanos) OVER (
           PARTITION BY address ORDER BY created_at, id) AS after_nanos
  FROM requests
)
UPDATE requests
SET spend_before_nanos = (SELECT before_nanos FROM running WHERE running.id = requests.id),
    spend_after_nanos  = (SELECT after_nanos  FROM running WHERE running.id = requests.id);

-- 累计消费以请求为准重算一次：两者本来就该相等，真有分叉就趁这次抹平。
UPDATE principals
SET spend_nanos = COALESCE(
  (SELECT SUM(fee_nanos) FROM requests WHERE requests.address = principals.address), 0);

-- 重建账本：charge 归请求表，历史 charge 行随之删掉（fee_nanos 仍在请求里，不丢信息）；
-- request_id 列从此永远为空，一并去掉。SQLite 改不了 CHECK 约束，只能重建表。
CREATE TABLE ledger_new (
  id                    TEXT PRIMARY KEY,
  address               TEXT NOT NULL REFERENCES principals(address) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('voucher', 'recharge', 'withdraw')),
  amount_nanos          INTEGER NOT NULL,
  available_after_nanos INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

INSERT INTO ledger_new (id, address, kind, amount_nanos, available_after_nanos, created_at)
SELECT id, address, kind, amount_nanos, available_after_nanos, created_at
FROM ledger WHERE kind <> 'charge';

DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ledger_address_created ON ledger(address, created_at DESC);
