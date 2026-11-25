-- 下游消费者在创建时就绑定唯一的上游提供者。
--
-- 之前的调用方式要客户端在 `Authorization: Bearer sk-norm-…` 之外再带一个
-- `X-Norm-Credential` 才能说清「钱付给哪个上游」——那等于把两个身份、两个配置项
-- 塞进每一次调用里。实际上绑定关系只在建钥时决定一次，之后不该再出现在请求里。
--
-- 于是：Token 说明「我是谁」+「我走哪条上游」，一条 Bearer 就是一个完整调用。
-- 签名身份（Ed25519）仍然在头里指名上游——它管的是资源，不是消费。
--
-- 旧的消费者密钥没有绑定，也无法替它们猜一个上游，全部作废；重新添加会带上绑定。
ALTER TABLE consumers ADD COLUMN credential_id TEXT;
CREATE INDEX consumers_credential ON consumers(credential_id);

UPDATE consumers SET revoked_at = CAST(strftime('%s','now') AS INTEGER)
WHERE revoked_at IS NULL;
