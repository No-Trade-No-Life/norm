# 动态 Gas、资源成本与定价原则

本文只写**单价与用量结构**，不写任何一次真实账单。表里每个 Cloudflare 侧的数字都是**列表价**——
谁都能去 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 与
[Observability 定价](https://developers.cloudflare.com/observability/pricing/) 逐项核对，
再按 `src/gas.ts` 的操作码单价表把「一次推理请求」自己算一遍。

钱的单位一律是**纳美元**（nanodollar，$0.000000001，即十亿分之一美元）：一笔云端成本只有几纳
到几千纳美元，换成「分」会四舍五入成 0。换算是十进制：1,000 纳 = $0.000001，
1,000,000 纳 = $0.001，1,000,000,000 纳 = $1。

## 动态 Gas 机制（`src/gas.ts`）

Norm 不再收取固定的 300 纳「入场费」，而是像 EVM 一样在请求内维护一个纯内存 `GasMeter`：**从 300 纳（Worker 调用）起步，每经过一个真实产生费用的付费点就按列表价累加**，结算前调用 `finalizeForSettlement()` 冻结。

四条硬约束同时落进代码：

1. **不允许计费后再事后获取计费信息**：`finalizeForSettlement()` 在 `settle()` 前冻结计量器，之后任何 `charge()` 直接抛错。
2. **不允许少收漏收**：Worker 调用、Workers Logs、CPU 保守估、D1 读上界与每次实际发生的 D1 行写（表行 + 受影响二级索引）全部按列表价入账。
3. **余额不足提前中止以省费**：入口安全余额阈值 `MIN_BALANCE_NANOS = 10,000`（$0.00001），低于该值直接 402 拒绝（**0 次 D1 写、0 次上游请求**）；写亲和前、发往上游前与纠偏重试前同样用内存余额快照做预算熔断。
4. **零计费 Overhead**：纯内存整数累加，不发起任何额外的 D1 或网络调用；反而通过 `consumers JOIN principals` 合并鉴权与余额读、延后 `consumers.last_used_at` 写库，比改前净省 1 次 D1 读往返和所有拒单请求的 D1 写。

### 付费点价目表（`GAS_SCHEDULE` & `D1_ROW_WRITES`）

当前 `GAS_MARGIN_BPS = 0`（**1.0× 纯成本价，维持不亏本**），完整明细同步公开在 `GET /api/v1/pricing`：

| 阶段 | 付费点 | Cloudflare 列表价 / 行写构成 | 单次累加（纳美元） |
|---|---|---|---:|
| **固有起步** | `worker_invocation` | Workers Paid $0.30 / 1M 次 | 300 |
| | `log_event` | Workers Logs（2026-12-01 体积口径，4.84 KB × 100% 采样） | 1,320 |
| | `cpu_base` | 基础 CPU 保守估（≈ 5 CPU-ms × $0.02 / 1M CPU-ms） | 100 |
| | `d1_reads` | D1 行读保守上界（$0.001 / 1M 行，10 纳覆盖 10,000 行读） | 10 |
| **执行路径** | `consumer_touch` | `UPDATE consumers SET last_used_at`（非索引列，1 行写） | +1,000 |
| | `affinity_write` | 首次/过期 `UPSERT affinities`（表 1 + PK 1 + 索引 1 = 3 行写；命中 +0） | +3,000 |
| | `affinity_gc` | 顺手清理过期亲和（`LIMIT 2`，读 `batch[0].meta.changes`，每行 3 写） | +changes × 3,000 |
| | `cpu_bridge` | 跨方言协议与工具调用桥接 CPU（≈ +5 CPU-ms；直通 +0） | +100 |
| | `cpu_stream` | 流式 SSE 拆帧与用量嗅探 CPU（≈ +3 CPU-ms；非流式 +0） | +60 |
| **纠偏重试** | `retry_drop_model` | `isModelNotServed` 删 `provider_models`（表 + PK + 索引 = 3 行写） | +changes × 3,000 |
| | `retry_forget_affinity` | 忘掉错误会话粘性 `DELETE affinities`（表 + PK + 索引 = 3 行写） | +changes × 3,000 |
| | `retry_attempt` | 二次候选转发基础 CPU | +100 |
| **结算入账** | `settle` | `UPDATE principals`（1 行）+ `INSERT requests`（表 1 + PK 1 + 索引 1 = 3 行）= 4 行写 | +4,000 |

### 典型请求总 Gas 一览

| 路径 | 累加项 | 总 Gas（纳美元） | 折合美元 |
|---|---|---:|---:|
| 同方言直通 · 非流式（稳态） | `1,730 + 1,000 + 4,000` | **6,730** | $0.00000673 |
| 同方言直通 · 流式（稳态） | `6,730 + 60` | **6,790** | $0.00000679 |
| 跨方言桥接 · 非流式（稳态） | `6,730 + 100` | **6,830** | $0.00000683 |
| 跨方言桥接 · 流式（稳态） | `6,730 + 100 + 60` | **6,890** | $0.00000689 |
| 跨方言桥接 · 流式 + 首次写亲和 | `6,890 + 3,000` | **9,890** | $0.00000989 |

默认入口安全阈值 `MIN_BALANCE_NANOS = 10,000` 刚好覆盖「跨方言 + 流式 + 首次写亲和」的完整单次路径（9,890 纳）；$1.00 演示授信仍可发起约 **14.8 万次** 普通推理调用。

## Workers Logs 建模说明

`wrangler.jsonc` 目前配置 `observability: { enabled: true }`（100% 采样、每次调用一条 invocation log）。
按 Cloudflare 公布的 4.84 KB 平均事件体积建模：

| 口径 | 规则 | 纳美元 / 事件 |
|---|---|---:|
| 2026-11-30 前 | 20M 事件/月含在 Workers Paid，超额 $0.60/百万事件 | **600** |
| 2026-12-01 起 | 50 GB 摄取 + 10 GB-月存储内含，超额 $0.25/GB 摄取 + $0.10/GB-月存储 | **≈ 1,320** |

1,320 是两笔：摄取 4.84 KB ≈ **1,210 纳**，7 天保留存储 4.84 KB × $0.10/GB-月 × 7/30 ≈ **113 纳**。
动态 Gas 直接采用较高的 2026-12-01 口径（`1,320` 纳），保证切换后也不漏收。后续在 `wrangler.jsonc` 调低 `head_sampling_rate` 或关闭 `invocation_logs` 时，同步调低 `src/gas.ts` 里的 `log_event` 常量，用户的 Gas 会自动下降。

## 额度：账号级共享与见底顺序

Workers Paid 是 $5/月，额度**账号级共享**（同一账号下所有 Worker 一起吃）：1000 万请求 /
3000 万 CPU-ms / 5000 万 D1 行写 / 5 GB；超出部分 $0.30/百万次、$0.02/百万 CPU-ms、
$1.00/百万行、$0.75/GB-月。日志额度同样账号级共享。

- **见底顺序**：**CPU 最先**（3000 万 CPU-ms ÷ 3.46 ms ≈ 870 万次调用），然后是日志存储
  （≈ 43 GB 摄取 ≈ 890 万事件）、请求（1000 万次）与 D1 行写（5000 万 ÷ 5 ≈ 1000 万次推理），
  最后是日志摄取（50 GB ≈ 1,030 万事件）。
- 因为动态 Gas 已按 1.0× 列表边际成本计费，**无论在额度内还是越过额度，都不会出现单笔倒挂**。

## 已经做过的降本与下一步空间

- **#49 签名鉴权不再写库**：重放防护改为时间窗 + 幂等键，管理面读请求的 D1 写入 2 → **0**，删掉 `nonces` 表。
- **#50 `requests` 砍掉 4 条冗余索引**：每条请求记录的 D1 写入从 **7 行降到 3 行**；`/stats` 改成 `SUM(spend_nanos)` + 边缘缓存。
- **鉴权合并 JOIN + 延后 `last_used_at`**：`consumers JOIN principals` 合并掉 `findPrincipal` 读，所有 400 / 402 / 404 拒单请求 0 次 D1 写。

下一步可选降本（落地后动态 Gas 自动同步下降）：

- 对 `consumers.last_used_at` 做时间窗口写节流，跳过写时自动省 `1,000` 纳/请求；
- 调低 `wrangler.jsonc` 日志采样率（如 `0.1`），`log_event` 同步降至 `132` 纳；
- 把逐请求审计明细搬到 Workers Analytics Engine（250 纳/点），D1 只留 `principals` 余额 1 行。

## 定价原则

> 原则上 Norm 只赚取合理的毛利率，会在技术手段上最小化用户的使用成本，但绝对不会做贴钱留用户的不可持续的事情。

1. **当前 1.0× 成本价，只维持不亏本**：`GAS_MARGIN_BPS = 0`，所有单价写在 `src/gas.ts` 与 `src/pricing.ts` 里，随构建哈希公开，改价 = 一次可审查的代码提交。
2. **工程降本直接反哺用户**：付费点与真实资源一一对应，省掉一条索引、一次写库或一笔日志采样，用户 Gas 自动下降。
3. **不贴钱留客**：边际成本全额覆盖，余额低于安全阈值提前 402 熔断，靠可持续的工程能力而非补贴运行。
