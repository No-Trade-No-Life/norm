-- 钱的精度从微美元改成纳美元：一次调用可能只值几十纳美元。
--
-- 微美元（1e-6）对便宜的模型太粗：$0.05/M 的缓存 token，40 个只值 2 微美元，
-- 而更小的输入会在四舍五入里变成 0——账本上「有调用、没钱」，比算错还难查。
-- 纳美元（1e-9）把最小可记单位压到十亿分之一美元，同时仍然用整数存：
-- 浮点存钱迟早会在某一次求和里差一分钱。
--
-- 存量数据按 ×1000 平移，数值大小不变（旧 100 微美元 = 新 100000 纳美元）。
-- 改名与缩放分成两句写，是为了让「列叫什么」与「值是什么单位」各读一次就懂。

ALTER TABLE principals RENAME COLUMN balance_micros TO balance_nanos;
ALTER TABLE principals RENAME COLUMN granted_micros TO granted_nanos;
ALTER TABLE principals RENAME COLUMN spend_micros TO spend_nanos;

ALTER TABLE ledger RENAME COLUMN amount_micros TO amount_nanos;
ALTER TABLE ledger RENAME COLUMN balance_after_micros TO balance_after_nanos;

ALTER TABLE requests RENAME COLUMN service_fee_micros TO service_fee_nanos;
ALTER TABLE requests RENAME COLUMN token_micros TO token_nanos;
ALTER TABLE requests RENAME COLUMN fee_micros TO fee_nanos;
ALTER TABLE requests RENAME COLUMN unbilled_micros TO unbilled_nanos;

UPDATE principals SET balance_nanos = balance_nanos * 1000,
                      granted_nanos = granted_nanos * 1000,
                      spend_nanos = spend_nanos * 1000;
UPDATE ledger SET amount_nanos = amount_nanos * 1000,
                  balance_after_nanos = balance_after_nanos * 1000;
UPDATE requests SET service_fee_nanos = service_fee_nanos * 1000,
                    token_nanos = token_nanos * 1000,
                    fee_nanos = fee_nanos * 1000,
                    unbilled_nanos = unbilled_nanos * 1000;
