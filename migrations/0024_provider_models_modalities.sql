-- 上游自述的输入 / 输出模态：JSON 文本 `{"input":["text","image"],"output":["text"]}`。
--
-- 只有 OpenRouter 那一系（以及照抄它清单形状的聚合型上游）会带这个字段
-- （`architecture.input_modalities` / `output_modalities`）；OpenAI、Anthropic、
-- Google 的官方清单里没有。所以 NULL 是常态，含义是「这条上游没说」，
-- 而不是「只能文本」——读的人要分得清这两句话。
ALTER TABLE provider_models ADD COLUMN modalities TEXT;
