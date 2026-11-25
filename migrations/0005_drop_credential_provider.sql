-- provider 只是一个自己填、自己看的品牌标签：既不做转换判断，也不是信任依据，
-- 真正决定行为的是 base_url（打到哪）与 upstream_protocol（说什么方言）。
-- 名字由 label 承担，所以这一列退化成第二份冗余文案，删掉。
ALTER TABLE credentials DROP COLUMN provider;
