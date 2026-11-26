-- 一次推理请求插一条 requests 记录，D1 按行计费，而每条二级索引也要多写一行：
-- 原来 1 行表 + 6 条索引（主键 + 5 条显式）＝ 7 行；只留 (address, id DESC) 后是 3 行。
--
-- 为什么 (address, id DESC) 一条就够：
--   id 是 UUID v7（src/ids.ts），前 48 位是毫秒时间戳，字典序即时间序；按时间倒序
--   翻页（/api/v1/account/usage 的 keyset）本来就只认这一条。
--   requests_address_created 的 created_at 是秒级、粒度更粗，纯冗余。
--
-- 为什么 provider_user / consumer_user 两条可以直接删：全仓库没有任何一处用它们
-- 过滤或排序。0015 里是预留，接口最后接上的是 by-consumer_id 与 by-provider_id 聚合，
-- 而这两个聚合先按 address 收窄再 GROUP BY，走 (address, id DESC) 即可，
-- (consumer_id, id DESC) 也帮不上忙。将来真按消费者过滤时，再随那一次改动建索引。
--
-- 删索引本身也按行计费，但这是一次性的；换掉的是每条请求都省的 4 行写。
DROP INDEX IF EXISTS requests_address_created;
DROP INDEX IF EXISTS requests_consumer;
DROP INDEX IF EXISTS requests_provider_user;
DROP INDEX IF EXISTS requests_consumer_user;
