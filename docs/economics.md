# 动态 Gas、资源成本与定价原则

本文只写**单价与用量结构**，不写任何一次真实账单。表里每个 Cloudflare 侧的数字都是**列表价**——
谁都能去 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 与
[Observability 定价](https://developers.cloudflare.com/observability/pricing/) 逐项核对，
再按 `src/gas.ts` 的操作码单价表把「一次推理请求」自己算一遍。

钱的单位一律是**纳美元**（nanodollar，$0.000000001，即十亿分之一美元）：一笔云端成本只有几纳
到几千纳美元，换成「分」会四舍五入成 0。换算是十进制：1,000 纳 = $0.000001，
1,000,000 纳 = $0.001，1,000,000,000 纳 = $1。

## 动态 Gas 机制（`src/gas.ts`）

Norm 在每次推理请求内维护一个纯内存 `GasMeter`：**从 300 纳（Worker 调用）起步，每经过一个真实产生费用的付费点就按列表价累加**，结算前调用 `finalizeForSettlement()` 冻结。

四条硬约束同时落进代码：

1. **不允许计费后再事后获取计费信息**：`finalizeForSettlement()` 在 `settle()` 前冻结计量器，之后任何 `charge()` 直接抛错。
2. **不允许少收漏收**：Worker 调用、异常日志摊销、CPU 保守估、D1 读上界与每次实际发生的 D1 行写（含所有受影响二级索引）全部按列表价入账。
3. **余额不足提前中止以省费**：入口安全余额阈值 `MIN_BALANCE_NANOS = 10,000`（$0.00001），低于该值直接 402 拒绝（**0 次 D1 写、0 次上游请求**）；写亲和前、发往上游前与纠偏重试前同样用内存余额快照做预算熔断。
4. **零计费 Overhead**：纯内存整数累加，不发起任何额外的 D1 或网络调用；通过 `consumers JOIN principals` 合并鉴权与余额读、按 UTC 自然日节流 `consumers.last_used_at`、`WITHOUT ROWID` 聚簇表消除冗余索引写入，把工程降本直接变成更低的 Gas。

### 付费点价目表（`GAS_SCHEDULE` & `D1_ROW_WRITES`）

当前 `GAS_MARGIN_BPS = 0`（**1.0× 纯成本价，维持不亏本**），完整明细同步公开在 `GET /api/v1/pricing`：

| 阶段 | 付费点 | Cloudflare 列表价 / 行写构成 | 单次累加（纳美元） |
|---|---|---|---:|
| **固有起步** | `worker_invocation` | Workers Paid $0.30 / 1M 次 | 300 |
| | `log_event` | 已关闭 `invocation_logs`（只留 `console.error` 异常日志），留 10 纳作偶发错误日志摊销 | 10 |
| | `cpu_base` | 基础 CPU 保守估（≈ 5 CPU-ms × $0.02 / 1M CPU-ms） | 100 |
| | `d1_reads` | D1 行读保守上界（$0.001 / 1M 行，10 纳覆盖 10,000 行读） | 10 |
| | `read_subsidy` | 免费只读操作公共摊销（`R × C_read`，冷启动期先置 0，按线上实际读写比校准） | 0 |
| **执行路径** | `consumer_touch` | `UPDATE consumers SET last_used_at`（非索引列，按 UTC 自然日节流：当日首次 1 行，同日后续 +0） | +0 或 +1,000 |
| | `affinity_write` | 首次/过期 `UPSERT affinities`（`WITHOUT ROWID`，0 二级索引 = 1 行写；7 天内命中 +0） | +0 或 +1,000 |
| | `cpu_bridge` | 跨方言协议与工具调用桥接 CPU（≈ +5 CPU-ms；直通 +0） | +100 |
| | `cpu_stream` | 流式 SSE 拆帧与用量嗅探 CPU（≈ +3 CPU-ms；非流式 +0） | +60 |
| **纠偏重试** | `retry_drop_model` | `isModelNotServed` 删 `provider_models`（表 + PK + 索引 = 3 行写） | +changes × 3,000 |
| | `retry_forget_affinity` | 忘掉错误会话粘性 `DELETE affinities`（`WITHOUT ROWID` = 1 行写） | +changes × 1,000 |
| | `retry_attempt` | 二次候选转发基础 CPU | +100 |
| **结算入账** | `settle` | `UPDATE principals`（消费方，1 行）+ `INSERT requests`（`WITHOUT ROWID`，0 二级索引 = 1 行）= 2 行写 | +2,000 |
| | `token_transfer` | 跨用户/公共池 Token 价值转移时额外 `UPDATE principals`（上游提供方 `earn_nanos`，1 行）；自有上游或失败 +0 | +0 或 +1,000 |

### 典型请求总 Gas 一览

| 路径 | 累加项 | 总 Gas（纳美元） | 折合美元 |
|---|---|---:|---:|
| 自有上游 · 同方言直通 · 非流式（同日稳态） | `420 + 2,000` | **2,420** | $0.00000242 |
| 自有上游 · 同方言直通 · 流式（同日稳态） | `2,420 + 60` | **2,480** | $0.00000248 |
| 自有上游 · 跨方言桥接 · 非流式（同日稳态） | `2,420 + 100` | **2,520** | $0.00000252 |
| 自有上游 · 跨方言桥接 · 流式（同日稳态） | `2,420 + 100 + 60` | **2,580** | $0.00000258 |
| 公共池/他人上游 · 同方言直通 · 非流式（同日稳态，含 Token 转账） | `2,420 + 1,000` | **3,420** | $0.00000342 |
| 跨方言桥接 · 流式 + 当日首次 + 新会话写亲和（自有上游） | `2,580 + 1,000 + 1,000` | **4,580** | $0.00000458 |

> **Gas 与 Token 价值分离**：Norm 只收取上述 Gas 费；调用自有上游时 `token_nanos = 0`（不收 Token 费）；调用他人/公共池上游时，Token 费直接从调用方转入上游提供方的 `earn_nanos`（价值转移，Norm 0 抽成）。

默认入口安全阈值 `MIN_BALANCE_NANOS = 10,000` 余裕覆盖完整路径乃至偶发的模型纠偏重试（最高 8,680 纳）；$1.00 演示授信可发起约 **41 万次** 稳态推理调用。

## 只读操作零写库与读写交叉补贴原则

Norm **不给任何只读操作单独计费**，原因同时落在工程与经济两面：

1. **忌讳「读导致写」**：在 Cloudflare D1 上，1 行读仅 0.001 纳美元，而为读操作记一笔账至少需要 2 行写（**2,000 纳美元**）——计量成本是业务成本的上万倍。同时 SQLite / D1 是单写者模型，读触发写会破坏 GET 幂等性、制造 `principals` 热点行锁竞争，并放大滥用杠杆。
2. **全站纯读零写库与免费直出落地**：
   - 静态资源（HTML / JS / CSS / SVG）：`wrangler.jsonc` 配置 `"run_worker_first": ["/api/*", "/v1/*"]`，由 Cloudflare 边缘免费直出（**0 Worker 调用、0 日志**）；
   - 管理面读鉴权（`GET /api/v1/*`）不写去重表（#49）；
   - 模型总表刷新（`GET /api/v1/models`）改为集合 diff 更新 `provider_models`，清单未变时 **0 行写**；
   - 转发面模型清单（`GET /v1/models`、`GET /v1/models/:model`）走 `resolveProvider(..., { readOnly: true })` 且不更新 `consumers.last_used_at`，严格 **0 次 D1 写**；
   - 公开只读接口按属性加缓存（`/api/v1/stats` 60s 边缘缓存，`/api/v1/pricing` 与 `/api/v1/protocols` 300s 缓存，`/api/v1/base-urls` 60s 缓存；`/api/v1/attestation` 保持 `no-store`）。
3. **写全体补贴读全体**：关闭 `invocation_logs` 后，未命中缓存的免费读请求单次基础设施成本已从 1,670 纳压降至约 **360 纳**（Worker 300 + CPU ~50 + 异常日志摊销 10）。这笔公共读成本原则上由**计费的写/推理操作全体按实际读写比交叉补贴**：

```
单次推理需分摊的 read_subsidy = R × C_read
  其中 R = 未缓存的免费读请求数 ÷ 计费推理请求数，C_read ≈ 360 纳
```

- API 自动化为主（如 `R = 0.2`）：每次推理仅需摊约 **72 纳**（约占稳态 Gas 的 3%）；
- Web 控制台与 API 1:1（`R = 1.0`）：每次推理约摊 **360 纳**（约占稳态 Gas 的 15%）。

`src/gas.ts` 已为这项摊销预留公开槽位 `GAS_SCHEDULE.read_subsidy`（当前冷启动期置 `0`），后续依据 Cloudflare 实际总请求数与 `requests` 总行数的比值定期校准，改值 = 一次公开可审查的代码提交。

## Workers Logs 策略

`wrangler.jsonc` 配置为：

```jsonc
"observability": {
  "logs": { "enabled": true, "invocation_logs": false }
}
```

- **正常请求不生成 4.84 KB invocation log**（省掉 2026-12-01 体积口径下 1,320 纳/次的日志税），正常推理的完整审计事实已落在 D1 `requests` 表中；
- **应用日志（`console.error` 与异常堆栈）100% 保留**，不影响 500 故障排查；临时查看线上实时请求流可使用免费的 `wrangler tail`。

## 已经做过的降本记录

- **#49 签名鉴权不再写库**：管理面读请求 D1 写入 2 → **0**，删除 `nonces` 表。
- **#50 `requests` 砍掉 4 条冗余索引**：单条请求写入 7 → **3 行**；`/stats` 改成 `SUM(spend_nanos)` + 边缘缓存。
- **动态 Gas + 鉴权合并 JOIN（#53）**：`consumers JOIN principals` 合并读、拒单 0 写库、三级余额提前熔断。
- **纯读零写库 + 公开读缓存（#54）**：`GET /v1/models` 彻底 0 写库，公开只读端点补齐 `Cache-Control`。
- **成本结构全面清理（本版）**：
  - `run_worker_first` 收窄为 `["/api/*", "/v1/*"]`（静态资源免费直出）；
  - 关闭 `invocation_logs`（单次推理省 1,310 纳，免费读成本 1,670 → 360 纳）；
  - `consumers.last_used_at` 按 UTC 自然日节流（每把钥匙每天最多 1 行写，稳态省 1,000 纳/次）；
  - `recordProviderModels` 改集合 diff（清单未变 0 行写）；
  - 迁移 `0022`：`requests` 与 `affinities` 重建为 `WITHOUT ROWID` 聚簇表、0 二级索引（`INSERT requests` 3 → **1 行**，`UPSERT affinities` 3 → **1 行** 且取消顺手 GC），稳态直通 Gas 从 **6,730 → 2,420 纳（-64%）**。

## 定价原则

> 原则上 Norm 只赚取合理的毛利率，会在技术手段上最小化用户的使用成本，但绝对不会做贴钱留用户的不可持续的事情。

1. **当前 1.0× 成本价，只维持不亏本**：`GAS_MARGIN_BPS = 0`，所有单价写在 `src/gas.ts` 与 `src/pricing.ts` 里，随构建哈希公开，改价 = 一次可审查的代码提交。
2. **工程降本直接反哺用户**：付费点与真实资源一一对应，省掉一条索引、一次写库或一项日志，用户 Gas 自动下降。
3. **不贴钱留客**：边际成本全额覆盖，余额低于安全阈值提前 402 熔断，靠可持续的工程能力而非补贴运行。
