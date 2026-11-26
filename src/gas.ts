/**
 * 动态 Gas 计费：从 300 纳美元（Worker 调用）起步，按请求实际经过的付费点逐项累加。
 *
 * 四条硬约束：
 *   1. 不允许在计费（结算）发生后再事后获取计费信息：`finalizeForSettlement()` 冻结计量器，
 *      之后任何 `charge()` 直接抛错；
 *   2. 不允许少收漏收：Worker 调用、Workers Logs、CPU 保守估算、D1 读上界、每一次实际发生的
 *      D1 行写（表行 + 所有受影响二级索引）全部按 Cloudflare 列表价入账；
 *   3. 余额不足提前中止：持有鉴权时顺手读出的可用余额快照，在入口（安全阈值）、写亲和前、
 *      发往上游前与重试前提前拦截，省掉多余的 D1 写与上游调用；
 *   4. 零计费 Overhead：纯内存整数累加，不发起任何额外的网络或 D1 调用。
 *
 * 与 `src/pricing.ts` 一样写在代码里（进入 `source_sha256` 构建哈希），改价 = 改代码 = 一次
 * 可被审查的合并，并在 `GET /api/v1/pricing` 完整公开。
 */

/** Cloudflare 列表价换算后的单价（整数纳美元）。 */
export const GAS_SCHEDULE = {
  /** Workers Paid：$0.30 / 1M 次调用。 */
  worker_invocation: 300,
  /**
   * Workers Logs（2026-12-01 体积口径，按 Cloudflare 公布的 4.84 KB 平均事件 × 100% 采样）：
   * 摄取 4.84 KB × $0.25/GB ≈ 1,210 纳 + 7 天存储 ≈ 113 纳 → 1,320 纳。
   * 调整 wrangler.jsonc 采样率或关闭 invocation_logs 时，随同一次提交同步更新此常量。
   */
  log_event: 1_320,
  /**
   * 基础 CPU 保守估（≈ 5 CPU-ms × $0.02 / 1M CPU-ms = 100 纳）：
   * 覆盖鉴权 SHA-256、JSON 解析、AES-GCM 解封、选址与结算拼装。
   * Workers 运行时不暴露精确 V8 CPU-ms，因此按执行路径保守定额，不拿含 I/O 的墙钟耗时冒充。
   */
  cpu_base: 100,
  /** 跨方言协议与工具调用桥接的额外 CPU（≈ +5 CPU-ms）。同方言直通不收。 */
  cpu_bridge: 100,
  /** 流式 SSE 逐帧拆包与用量嗅探的额外 CPU（≈ +3 CPU-ms）。非流式不收。 */
  cpu_stream: 60,
  /**
   * D1 行读保守上界（$0.001 / 1M 行读 = 0.001 纳/行）：
   * 单次推理实际读 20–50 行（≈ 0.05 纳），向上取 10 纳可覆盖 10,000 行读，保证永不漏收。
   */
  d1_reads: 10,
  /** D1 行写：$1.00 / 1M 行写（表行与每一条二级索引各计 1 行）。 */
  d1_row_write: 1_000,
} as const;

/**
 * 转发路径上每个 D1 写操作对应的「表行 + 受影响索引」行写数。
 *
 * 与 migrations/ 里的表结构和索引一一对应：每增删一条索引，都必须同步更新这里与单测。
 */
export const D1_ROW_WRITES = {
  /** UPDATE consumers SET last_used_at = ?（非索引列）：1 行。 */
  consumer_touch: 1,
  /** UPSERT affinities：表 1 + PK 1 + affinities_address 1 = 3 行。 */
  affinity_upsert: 3,
  /** DELETE affinities 每删 1 行：表 1 + PK 1 + affinities_address 1 = 3 行。 */
  affinity_delete: 3,
  /** DELETE provider_models 每删 1 行：表 1 + PK 1 + provider_models_model 1 = 3 行。 */
  provider_model_delete: 3,
  /**
   * 结算（settle）：UPDATE principals（spend_nanos 非索引，1 行）+
   * INSERT requests（表 1 + PK 1 + requests_address_id 1 = 3 行）= 4 行。
   * 乐观锁冲突时未命中的 UPDATE 变更 0 行，不会放大写入。
   */
  settle: 4,
} as const;

/**
 * 毛利率（基点，10,000 bps = 100%）。
 * 目前定为 0（即 1.0× 纯成本价，维持不亏本）；未来调整只需改这一行。
 */
export const GAS_MARGIN_BPS = 0;

/** 向上取整施加毛利倍数，绝不向下截断导致少收。 */
export function applyGasMargin(rawNanos: number, marginBps: number = GAS_MARGIN_BPS): number {
  if (marginBps <= 0) return rawNanos;
  return Math.ceil((rawNanos * (10_000 + marginBps)) / 10_000);
}

/** 请求刚进入 Worker 就已经发生的固有基础成本（300 + 1,320 + 100 + 10 = 1,730 纳）。 */
export const GAS_ENTRY_BASE_NANOS =
  GAS_SCHEDULE.worker_invocation +
  GAS_SCHEDULE.log_event +
  GAS_SCHEDULE.cpu_base +
  GAS_SCHEDULE.d1_reads;

/** 刷新消费者密钥最近使用时间的写入成本（1,000 纳）。 */
export const GAS_CONSUMER_TOUCH_NANOS = D1_ROW_WRITES.consumer_touch * GAS_SCHEDULE.d1_row_write;

/** 结算落库成本（4,000 纳）。 */
export const GAS_SETTLE_NANOS = D1_ROW_WRITES.settle * GAS_SCHEDULE.d1_row_write;

/** 写一次会话亲和的成本（3,000 纳）。 */
export const GAS_AFFINITY_UPSERT_NANOS = D1_ROW_WRITES.affinity_upsert * GAS_SCHEDULE.d1_row_write;

/** 一次完整推理执行的最低 Gas（同方言直通、非流式、稳态无写亲和 = 6,730 纳）。 */
export const GAS_FLOOR_NANOS = applyGasMargin(
  GAS_ENTRY_BASE_NANOS + GAS_CONSUMER_TOUCH_NANOS + GAS_SETTLE_NANOS,
);

/**
 * 默认余额安全阈值（10,000 纳 = $0.00001）：
 * 刚好覆盖「跨方言 + 流式 + 首次写亲和」的完整单次路径（9,890 纳）。
 * 余额低于该阈值时在入口直接 402 拒绝，0 次 D1 写、0 次上游调用。
 */
export const DEFAULT_MIN_BALANCE_NANOS = 10_000;

export type GasMeterOptions = {
  /** 入口鉴权时读到的可用余额快照（纳美元）。 */
  availableNanos: number;
  /** 入口安全余额阈值；绝不会低于一次最低执行 Gas（GAS_FLOOR_NANOS）。 */
  minBalanceNanos?: number;
  /** 毛利率（基点），默认取 GAS_MARGIN_BPS。 */
  marginBps?: number;
};

/**
 * 请求级动态 Gas 计量器。
 *
 * 生命周期：new GasMeter() → 沿执行路径多次 charge() → settle 前 finalizeForSettlement() 冻结。
 * 冻结后禁止再写入任何费用，从类型与运行时两层杜绝「计费后再事后补数」。
 */
export class GasMeter {
  readonly availableNanos: number;
  readonly minBalanceNanos: number;
  private readonly marginBps: number;
  private rawNanos: number = GAS_ENTRY_BASE_NANOS;
  private finalized = false;
  private frozenTotal = 0;

  constructor(options: GasMeterOptions) {
    this.availableNanos = options.availableNanos;
    this.marginBps = options.marginBps ?? GAS_MARGIN_BPS;
    const floor = applyGasMargin(
      GAS_ENTRY_BASE_NANOS + GAS_CONSUMER_TOUCH_NANOS + GAS_SETTLE_NANOS,
      this.marginBps,
    );
    this.minBalanceNanos = Math.max(options.minBalanceNanos ?? DEFAULT_MIN_BALANCE_NANOS, floor);
  }

  /** 是否已冻结（已进入结算）。 */
  get isFinalized(): boolean {
    return this.finalized;
  }

  /** 入口安全阈值检查：不达标即提前拒绝，避免发生任何 D1 写入与上游调用。 */
  canStart(): boolean {
    return this.availableNanos >= this.minBalanceNanos;
  }

  /** 累加一项真实发生的原始成本（纳美元整数）。冻结后调用直接抛错。 */
  charge(amountNanos: number): void {
    if (this.finalized) {
      throw new Error('GasMeter 已冻结：不允许在计费发生后再追加计费');
    }
    if (!Number.isInteger(amountNanos) || amountNanos < 0) {
      throw new Error(`非法的 Gas 增量：${amountNanos}`);
    }
    this.rawNanos += amountNanos;
  }

  /** 按真实 D1 行写数累加（每行 1,000 纳）。 */
  chargeD1Writes(rows: number): void {
    if (!Number.isInteger(rows) || rows < 0) {
      throw new Error(`非法的 D1 行写数：${rows}`);
    }
    if (rows === 0) return;
    this.charge(rows * GAS_SCHEDULE.d1_row_write);
  }

  /** 当前已累加金额（含毛利倍数）。 */
  currentNanos(): number {
    return this.finalized ? this.frozenTotal : applyGasMargin(this.rawNanos, this.marginBps);
  }

  /** 预估「当前已累加 + 接下来必经/计划发生的原始成本」的总 Gas（含毛利倍数）。 */
  projectedTotal(additionalRawNanos = 0): number {
    if (this.finalized) return this.frozenTotal;
    return applyGasMargin(this.rawNanos + additionalRawNanos, this.marginBps);
  }

  /** 判断余额快照是否足以覆盖当前已累计 + 后续必经/待执行成本（用于中途中止省费）。 */
  canAfford(additionalRawNanos = 0): boolean {
    return this.availableNanos >= this.projectedTotal(additionalRawNanos);
  }

  /**
   * 结算前调用一次：把结算本身的 4 行 D1 写入入账并冻结计量器，返回最终 Gas。
   * 重复调用直接抛错，确保一笔请求只结算一次。
   */
  finalizeForSettlement(): number {
    if (this.finalized) {
      throw new Error('GasMeter 已冻结：不能重复结算');
    }
    this.rawNanos += GAS_SETTLE_NANOS;
    this.frozenTotal = applyGasMargin(this.rawNanos, this.marginBps);
    this.finalized = true;
    return this.frozenTotal;
  }

  /** 读取冻结后的最终 Gas（未冻结前调用抛错，防止误用半成品数字写账）。 */
  finalTotal(): number {
    if (!this.finalized) {
      throw new Error('GasMeter 尚未冻结：请先调用 finalizeForSettlement()');
    }
    return this.frozenTotal;
  }
}
