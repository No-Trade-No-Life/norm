-- 去掉管理面重放防御与幂等键机制：浏览器 ↔ Worker 全程走 TLS，签名时间窗（±60s）已覆盖新鲜度。
-- providers / consumers 不再维护 last_nonce 列。
ALTER TABLE providers DROP COLUMN last_nonce;
ALTER TABLE consumers DROP COLUMN last_nonce;
