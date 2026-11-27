/**
 * 记账：一次调用的钱怎么记下来。文本与音频共用这一份。
 *
 * 两条路（聊天与音频）花的钱同源：Gas 付给 Norm（这次执行真的发生过），Token 费是上游
 * 提供方那边的 Token 价值——调用自有上游时也不记 0，而是同账户自转自（余额净额不变，
 * 但账本留下了这次调用真实花了多少钱）。差别只在「用量怎么折成钱」——文本按三项 token，音频
 * 按秒、字符或 token——所以折算留在各自的路由里，记账的三个动作（写出请求行、结算余额、
 * 说出这次扣了多少）留在这里，一处只有一份。
 */
import type { NormMeta } from '../dialects';
import type { Env } from '../env';
import { D1_ROW_WRITES, type GasMeter } from '../gas';
import { nowSeconds } from '../ids';
import {
  ZERO_AUDIO_USAGE,
  ZERO_IMAGE_USAGE,
  type AudioUsage,
  type ImageUsage,
  type PriceAnchor,
  type Usage,
} from '../pricing';
import { settle, type RequestRecord, type Settled } from '../store';

/** 一次调用在记账时需要知道的一切，与它最终成功还是失败无关。 */
export type Accounting = {
  env: Env;
  address: string;
  providerId: string;
  /** 收钱的那一方的地址：公共池时是站点的地址，不是调用方的。 */
  providerUser: string;
  /** 花钱的那一方的地址：消费者密钥属于谁；签名直连时为空。 */
  consumerUser: string | null;
  /** true = 公共池兜底，false = 自己名下的上游。 */
  pool: boolean;
  consumerId: string;
  /** 打到的上游提供商地址：账本要能回答「这一笔打给哪台机器」。 */
  baseUrl: string;
  requestId: string;
  startedAt: number;
  /** 请求级动态 Gas 计量器：结算前冻结，之后只读不改。 */
  gas: GasMeter;
  host: string;
  model: string;
  /**
   * 这一次按哪一档计价：协议自带分时价时由请求开始的时刻定下（`rateAt`），
   * null = 用通用价目表（音频调用恒为 null：音频价目不分时）。
   */
  rate: PriceAnchor | null;
  /** 首字延迟：流式里第一个文本增量到达的时刻；非流式没有这个事件，留空。 */
  firstTokenMs?: number | null;
};

/**
 * 一笔账要的用量：token 三项 + 音频三项 + 图像两项。三条路各用一部分，其余留零——
 * 「这次调用消耗了什么」是三个互不相干的量，硬折成一个只会让账本说不清。
 */
export type Receipt = {
  status: string;
  statusCode: number | null;
  /** 应付给上游提供方的 Token 费（自有上游按真价记，由调用方算好）。 */
  tokenNanos: number;
  usage: Usage;
  audio: AudioUsage;
  /** 图像用量（张数与像素）；非图像调用留空，与音频同一个写法。 */
  image?: ImageUsage;
};

/**
 * 账单结论：Gas（付给 Norm）与 Token（上游提供方那边的 Token 价值）分开记，外加三项 token 与差额。
 *
 * `fee_nanos` 是这次调用的真实价值，恒等于 `gas_billed_nanos + token_billed_nanos`
 * 以及 `gas_fee_nanos + token_nanos - unbilled_nanos`；分开回，谁都能自己核对。
 *
 * 自有上游时 `token_self_nanos` 是其中「自己转给自己」的那一部分：它计进价值、计进账本，
 * 但**不动余额**——余额只减 Gas。要算余额变化就用 `fee_nanos - token_self_nanos`。
 */
export function normMeta(accounting: Accounting, receipt: Receipt, billed: Settled): NormMeta {
  return {
    request_id: accounting.requestId,
    fee_nanos: billed.billedNanos,
    gas_fee_nanos: accounting.gas.finalTotal(),
    gas_billed_nanos: billed.gasBilledNanos,
    token_nanos: receipt.tokenNanos,
    token_billed_nanos: billed.tokenBilledNanos,
    token_self_nanos: accounting.providerUser === accounting.address ? billed.tokenBilledNanos : 0,
    input_tokens: receipt.usage.input,
    cached_tokens: receipt.usage.cached,
    output_tokens: receipt.usage.output,
    audio_ms: receipt.audio.milliseconds,
    audio_characters: receipt.audio.characters,
    image_count: (receipt.image ?? ZERO_IMAGE_USAGE).count,
    image_pixels: (receipt.image ?? ZERO_IMAGE_USAGE).pixels,
    unbilled_nanos: billed.unbilledNanos,
    balance_nanos: billed.balanceNanos,
    latency_ms: Date.now() - accounting.startedAt,
    host: accounting.host,
    pool: accounting.pool,
  };
}

/**
 * 把一次成功的调用折成钱、记下来，返回给客户端看的账单结论。
 *
 * Gas 与 Token 分开处理：
 *   - 调用自有上游（providerUser === address）：Token 费按真价记成「自转自」——同一账户的
 *     token_spend 与 earn 同增，余额只减 Gas；这笔转账和结算同一条 UPDATE，所以不额外计 Gas；
 *   - 调用他人/公共池上游（providerUser !== address）：按价目表计算 Token 费并转给上游提供方，
 *     同时在 Gas 里计入这次跨用户入账的 1 行 D1 写库成本。
 */
export async function settleBill(accounting: Accounting, receipt: Receipt): Promise<NormMeta> {
  if (accounting.providerUser !== accounting.address && receipt.tokenNanos > 0) {
    accounting.gas.chargeD1Writes(D1_ROW_WRITES.token_transfer);
  }
  const gasFeeNanos = accounting.gas.finalizeForSettlement();
  const settled = await settle(accounting.env, requestRecord(accounting, { ...receipt, gasFeeNanos }));
  return normMeta(accounting, receipt, settled);
}

/**
 * 失败也收 Gas，只免 token：能被记成失败的调用都已经真的打出去了（一次 Worker 调用、
 * 几次 D1 读写），那笔成本与上游回不回得出答案无关；没有答案，就没有可计价的量。
 * 记录仍然是完整的——打了哪台机器、用哪把钥匙、跑了多久，一个都不少。
 */
export async function recordFailure(accounting: Accounting, status: string, statusCode: number): Promise<Settled> {
  const gasFeeNanos = accounting.gas.finalizeForSettlement();
  return settle(
    accounting.env,
    requestRecord(accounting, {
      status,
      statusCode,
      gasFeeNanos,
      tokenNanos: 0,
      usage: { input: 0, cached: 0, output: 0 },
      audio: ZERO_AUDIO_USAGE,
    }),
  );
}

/**
 * 回执头：这次调用收了多少钱、记在哪个请求 ID 上。
 *
 * 文本与音频、成功与失败都挂同一套头，字节响应（合成）尤其靠它——音频里塞不进账目。
 * 名字与音频那侧原本就在用的四个保持一致，别让同一件事有两种头名。
 */
export function receiptHeaders(meta: NormMeta): Record<string, string> {
  return {
    'X-Norm-Request-Id': meta.request_id,
    'X-Norm-Fee-Nanos': String(meta.fee_nanos),
    'X-Norm-Gas-Billed-Nanos': String(meta.gas_billed_nanos),
    'X-Norm-Token-Billed-Nanos': String(meta.token_billed_nanos),
    'X-Norm-Token-Self-Nanos': String(meta.token_self_nanos),
  };
}

/** 失败响应是上游的原话，账单只能挂在头上：这一次到底扣了多少 Gas。 */
export function failureHeaders(requestId: string, settled: Settled): Record<string, string> {
  return {
    'X-Norm-Request-Id': requestId,
    'X-Norm-Gas-Fee-Nanos': String(settled.gasBilledNanos),
  };
}

/** 把这次调用写成 requests 那一行。 */
function requestRecord(
  accounting: Accounting,
  parts: Receipt & { gasFeeNanos: number },
): RequestRecord {
  return {
    requestId: accounting.requestId,
    address: accounting.address,
    providerId: accounting.providerId,
    providerUser: accounting.providerUser,
    consumerId: accounting.consumerId,
    consumerUser: accounting.consumerUser,
    baseUrl: accounting.baseUrl,
    model: accounting.model,
    status: parts.status,
    statusCode: parts.statusCode,
    latencyMs: Date.now() - accounting.startedAt,
    firstTokenMs: accounting.firstTokenMs ?? null,
    inputTokens: parts.usage.input,
    cachedTokens: parts.usage.cached,
    outputTokens: parts.usage.output,
    audioMs: parts.audio.milliseconds,
    audioCharacters: parts.audio.characters,
    imageCount: (parts.image ?? ZERO_IMAGE_USAGE).count,
    imagePixels: (parts.image ?? ZERO_IMAGE_USAGE).pixels,
    gasFeeNanos: parts.gasFeeNanos,
    tokenNanos: parts.tokenNanos,
    // 由 settle 覆盖成「真正扣掉的」：成功是 Gas + token，失败只有 Gas。
    feeNanos: 0,
    unbilledNanos: 0,
    at: nowSeconds(),
  };
}
