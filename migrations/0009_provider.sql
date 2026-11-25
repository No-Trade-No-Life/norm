-- 「上游提供商」这个概念彻底改名为 provider。
--
-- 此前同一个东西有三套叫法：表叫 credentials、UI 叫「上游提供者」、列带 upstream_ 前缀。
-- 三套名字描述的是同一件事——一条「打到某台主机、说某种协议、带一把密钥」的记录——
-- 互相之间没有一处是准确的区分，只有读代码的人要在脑子里做一次翻译。这里统一成 provider。
--
-- 具体动作：
--   credentials            → providers
--   upstream_protocol      → protocol       （provider 自己的属性，不需要 upstream 前缀）
--   upstream_visibility    → visibility
--   requests.credential_id → provider_id
--   requests.status 里的 'upstream_error' → 'provider_error'
--   索引一并改名，否则会留下 credentials_* 的名字。
--
-- 两件**刻意不动**的事：
--   1. 历史迁移（0001–0008）原样保留。它们是「某个时刻执行过什么」的记录，改了内容
--      就等于伪造历史；新建库会先建 credentials、由 0008 往 requests 里写 credential_id，
--      再由这一条统一改名，终态一致。
--   2. 已存在的行 id 仍是 `cred_…` 前缀。id 参与密钥封装的 AAD（见 src/seal.ts：
--      `address|providerId`），改 id 会让库里所有密文永久解不开。新记录用 `prv_…`。
ALTER TABLE credentials RENAME TO providers;
ALTER TABLE providers RENAME COLUMN upstream_protocol TO protocol;
ALTER TABLE providers RENAME COLUMN upstream_visibility TO visibility;

DROP INDEX IF EXISTS credentials_address;
DROP INDEX IF EXISTS credentials_base_url;
CREATE INDEX IF NOT EXISTS providers_address ON providers(address, created_at DESC);
CREATE INDEX IF NOT EXISTS providers_base_url ON providers(base_url);

ALTER TABLE requests RENAME COLUMN credential_id TO provider_id;
UPDATE requests SET status = 'provider_error' WHERE status = 'upstream_error';
