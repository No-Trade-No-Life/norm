-- 公共池与亲和：Norm 第一次开始自己挑上游。
--
-- 在此之前，一条请求用哪条上游由请求头决定（X-Norm-Provider），没带头就要求账户里
-- 恰好只有一条启用中的上游——选择权在调用方，Norm 只负责执行。那个头现在删掉了：
-- 客户端要多填一个参数才能用，而「多填一个参数」正是下游不肯采纳的那部分。
--
-- 选择权回到 Norm 之后，规则压到两条：
--
--   scope = 'pool'   站点持有的上游，所有账户都能用，只在自己的上游不可用时兜底
--   affinities       会话（thread-id / session-id）到某条上游的绑定，带过期时间
--
-- 为什么粘性要一张表、而不是纯哈希：候选集是会变的（上游被禁用、被撤销、池子进出），
-- 纯哈希会随着候选集变化把会话整批搬到另一台上；有表就能钉住一条，直到它真的不可用。
ALTER TABLE providers ADD COLUMN scope TEXT NOT NULL DEFAULT 'private';

-- 池子是按 scope 全库扫的读：没有索引时每次转发都要扫一遍全部上游。
CREATE INDEX IF NOT EXISTS providers_scope ON providers(scope, created_at DESC);

CREATE TABLE IF NOT EXISTS affinities (
  -- 键是 sha256(address | key)：按账户隔离，两个用户撞同一个 session-id 也不会互相粘。
  affinity_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 写亲和时顺手清掉这个账户的过期行：索引让那条 DELETE 只碰自己的行。
CREATE INDEX IF NOT EXISTS affinities_address ON affinities(address, expires_at);
