-- 下游消费者回到「只记名字」：不绑定上游。
--
-- 上一版让每条 Token 在创建时绑死一条上游提供者，于是同一台机器上多开一个程序
-- 就要多建一条 Token、每换一次上游就要轮换一次密钥。实际上「走哪条上游」是转发时的
-- 决定，不是身份的一部分：调用不带 `X-Norm-Credential` 时就走账户里唯一的那条上游，
-- 有多条时才需要显式指名。名字与密钥只回答「谁的代码在敲这个门」。
--
-- 旧的绑定无处安放（旧 Token 的密钥明文从未离开过用户，我们无法替它们猜一个新契约），
-- 但绑定只是「默认值」，取消绑定后旧 Token 仍然可用：所以这里只丢列，不撤销。
DROP INDEX IF EXISTS consumers_credential;
ALTER TABLE consumers DROP COLUMN credential_id;
