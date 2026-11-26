-- openai-oauth 的基址已经钉死在协议里（见 src/protocols.ts），行里再存一份就只是残留。
-- 线上真的出现过：一条上游的 base_url 被填成了代理地址（还带着 user:pass），结果是它既转发
-- 不到上游，又把凭据明文显示在列表与模型总表里——两件事都不该靠人去发现。
--
-- 只动还活着（未撤销）且与协议不一致的行：撤销的行是历史记录，改写它等于改写历史。
-- 幂等：已经是官方地址的行不会被写一次。
UPDATE providers
   SET base_url = 'https://chatgpt.com/backend-api/codex'
 WHERE protocol = 'openai-oauth'
   AND revoked_at IS NULL
   AND base_url <> 'https://chatgpt.com/backend-api/codex';
