-- 冒烟测试留下的账户：只有这一个地址，providers 与 ledger 靠外键级联清空。
DELETE FROM requests WHERE address = ?;
DELETE FROM ledger WHERE address = ?;
DELETE FROM providers WHERE address = ?;
DELETE FROM principals WHERE address = ?;
