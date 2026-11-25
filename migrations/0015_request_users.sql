-- 请求审计要能回答「这条钱进了谁的口袋、又是谁花的」——记的是地址，不是 id。
--
-- provider_id / consumer_id 只在本库里唯一，把数据搬到别处（对账、导出、给外部审计）
-- 就没有意义了；address 是 Ed25519 公钥，走到哪儿都能自证是哪个人。
--
-- 为什么两列都要有：公共池里的 provider 属于站点，调用方只是借用，所以
-- provider_user（收钱的那一方）与 address（花钱的那一方）本来就会不同。
ALTER TABLE requests ADD COLUMN provider_user TEXT;
ALTER TABLE requests ADD COLUMN consumer_user TEXT;

-- 存量行尽量回填：provider 的行还在就取它的持有者，consumer 同理；查不到就留 NULL
-- （那些行本来就没有这个事实，不编）。
UPDATE requests
SET provider_user = (SELECT address FROM providers WHERE providers.id = requests.provider_id)
WHERE provider_user IS NULL AND provider_id IS NOT NULL;

UPDATE requests
SET consumer_user = (SELECT address FROM consumers WHERE consumers.id = requests.consumer_id)
WHERE consumer_user IS NULL AND consumer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS requests_provider_user ON requests(provider_user, id DESC);
CREATE INDEX IF NOT EXISTS requests_consumer_user ON requests(consumer_user, id DESC);
