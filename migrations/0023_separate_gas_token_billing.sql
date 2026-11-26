-- Gas 费与 Token 费分开结算，Token 费回归「用户间价值转移」：
--
--   1. Gas 费（gas_spend_nanos）：由 Norm 收取，覆盖 Cloudflare Worker / D1 / CPU 成本；
--      调用自有上游或他人上游、成功或失败都照收。
--   2. Token 费（token_spend_nanos / earn_nanos）：用户间价值转移。
--      - 调用自己的上游（provider_user = address）：自己给自己转账净额为 0，仅收 Gas，不收 Token 费；
--      - 调用公共池/他人上游（provider_user <> address）：从调用方扣 token_billed_nanos，
--        等额转入上游提供方的 earn_nanos，Norm 不截留任何 Token 费用。
--
-- 账户六块只增累计数：
--   可用余额 = 累计充值 + 累计抵扣券 + 累计上游收入 − 累计 Gas 支出 − 累计 Token 支出 − 累计提现
--   总消费   = 累计 Gas 支出 + 累计 Token 支出（不再冗余存 spend_nanos 列，防止分叉）

ALTER TABLE principals ADD COLUMN earn_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principals ADD COLUMN gas_spend_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principals ADD COLUMN token_spend_nanos INTEGER NOT NULL DEFAULT 0;

-- requests 维持 WITHOUT ROWID 聚簇表、0 条二级索引（不放大单次请求 D1 行写数）。
-- 新增四列：实扣 Gas、实转 Token，以及上游提供方在本次转账前后的累计收入链。
ALTER TABLE requests ADD COLUMN gas_billed_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN token_billed_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN earn_before_nanos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN earn_after_nanos INTEGER NOT NULL DEFAULT 0;

-- 历史请求按「先扣 Gas、余下扣 Token」回填拆分列，保证 gas_billed + token_billed = fee_nanos。
UPDATE requests
   SET gas_billed_nanos   = MIN(gas_fee_nanos, fee_nanos),
       token_billed_nanos = MAX(fee_nanos - MIN(gas_fee_nanos, fee_nanos), 0);

-- 回填历史跨用户调用的上游收入链（earn_before / earn_after）。
WITH earned_running AS (
  SELECT address, id,
         COALESCE(SUM(token_billed_nanos) OVER (
           PARTITION BY provider_user ORDER BY created_at, id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_nanos,
         SUM(token_billed_nanos) OVER (
           PARTITION BY provider_user ORDER BY created_at, id) AS after_nanos
    FROM requests
   WHERE provider_user IS NOT NULL
     AND provider_user <> address
     AND token_billed_nanos > 0
)
UPDATE requests
   SET earn_before_nanos = (
         SELECT before_nanos FROM earned_running
          WHERE earned_running.address = requests.address AND earned_running.id = requests.id
       ),
       earn_after_nanos = (
         SELECT after_nanos FROM earned_running
          WHERE earned_running.address = requests.address AND earned_running.id = requests.id
       )
 WHERE provider_user IS NOT NULL
   AND provider_user <> address
   AND token_billed_nanos > 0;

-- 按请求表回填账户三项新累计数：gas_spend + token_spend 严格等于旧 spend_nanos，
-- earn_nanos 严格等于该账户作为上游提供方服务他人收到的 token_billed_nanos 之和。
UPDATE principals
   SET gas_spend_nanos = COALESCE(
         (SELECT SUM(gas_billed_nanos) FROM requests WHERE requests.address = principals.address), 0),
       token_spend_nanos = COALESCE(
         (SELECT SUM(token_billed_nanos) FROM requests WHERE requests.address = principals.address), 0),
       earn_nanos = COALESCE(
         (SELECT SUM(token_billed_nanos) FROM requests
           WHERE requests.provider_user = principals.address
             AND requests.address <> principals.address), 0);

-- spend_nanos 现在是 gas_spend_nanos + token_spend_nanos 的派生量，删掉冗余列消除分叉可能。
ALTER TABLE principals DROP COLUMN spend_nanos;
