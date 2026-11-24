-- 上游渠道简化为四种协议；后端不做「官方/第三方」这类价值判断。
--   客户端一律说 OpenAI Chat（/v1/chat/completions）
--   上游可以是：openai-chat / openai-responses / anthropic-messages / google-gemini
-- 因此删掉 declared_source（自我声明）与 provenance（结论），只留事实。
ALTER TABLE credentials DROP COLUMN declared_source;
ALTER TABLE credentials DROP COLUMN provenance;
ALTER TABLE requests DROP COLUMN provenance;
ALTER TABLE credentials ADD COLUMN upstream_protocol TEXT NOT NULL DEFAULT 'openai-chat';
ALTER TABLE credentials ADD COLUMN upstream_visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS credentials_base_url ON credentials(base_url);
