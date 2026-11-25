-- 上游提供商的模型清单：转发时按模型筛候选的那份事实。
--
-- 在此之前，选址只看「账户 + 会话」，模型名一个字都不参与（resolveProvider 的签名里
-- 没有 model）。于是任何名字都会落到候选里的某一条上——包括那一条根本没有的型号，
-- 下游拿到的是上游的 400 原话，看起来像「路由跑偏」，其实是「根本没有路由这回事」。
--
-- 这张表把「这条上游到底有哪些模型」变成可查询的事实。数据只有两个来源，都是上游
-- 自己的清单端点（GET /models，见 src/models.ts 的 probeProviderModels）：读取模型总表
-- 时，以及新增 / 编辑一条上游时。转发路径上不联网探测——那会把一次调用变成两次。
--
-- 「不知道」与「知道它没有」必须能分开，所以 providers 另有一列 models_fetched_at：
--   0      从没抓到过清单（新加的上游，或它的清单端点答不上话）→ 当作「还说不准」
--   > 0    那张清单的抓取时刻 → 这张表里没有的型号，就是它没有
-- 少了这一列，两种处境会被压成同一句「它没有这个模型」，而新加的上游会因为「表里
-- 还没行」被永久排除在选址之外。
ALTER TABLE providers ADD COLUMN models_fetched_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS provider_models (
  provider_id TEXT NOT NULL,
  model       TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model)
);

-- 转发路径上的读法：给定一个模型名，问「哪些上游有它」。
CREATE INDEX IF NOT EXISTS provider_models_model ON provider_models(model);
