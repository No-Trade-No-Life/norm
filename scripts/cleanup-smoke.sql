-- 冒烟测试留下的账户：只有这一个地址，credentials 与 ledger 靠外键级联清空。
DELETE FROM requests WHERE address = ?;
DELETE FROM ledger WHERE address = ?;
DELETE FROM credentials WHERE address = ?;
DELETE FROM nonces WHERE address = ?;
DELETE FROM principals WHERE address = ?;
