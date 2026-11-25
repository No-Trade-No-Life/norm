-- 账本按 Token 走：输入 / 缓存命中 / 输出 分开记，外加一笔 Norm 服务费。
--
-- 原来的计价只有「每请求 500 微美元」一项，与这次调用真正花了多少 token 无关。
-- 现在一次调用的钱由两部分组成：
--   token_micros        三项 token 按价目表折出来的钱（价目表在 src/pricing.ts，随代码发布）
--   service_fee_micros  一次性的服务费，来源是 Cloudflare 侧的均摊成本，与 token 无关
-- fee_micros 仍然是两者的和，也是真正从余额里扣掉的那个数——三个数可以互相核对。
--
-- 同时把「这次调用打给谁、由谁发起」记成事实：
--   base_url     上游真正被打到的那台机器的地址（转发时只用提供者里钉死的这一个）
--   provider_id  上游提供者
--   consumer_id  下游消费者密钥；用签名直连时为空——那是人，不是一把程序凭据
-- 这三项都只记 id 与地址，不含任何请求内容：ZDR 不变。

-- 表名与代码里的概念对齐（「凭证」在 UI 上早已叫「上游提供者」）。
ALTER TABLE credentials RENAME TO providers;
ALTER TABLE consumers RENAME COLUMN credential_id TO provider_id;

-- 三列 token，与上游的原始口径分开记：input 含缓存命中，cached 是其中命中的那部分。
ALTER TABLE requests RENAME COLUMN prompt_tokens TO input_tokens;
ALTER TABLE requests RENAME COLUMN completion_tokens TO output_tokens;
ALTER TABLE requests ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests RENAME COLUMN credential_id TO provider_id;

-- 费用构成与调用事实。
ALTER TABLE requests ADD COLUMN service_fee_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN token_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN consumer_id TEXT;

-- 旧行没有 base_url：从提供者回填，能回填的都回填，回填不到的留空字符串（历史事实不可伪造）。
UPDATE requests
SET base_url = COALESCE((SELECT base_url FROM providers WHERE providers.id = requests.provider_id), '')
WHERE base_url = '';

-- 按时间翻页走主键：request_id 是 UUID v7，字典序即时间序。
CREATE INDEX IF NOT EXISTS requests_address_id ON requests(address, id DESC);
-- 下游消费者维度的聚合（哪把钥匙花了多少钱）。
CREATE INDEX IF NOT EXISTS requests_consumer ON requests(consumer_id, id DESC);

-- 余额不够付 token 那一部分时，这笔记账诚实记下差多少：服务费照收（隔离执行发生了），
-- token 的钱由站点承担。恒等式：fee_micros = service_fee_micros + token_micros - unbilled_micros。
ALTER TABLE requests ADD COLUMN unbilled_micros INTEGER NOT NULL DEFAULT 0;
