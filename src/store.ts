import type { Env } from './env';
import { audioCodecFor, type AudioAsk } from './audio';
import { imageCodecFor, type ImageAsk } from './images';
import { type Modalities, type ModelInfo, protocolFor, type Protocol } from './protocols';
import { grantNanos } from './env';
import { isTrusted } from './base-urls';
import { affinityTtlSeconds } from './env';
import { fail } from './http';
import { nowSeconds, randomToken } from './ids';
import {
  D1_ROW_WRITES,
  GAS_AFFINITY_UPSERT_NANOS,
  type GasMeter,
} from './gas';
import { affinityFresh, affinityHash, narrowToOwned, narrowToServingModel, pickByRendezvous, type AffinityKey } from './routing';

/**
 * 账户的六块只增累计数，方向不同、归属不同：
 *
 *   充值       用户真的打进来的钱（可以提现）
 *   抵扣券     站点给的额度，比如演示授信（**不可提现**）
 *   上游收入   他人调用自己上游时，转进来的 Token 价值（价值转移，非平台增发）
 *   Gas 支出   付给 Norm 的执行与落库费用（无论自有/公共池、成功/失败都收）
 *   Token 支出 转给他人上游的 Token 价值（调用自有上游时为 0）
 *   提现       已经拿走的
 *
 * 可用余额 = 充值 + 抵扣券 + 上游收入 − Gas 支出 − Token 支出 − 提现。
 * 总消费   = Gas 支出 + Token 支出。
 * 两者都不落库，就是为了让它们永远等于这两个算式。
 */
export type PrincipalCounters = {
  recharge_nanos: number;
  voucher_nanos: number;
  earn_nanos: number;
  gas_spend_nanos: number;
  token_spend_nanos: number;
  withdraw_nanos: number;
};

export type PrincipalRow = PrincipalCounters & {
  address: string;
  label: string;
  created_at: number;
};

/** 累计总消费 = Gas 支出（付给 Norm）+ Token 支出（转给上游用户）。 */
export function totalSpendNanos(counters: {
  gas_spend_nanos: number;
  token_spend_nanos: number;
}): number {
  return counters.gas_spend_nanos + counters.token_spend_nanos;
}

/** 可用余额：唯一的算法，出现在页面、接口与扣费判断里，都是同一句。 */
export function availableNanos(counters: PrincipalCounters): number {
  return (
    counters.recharge_nanos +
    counters.voucher_nanos +
    counters.earn_nanos -
    counters.gas_spend_nanos -
    counters.token_spend_nanos -
    counters.withdraw_nanos
  );
}

export type ProviderView = ProviderRow & {
  /** 主机名是否在信任清单里。只回事实，怎么措辞由前端决定。 */
  trusted: boolean;
  /** 清单里记着几个型号；`models_fetched_at` 为 0 时这个数没有意义（还没抓过）。 */
  models_count: number;
  /** true = 本账户名下的一条；false = 公共池里站点持有的那条，只能看不能改。 */
  mine: boolean;
};

/** 一条上游属于谁：private 只给主人用，pool 是全站兜底。 */
export type ProviderScope = 'private' | 'pool';

export type ProviderRow = {
  id: string;
  address: string;
  label: string;
  base_url: string;
  key_hint: string;
  sealed_key: string;
  /** 代理地址的密文（`http://user:pass@host:port`）。空串 = 直连，不走隧道。 */
  sealed_proxy: string;
  /** 展示用提示：密码位置是 ***。空串 = 没配代理。 */
  proxy_hint: string;
  kdf: string;
  // INVARIANT: 这两列只由 providers 路由写入，写入前已校验枚举；
  // 因此读出来一定是合法取值，不需要在每个调用点再判一次。
  protocol: Protocol;
  /** private / pool。池子里的那条，所有账户都能在兜底时用到它——「公开」就是这一列。 */
  scope: ProviderScope;
  /** 1 = 参与选址；0 = 暂时不用。撤销（revoked_at）才是永久退场。 */
  enabled: number;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 地址第一次出现就开户并给演示授信。三条语句在同一个 batch 里，
 * 保证「给钱」与「记这笔钱」不会分叉；重复调用安全。
 *
 * 返回「这次是不是真的开了户」：主键是地址，授信那一条用 `WHERE voucher_nanos = 0`
 * 兜住，重复调用既不会开出第二个账户，也不会再发一张券。
 */
export async function ensurePrincipal(env: Env, address: string, at: number): Promise<boolean> {
  const grant = grantNanos(env);
  const [opened] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO principals (address, created_at) VALUES (?, ?)').bind(address, at),
    env.DB.prepare(
      `INSERT INTO ledger (id, address, kind, amount_nanos, available_after_nanos, created_at)
       SELECT ?, address, 'voucher', ?, ?, ? FROM principals
       WHERE address = ? AND voucher_nanos = 0`,
    ).bind(randomToken(), grant, grant, at, address),
    env.DB.prepare(
      `UPDATE principals SET voucher_nanos = ?
       WHERE address = ? AND voucher_nanos = 0`,
    ).bind(grant, address),
  ]);
  return (opened.meta.changes ?? 0) > 0;
}

export async function principalExists(env: Env, address: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS found FROM principals WHERE address = ?').bind(address).first<{ found: number }>();
  return row !== null;
}

export async function findPrincipal(env: Env, address: string): Promise<PrincipalRow> {
  const row = await env.DB.prepare('SELECT * FROM principals WHERE address = ?').bind(address).first<PrincipalRow>();
  if (!row) throw new Error(`账户不存在：${address}`);
  return row;
}

/**
 * 账户看得见的上游：自己名下的 + 公共池里的。
 *
 * 池子那条对调用方是只读的，而且只回「是什么」：label / host / protocol / 启用状态。
 * 「拿什么去打」不回——key_hint 是持有者的信息，摆到所有人面前等于把站点的上游账户
 * 挂出来示众；sealed_key 更是能解出密钥的密文，一个字都不该离开持有者的账户。
 */
export async function listProviders(env: Env, address: string): Promise<ProviderView[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM provider_models m WHERE m.provider_id = p.id) AS models_count
       FROM providers p
      WHERE p.revoked_at IS NULL AND (p.address = ? OR p.scope = 'pool')
      ORDER BY p.created_at DESC, p.rowid DESC`,
  )
    .bind(address)
    .all<ProviderRow & { models_count: number }>();
  // trusted 由同一份清单算出，不落库：清单改了，所有上游提供商的说法立刻跟着变。
  return results.map((row) => {
    const mine = row.address === address;
    return {
      ...row,
      trusted: isTrusted(row.base_url, env),
      mine,
      ...(mine ? {} : { key_hint: '', sealed_key: '', sealed_proxy: '', proxy_hint: '' }),
    };
  });
}

export async function findProvider(env: Env, address: string, id: string): Promise<ProviderRow | null> {
  return env.DB.prepare('SELECT * FROM providers WHERE id = ? AND address = ? AND revoked_at IS NULL')
    .bind(id, address)
    .first<ProviderRow>();
}

/**
 * 换过新的 OAuth 凭据写回库。
 *
 * 只动密文，不动提示：轮换换的是令牌，工作区 id 与 key_hint 一个字都不变。按 id 写而不是
 * 按 address 写，是因为调用发生的那一刻就要生效——公共池里那条属于站点，但那条行是谁的
 * 不会因为谁在借用而改变。
 */
export async function updateProviderSealedKey(
  env: Env,
  { providerId, sealed }: { providerId: string; sealed: string },
): Promise<void> {
  await env.DB.prepare('UPDATE providers SET sealed_key = ? WHERE id = ?').bind(sealed, providerId).run();
}

/**
 * 一次调用的全部记账：Gas 与 Token 分开结算，同时写入请求记录。
 *
 *   1. Gas 费（gas_fee_nanos → gas_billed_nanos）：付给 Norm，覆盖执行与落库成本；
 *      成功/失败、自有/他人上游都照收，优先从余额里扣。
 *   2. Token 费（token_nanos → token_billed_nanos）：用户间价值转移。
 *      - 调用自己的上游（providerUser === address 或空）：不产生跨用户价值转移，token 恒为 0；
 *      - 调用他人/公共池上游（providerUser !== address）：余下余额扣 tokenBilled，
 *        等额计入上游提供方的 earn_nanos（绝不凭空增发未扣到的钱）。
 *
 * 余额充足时 `unbilled_nanos` 恒为 0，`fee_nanos = gas_billed_nanos + token_billed_nanos`。
 * 失败（上游提供商报错、网络不可达）也走这里：Gas 照收，token 那部分是 0。
 */

export type Settled = {
  /** 真正从消费方余额里扣掉的总数（= gasBilledNanos + tokenBilledNanos）。 */
  billedNanos: number;
  /** 实际扣到的 Gas 费（付给 Norm）。 */
  gasBilledNanos: number;
  /** 实际扣到并转给上游用户的 Token 费（调用自有上游或失败时恒为 0）。 */
  tokenBilledNanos: number;
  /** 扣不满、未能收上来的部分。 */
  unbilledNanos: number;
  /** 扣费后消费方的可用余额。 */
  balanceNanos: number;
};

export type RequestRecord = {
  requestId: string;
  address: string;
  providerId: string | null;
  /** 上游提供商持有者的地址：自有上游时与 address 相同，公共池时不同（收 Token 费的一方）。 */
  providerUser: string | null;
  /** 花钱的那一方的地址（consumer 密钥属于谁）：签名直连时为空。 */
  consumerUser: string | null;
  /** 这次调用由哪把下游消费者密钥发起；签名直连时为空。 */
  consumerId: string | null;
  baseUrl: string;
  model: string;
  status: string;
  statusCode: number | null;
  latencyMs: number;
  /** 首字延迟：第一个文本增量到达的时刻；非流式没有这个事件，记 null。 */
  firstTokenMs: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** 音频用量：转写覆盖的时长（毫秒）与合成的字符数；文本调用恒为 0。 */
  audioMs: number;
  audioCharacters: number;
  /** 图像用量：这次画了几张、一张多少像素；非图像调用恒为 0。 */
  imageCount: number;
  imagePixels: number;
  gasFeeNanos: number;
  tokenNanos: number;
  feeNanos: number;
  unbilledNanos: number;
  at: number;
};

/** 只写请求记录、不扣费：`settle` 三次都被并发改写时用它兜底，那一笔标成未收。 */
export async function recordRequest(env: Env, row: RequestRecord, spendNanos: number): Promise<void> {
  await requestInsert(env, row, {
    gasBilledNanos: 0,
    tokenBilledNanos: 0,
    spendBeforeNanos: spendNanos,
    spendAfterNanos: spendNanos,
    earnBeforeNanos: 0,
    earnAfterNanos: 0,
  }).run();
}

/**
 * 这次转发用哪条上游：模型跑得了是前提，自己名下的优先，公共池兜底，会话按 thread-id / session-id 粘住。
 *
 * 旧版本在多条上游时拒绝服务（409 provider_ambiguous），理由是「钱付给谁」不该由默认值
 * 替用户决定。那条理由现在不成立了：上游只有两种来源——你自己的，或站点的池子——
 * 两种都是配置好、声明过的，自动选址不再是把钱打给一个陌生账户。剩下的问题只是
 * 「这一次打到哪台主机上」，而那个问题可以随手给，也可以给得很稳定。
 *
 * 判定顺序（每一步都能单独解释）：
 *   0. 候选里跑不了这个型号的先去掉了（见 narrowToServingModel）：清单抓过而不含它，
 *      就不是「优先级低」，是跑不了；清单从没抓过的那条留着，没有证据不等于说它没有
 *   1. 候选 = 启用中、未撤销、(自己名下 或 池子里)
 *   2. 有自有候选 → 只留自有的；一条都没有 → 这一单落到池子上
 *   3. 亲和键命中且那条仍在候选里 → 就是它
 *   4. 否则 rendezvous 重挑（同一会话在候选不变时稳定落在同一条），并写回亲和表
 */
export type ProviderChoice = {
  provider: ProviderRow;
  /** owned = 自己名下的一条；pool = 公共池兜底。 */
  via: 'owned' | 'pool';
  /** 这次是按亲和表钉住的，还是重新挑的。 */
  sticky: boolean;
};

/** 这一次要问的两件事：谁的清单抓过、谁有这个名字。 */
export type ModelCoverage = { known: Set<string>; serving: Set<string> };

/**
 * D1 每次查询最多 100 个绑定变量（`too many SQL variables`）。
 *
 * 写清单的 INSERT 每行 4 个变量（provider_id / model / fetched_at / modalities），
 * 所以一条语句最多 25 行——取 24 留余量。这个数不是性能参数，是**正确性**参数：
 * 越过去就是整条写入失败，而它在「清单有多少条」这个维度上才暴露，夹具只有三五个
 * 模型时永远看不见。
 */
export const MODEL_ROWS_PER_STATEMENT = 24;

/** 问清单时的 IN (...) 宽度：一个模型名 + N 个上游 id，同样要留在 100 以内。 */
const MODEL_QUERY_CHUNK = 40;

/** 把一串待写入的行切成每次 INSERT 能装下的若干批。纯函数，方便钉住上面那条上限。 */
export function modelInsertChunks<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += MODEL_ROWS_PER_STATEMENT) {
    chunks.push(rows.slice(start, start + MODEL_ROWS_PER_STATEMENT));
  }
  return chunks;
}

/**
 * 模态的落库形状：JSON 文本，没声明就是 NULL。
 *
 * 不用 `'[]'` 表示「没说」：那是「说了，但没有」——两句话在总表上显示成两种东西
 * （`null` = 未声明，空数组 = 上游明确说自己哪样都不吃），不能压成一种。
 */
function modalitiesText(modalities: Modalities | undefined): string | null {
  if (modalities === undefined) return null;
  const input = [...new Set(modalities.input)];
  const output = [...new Set(modalities.output)];
  return input.length === 0 && output.length === 0 ? null : JSON.stringify({ input, output });
}

/**
 * 「这个型号谁能跑」：一次左连接同时回答两件事。
 *
 * `models_fetched_at > 0` = 这条上游的清单抓过；`provider_models` 里有这一行 = 它有它。
 * 两个集合都要，因为「清单抓过但没有它」与「清单没抓过」是两种处境，不该压成一句。
 */
export async function modelCoverage(
  env: Env,
  providerIds: readonly string[],
  model: string,
): Promise<ModelCoverage> {
  const known = new Set<string>();
  const serving = new Set<string>();
  if (providerIds.length === 0 || model.length === 0) return { known, serving };

  for (let start = 0; start < providerIds.length; start += MODEL_QUERY_CHUNK) {
    const chunk = providerIds.slice(start, start + MODEL_QUERY_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT p.id AS id, p.models_fetched_at AS fetched_at, m.model AS model
         FROM providers p
         LEFT JOIN provider_models m ON m.provider_id = p.id AND m.model = ?
        WHERE p.id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(model, ...chunk)
      .all<{ id: string; fetched_at: number; model: string | null }>();
    for (const row of results) {
      if (row.fetched_at > 0) known.add(row.id);
      if (row.model !== null) serving.add(row.id);
    }
  }
  return { known, serving };
}

/** 把要删除的模型名按 D1 绑定变量上限切成批次（1 个 provider_id + 最多 40 个 model）。 */
function modelDeleteChunks(names: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < names.length; start += MODEL_QUERY_CHUNK) {
    chunks.push(names.slice(start, start + MODEL_QUERY_CHUNK));
  }
  return chunks;
}

/**
 * 按集合 diff 同步一条上游的模型清单。
 *
 * 与早先「整份 DELETE 再整份 INSERT」不同：provider_models 有 PK + 二级索引（每行 3 写），
 * 100 个模型的上游无脑全删全插一次就是 601 行写。改成先读现有集合做差集后，清单未变且
 * 已有抓取记录时 0 次 D1 写；有增删时也只动变化的那几行。
 *
 * 模态也算进这份 diff：名字没变、上游改了它自述的模态，是上游换了说法，不写就永远停在
 * 第一次的说法上。它只改一行（UPDATE），不碰主键也不碰索引。
 *
 * 空清单**不写**：一条 200 但不认识形状的回答，和「这家什么模型都没有」看起来一样，
 * 旧快照至少是上一次的真话，不该被一次答不上话覆盖。
 */
export async function recordProviderModels(
  env: Env,
  providerId: string,
  models: readonly ModelInfo[],
  at: number,
): Promise<{ added: number; removed: number; updated: number }> {
  // 同名只留第一条：上游偶尔把同一个名字列两遍，后一条不该覆盖前一条的模态。
  const wanted = new Map<string, string | null>();
  for (const item of models) {
    if (item.id.length === 0 || wanted.has(item.id)) continue;
    wanted.set(item.id, modalitiesText(item.modalities));
  }
  if (wanted.size === 0) return { added: 0, removed: 0, updated: 0 };

  const [existingRows, fetchedRow] = await Promise.all([
    env.DB.prepare('SELECT model, modalities FROM provider_models WHERE provider_id = ?')
      .bind(providerId)
      .all<{ model: string; modalities: string | null }>(),
    env.DB.prepare('SELECT models_fetched_at FROM providers WHERE id = ?')
      .bind(providerId)
      .first<{ models_fetched_at: number }>(),
  ]);

  const current = new Map(existingRows.results.map((row) => [row.model, row.modalities]));
  const toRemove = [...current.keys()].filter((name) => !wanted.has(name));
  const toAdd = [...wanted.keys()].filter((name) => !current.has(name));
  const toUpdate = [...wanted.entries()].filter(
    ([name, modalities]) => current.has(name) && current.get(name) !== modalities,
  );
  const alreadyFetched = (fetchedRow?.models_fetched_at ?? 0) > 0;

  if (toRemove.length === 0 && toAdd.length === 0 && toUpdate.length === 0 && alreadyFetched) {
    return { added: 0, removed: 0, updated: 0 };
  }

  const statements: D1PreparedStatement[] = [];
  for (const chunk of modelDeleteChunks(toRemove)) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM provider_models WHERE provider_id = ? AND model IN (${chunk.map(() => '?').join(', ')})`,
      ).bind(providerId, ...chunk),
    );
  }
  for (const chunk of modelInsertChunks(toAdd)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO provider_models (provider_id, model, fetched_at, modalities)
         VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}
         ON CONFLICT(provider_id, model) DO UPDATE SET fetched_at = excluded.fetched_at,
           modalities = excluded.modalities`,
      ).bind(...chunk.flatMap((name) => [providerId, name, at, wanted.get(name) ?? null])),
    );
  }
  // 只是自述变了的那几行：一行一个 UPDATE，不删不插，主键与索引都不动。
  for (const [name, modalities] of toUpdate) {
    statements.push(
      env.DB.prepare('UPDATE provider_models SET modalities = ?, fetched_at = ? WHERE provider_id = ? AND model = ?').bind(
        modalities,
        at,
        providerId,
        name,
      ),
    );
  }
  statements.push(env.DB.prepare('UPDATE providers SET models_fetched_at = ? WHERE id = ?').bind(at, providerId));
  await env.DB.batch(statements);
  return { added: toAdd.length, removed: toRemove.length, updated: toUpdate.length };
}

/** 上游自己说没有这个型号：把那一行划掉，下一次选址就不会再选到它。返回实际删掉的行数（0 或 1）。 */
export async function dropProviderModel(env: Env, providerId: string, model: string): Promise<number> {
  if (model.length === 0) return 0;
  const result = await env.DB.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model = ?')
    .bind(providerId, model)
    .run();
  return result.meta?.changes ?? 0;
}

/** 忘掉一条会话的粘性：这条路选错了，下一次重挑。返回实际删掉的行数（0 或 1，WITHOUT ROWID = 1 行写）。 */
export async function forgetAffinity(env: Env, address: string, hash: string): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM affinities WHERE address = ? AND affinity_hash = ?')
    .bind(address, hash)
    .run();
  return result.meta?.changes ?? 0;
}

/** 一条同方言的上游都没有：带工具的请求在这里说清楚，而不是打出去再被拒。 */
/** 一条能跑这个型号的上游都没有：说清楚，别把请求丢给明知道没有它的上游。 */
function failModelNotServed(model: string): never {
  fail(
    404,
    'model_not_served',
    `没有上游提供模型 ${model}：到「模型」页看各条上游都有什么，或者把有它的那条上游启用后再同步清单`,
  );
}

export type ResolveRequest = {
  /** 这次要跑的模型名。空 = 不问模型（只看账户与会话），给「列清单」这类调用留的。 */
  model?: string;
  /** 这一次请求已经试过的上游：重试时排掉，保证「换」真的发生了。 */
  exclude?: readonly string[];
  /**
   * 纯读模式（如 GET /v1/models）：命中已有亲和就沿用，未命中只按 rendezvous 返回候选，
   * 绝不回写 `affinities` 表——彻底杜绝「读导致写」。
   */
  readOnly?: boolean;
  /** 传入动态 Gas 计量器时：写亲和前先做余额闸门检查，写完立刻按真实行写累加。 */
  gas?: GasMeter;
  /** 写亲和之后必然还会发生的原始成本（如 consumer_touch + settle），用于预算检查。 */
  pendingRequiredNanos?: number;
  /** 余额不足以支付写亲和 + 后续必经成本时：true 直接 402 中止（首次尝试），false 跳过写亲和。 */
  abortOnInsufficientBalance?: boolean;
  /**
   * 这一次是一次音频调用：只有「音频方言做得了它」的上游才进候选（`audio.ts` 的 `serves`）。
   * 传的是解析后的规范请求，因为「做不做得了」既看转写还是合成，也看跑不跑得了这个型号。
   */
  audio?: AudioAsk;
  /**
   * 这一次是一次图像调用：只有「图像方言做得了它」的上游才进候选（`images.ts` 的 `serves`）。
   * 与音频同一个理由——跑不了这次调用的上游连一次 400 的机会都不该有。
   */
  image?: ImageAsk;
};

export async function resolveProvider(
  env: Env,
  address: string,
  affinityKey: AffinityKey | null,
  request: ResolveRequest = {},
): Promise<ProviderChoice> {
  const now = nowSeconds();
  // 顺序固定（created_at, id）：rendezvous 的落点必须是候选的确定函数，
  // 否则两个 Worker 上同一个会话会落到不同上游。
  const { results } = await env.DB.prepare(
    `SELECT * FROM providers
      WHERE revoked_at IS NULL AND enabled = 1 AND (address = ? OR scope = 'pool')
      ORDER BY created_at, id`,
  )
    .bind(address)
    .all<ProviderRow>();
  if (results.length === 0) return failNoCandidate(env, address);

  // 试过的不再选：换候选时这一步保证「换」真的发生了，而不是原地重试。
  const excluded = new Set(request.exclude ?? []);
  let pool = results.filter((row) => !excluded.has(row.id));
  if (pool.length === 0) fail(404, 'provider_exhausted', '试过的上游都跑了、也没有别的上游可以换');

  // 音频调用还有一条硬约束，比「自有优先」更硬：这条上游的音频方言得做得了这一次
  // （转写还是合成、跑不跑得了这个型号）。跑不了的上游连一次 400 的机会都不该有。
  const audio = request.audio;
  if (audio !== undefined) {
    pool = pool.filter((row) => {
      const dialect = protocolFor(row.protocol).audio;
      return dialect !== undefined && audioCodecFor(dialect).serves(audio);
    });
    if (pool.length === 0) fail(404, 'audio_not_served', `没有上游能接这次音频调用：${audio.model}`);
  }

  // 图像调用同理，而且更硬：只有声明了图像方言、且那条方言认得这个型号的上游才进候选。
  const image = request.image;
  if (image !== undefined) {
    pool = pool.filter((row) => {
      const dialect = protocolFor(row.protocol).image;
      return dialect !== undefined && imageCodecFor(dialect).serves(image);
    });
    if (pool.length === 0) fail(404, 'image_not_served', `没有上游能接这次图像调用：${image.model}`);
  }

  // 模型是硬约束，自有优先是偏好：先把「跑不了这个型号」的整批去掉，再在能跑的里面
  // 让自有的赢。反过来的顺序会让「自己有一条不支持这个型号的上游」把请求卡死在它身上，
  // 池子里那条能跑的反而用不上。
  const model = (request.model ?? '').trim();
  if (model) {
    pool = [...narrowToServingModel(pool, await modelCoverage(env, pool.map((row) => row.id), model))];
    if (pool.length === 0) failModelNotServed(model);
  }

  // 自有优先：池子只在「自己名下没有能跑这个型号的上游」时才接这一单。
  const candidates = narrowToOwned(pool, address);
  const via = (provider: ProviderRow): 'owned' | 'pool' => (provider.address === address ? 'owned' : 'pool');

  // 没有亲和键 = 这次请求不粘：直接按随机种子摊开，连亲和表都不读。
  if (!affinityKey) {
    const chosen = pickByRendezvous(candidates, randomToken(12));
    return { provider: chosen, via: via(chosen), sticky: false };
  }

  const hash = affinityHash(address, affinityKey.value);
  const pinned = await env.DB.prepare(
    'SELECT provider_id, expires_at FROM affinities WHERE address = ? AND affinity_hash = ?',
  )
    .bind(address, hash)
    .first<{ provider_id: string; expires_at: number }>();

  if (pinned && affinityFresh(pinned.expires_at, now)) {
    const hit = candidates.find((candidate) => candidate.id === pinned.provider_id);
    // 钉住的那条还在候选里才算命中。不在（禁用了、撤销了、自己的上游恢复把池子挤掉）
    // 就重挑——粘性是「尽量不搬家」，不是「宁可失败也不搬家」。
    if (hit) return { provider: hit, via: via(hit), sticky: true };
  }

  const chosen = pickByRendezvous(candidates, hash);
  // 纯读请求（如 GET /v1/models）绝不触发写库，避免「读导致写」放大 D1 写入与锁竞争。
  if (request.readOnly) {
    return { provider: chosen, via: via(chosen), sticky: false };
  }
  const gas = request.gas;
  if (gas) {
    const needed = GAS_AFFINITY_UPSERT_NANOS + (request.pendingRequiredNanos ?? 0);
    if (!gas.canAfford(needed)) {
      if (request.abortOnInsufficientBalance) {
        fail(
          402,
          'insufficient_balance',
          `余额不足：本次请求预计至少需要 ${gas.projectedTotal(needed)} 纳美元 Gas，当前 ${gas.availableNanos}`,
        );
      }
      // 二次重试时余额紧到不够写亲和，就跳过写亲和省下这 1 行写，继续走本次选出的上游。
      return { provider: chosen, via: via(chosen), sticky: false };
    }
  }
  await rememberAffinity(env, address, hash, chosen.id, now);
  if (gas) {
    gas.chargeD1Writes(D1_ROW_WRITES.affinity_upsert);
  }
  return { provider: chosen, via: via(chosen), sticky: false };
}

/**
 * 写回亲和（WITHOUT ROWID 聚簇表，0 二级索引 = 严格 1 行写 / 1,000 纳）。
 *
 * 只在「没记住 / 记住的不是这条 / 那条已过期」时才写；稳态 7 天内每次命中都是纯读（0.001 纳）。
 * 刻意不在写亲和时顺手删过期行：过期判定读的时候靠 `expires_at > now` 完成，100 万条历史
 * 记录也仅占 ~120 MB（远低于 D1 5 GB 额度），不该让单次正常请求为历史清理买单。
 */
export async function rememberAffinity(
  env: Env,
  address: string,
  hash: string,
  providerId: string,
  now: number,
): Promise<void> {
  const ttl = affinityTtlSeconds(env);
  await env.DB.prepare(
    `INSERT INTO affinities (address, affinity_hash, provider_id, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address, affinity_hash) DO UPDATE SET
       provider_id = excluded.provider_id,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(address, hash, providerId, now + ttl, now)
    .run();
}

/**
 * 一条候选都没有：分「自己的都关了」与「压根没有」两种处境说清楚，并且都提到池子——
 * 池子也空着时，这两句话是调用方唯一能拿到的线索。
 */
async function failNoCandidate(env: Env, address: string): Promise<never> {
  const own = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM providers WHERE address = ? AND revoked_at IS NULL',
  )
    .bind(address)
    .first<{ n: number }>();
  if ((own?.n ?? 0) > 0) {
    fail(409, 'provider_disabled', '自己的上游提供商都已禁用，公共池里也没有可用的：到「上游提供商」页启用一条');
  }
  fail(400, 'provider_missing', '还没有上游提供商，公共池里也没有可用的：先去「上游提供商」页添加一条');
}

/**
 * 分开结算 Gas 费（付给 Norm）与 Token 费（转给上游提供方），并写请求记录：
 *
 *   - 扣费优先级：先扣 Gas（基础设施成本已发生），余下余额再扣 Token；余额永远不会变成负数。
 *   - 价值守恒：只有「调用他人/公共池上游」时才产生 Token 费用；实际从消费方扣到的
 *     `tokenBilled` 会等额加到上游提供方的 `earn_nanos` 上，绝不凭空增发未扣到的钱。
 *   - 调用自己的上游（`providerUser === address`）不产生跨用户价值转移：`tokenDue = 0`，
 *     只扣 Gas、不写上游提供方，稳态严格维持 2 行 D1 写。
 *
 * 并发控制：
 *   - 消费方用 `(gas_spend_nanos, token_spend_nanos, withdraw_nanos)` 做乐观锁（这三块是
 *     唯三会让余额变小的累计数；收入/充值/抵扣券只增不减，不会导致扣成负数），冲突重试最多 3 次。
 *   - 上游提供方的入账是纯加法 `SET earn_nanos = earn_nanos + ? RETURNING earn_nanos`，
 *     在 SQLite 里天然原子、可交换、无需乐观锁，且直接返回准确的 `earn_after_nanos`。
 */
export async function settle(env: Env, row: RequestRecord): Promise<Settled> {
  const isExternal = Boolean(row.providerUser && row.providerUser !== row.address);
  const gasDue = row.gasFeeNanos;
  // 调用自有上游只付 Gas，不产生跨用户 Token 扣费或转账。
  const tokenDue = isExternal ? row.tokenNanos : 0;
  const due = gasDue + tokenDue;
  const countersSql = 'recharge_nanos, voucher_nanos, earn_nanos, gas_spend_nanos, token_spend_nanos, withdraw_nanos';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await env.DB.prepare(`SELECT ${countersSql} FROM principals WHERE address = ?`)
      .bind(row.address)
      .first<PrincipalCounters>();
    if (!current) throw new Error(`账户不存在：${row.address}`);

    // 先扣 Gas（给 Norm），余额有剩再扣 Token（转给上游提供方）；差额记成 unbilled。
    const avail = Math.max(availableNanos(current), 0);
    const gasBilled = Math.min(gasDue, avail);
    const tokenBilled = Math.min(tokenDue, Math.max(avail - gasBilled, 0));
    const billed = gasBilled + tokenBilled;

    // 消费方只增 gas_spend / token_spend；盯住所有减项计数器防并发透支。
    const updated = await env.DB.prepare(
      `UPDATE principals
          SET gas_spend_nanos = gas_spend_nanos + ?,
              token_spend_nanos = token_spend_nanos + ?
        WHERE address = ?
          AND gas_spend_nanos = ?
          AND token_spend_nanos = ?
          AND withdraw_nanos = ?
        RETURNING ${countersSql}`,
    )
      .bind(gasBilled, tokenBilled, row.address, current.gas_spend_nanos, current.token_spend_nanos, current.withdraw_nanos)
      .first<PrincipalCounters>();
    if (!updated) continue;

    // 跨用户 Token 价值转移：只有实际从消费方扣到的那部分才转给上游提供方，保证全站价值守恒。
    let earnBefore = 0;
    let earnAfter = 0;
    if (isExternal && tokenBilled > 0 && row.providerUser) {
      const credited = await env.DB.prepare(
        `UPDATE principals
            SET earn_nanos = earn_nanos + ?
          WHERE address = ?
          RETURNING earn_nanos`,
      )
        .bind(tokenBilled, row.providerUser)
        .first<{ earn_nanos: number }>();
      if (credited) {
        earnAfter = credited.earn_nanos;
        earnBefore = credited.earn_nanos - tokenBilled;
      }
    }

    const settled: Settled = {
      billedNanos: billed,
      gasBilledNanos: gasBilled,
      tokenBilledNanos: tokenBilled,
      unbilledNanos: due - billed,
      balanceNanos: availableNanos(updated),
    };

    // 消费与收入的账都在请求表里：同一行既可验消费方 spend 链，也可验上游提供方 earn 链。
    await requestInsert(
      env,
      { ...row, tokenNanos: tokenDue, feeNanos: billed, unbilledNanos: settled.unbilledNanos },
      {
        gasBilledNanos: gasBilled,
        tokenBilledNanos: tokenBilled,
        spendBeforeNanos: totalSpendNanos(current),
        spendAfterNanos: totalSpendNanos(updated),
        earnBeforeNanos: earnBefore,
        earnAfterNanos: earnAfter,
      },
    ).run();
    return settled;
  }

  // 三次都被并发改写：宁可不扣不转，也不猜一个数。请求照样落库，账面上标成未收。
  const latest = await env.DB.prepare(`SELECT ${countersSql} FROM principals WHERE address = ?`)
    .bind(row.address)
    .first<PrincipalCounters>();
  await recordRequest(
    env,
    { ...row, tokenNanos: tokenDue, feeNanos: 0, unbilledNanos: due },
    latest ? totalSpendNanos(latest) : 0,
  );
  return {
    billedNanos: 0,
    gasBilledNanos: 0,
    tokenBilledNanos: 0,
    unbilledNanos: due,
    balanceNanos: latest ? availableNanos(latest) : 0,
  };
}

type SettlementTrail = {
  gasBilledNanos: number;
  tokenBilledNanos: number;
  spendBeforeNanos: number;
  spendAfterNanos: number;
  earnBeforeNanos: number;
  earnAfterNanos: number;
};

function requestInsert(env: Env, row: RequestRecord, trail: SettlementTrail) {
  return env.DB.prepare(
    `INSERT INTO requests
       (id, address, provider_id, provider_user, consumer_id, consumer_user, base_url, model, status, status_code, latency_ms,
        input_tokens, cached_tokens, output_tokens, audio_ms, audio_characters,
        image_count, image_pixels,
        gas_fee_nanos, gas_billed_nanos, token_nanos, token_billed_nanos, fee_nanos, unbilled_nanos,
        spend_before_nanos, spend_after_nanos, earn_before_nanos, earn_after_nanos, first_token_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.requestId,
    row.address,
    row.providerId,
    row.providerUser,
    row.consumerId,
    row.consumerUser,
    row.baseUrl,
    row.model,
    row.status,
    row.statusCode,
    row.latencyMs,
    row.inputTokens,
    row.cachedTokens,
    row.outputTokens,
    row.audioMs,
    row.audioCharacters,
    row.imageCount,
    row.imagePixels,
    row.gasFeeNanos,
    trail.gasBilledNanos,
    row.tokenNanos,
    trail.tokenBilledNanos,
    row.feeNanos,
    row.unbilledNanos,
    trail.spendBeforeNanos,
    trail.spendAfterNanos,
    trail.earnBeforeNanos,
    trail.earnAfterNanos,
    row.firstTokenMs,
    row.at,
  );
}
