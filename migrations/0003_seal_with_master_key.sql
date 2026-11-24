-- 上游密钥的封装从「用户口令派生（PBKDF2）」改为「Worker secret 里的高熵对称密钥（AES-256-GCM）」。
-- 旧密文只能用旧口令解开，而口令从来没有上传过——它们无法被迁移，只能作废。
-- 演示库里本来就只有测试数据，直接撤销比留一批解不开的行更诚实。
UPDATE credentials SET revoked_at = CAST(strftime('%s','now') AS INTEGER)
WHERE kdf = 'pbkdf2-sha256-600000+xchacha20poly1305';
