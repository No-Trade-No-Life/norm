-- 每条上游可以单独挂一个 HTTP 代理（CONNECT 隧道）。
--
-- 它存在的理由只有一个：Worker 的 fetch 出站会被目标站按 cf-* 头判定成「非浏览器流量」而
-- 直接拒绝，隧道里的字节由代理重新发出，这些头就不存在了。它与「网络是否可达」无关。
--
-- 代理地址通常带着 user:pass，所以和上游密钥用同一套封装（AES-256-GCM，AAD = address|providerId）：
-- 库里只有密文。proxy_hint 只是为了在页面上认出「挂的是哪一条」，密码位置是 ***。
ALTER TABLE providers ADD COLUMN sealed_proxy TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN proxy_hint TEXT NOT NULL DEFAULT '';
