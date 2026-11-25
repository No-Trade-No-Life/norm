import type { Env } from './env';
import { type Protocol, type Visibility } from './protocols';
import { grantNanos } from './env';
import { isTrusted } from './base-urls';
import { affinityTtlSeconds } from './env';
import { fail } from './http';
import { nowSeconds, randomToken } from './ids';
import { affinityFresh, affinityHash, narrowToOwned, narrowToServingModel, pickByRendezvous, type AffinityKey } from './routing';

/**
 * 账户的四块累计数。每一块都只增不减，方向不同、含义不同：
 *
 *   充值   用户真的打进来的钱（可以提现）
 *   抵扣券 站点给的额度，比如演示授信（**不可提现**）
 *   消费   已经花掉的
 *   提现   已经拿走的
 *
 * 可用余额 = 充值 + 抵扣券 − 消费 − 提现。余额不落库，就是为了让它永远等于这个算式。
 */
export type PrincipalRow = {
  address: string;
  label: string;
  created_at: number;
  recharge_nanos: number;
  voucher_nanos: number;
  spend_nanos: number;
  withdraw_nanos: number;
};

/** 可用余额：唯一的算法，出现在页面、接口与扣费判断里，都是同一句。 */
export function availableNanos(counters: {
  recharge_nanos: number;
  voucher_nanos: number;
  spend_nanos: number;
  withdraw_nanos: number;
}): number {
  return counters.recharge_nanos + counters.voucher_nanos - counters.spend_nanos - counters.withdraw_nanos;
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
  kdf: string;
  // INVARIANT: 这两列只由 providers 路由写入，写入前已校验枚举；
  // 因此读出来一定是合法取值，不需要在每个调用点再判一次。
  protocol: Protocol;
  visibility: Visibility;
  /** private / pool。池子里的那条，所有账户都能在兜底时用到它。 */
  scope: ProviderScope;
  /** 1 = 参与选址；0 = 暂时不用。撤销（revoked_at）才是永久退场。 */
  enabled: number;
  public_listed: number;
  created_at: number;
  revoked_at: number | null;
};

/**
 * 地址第一次出现就开户并给演示授信。三条语句在同一个 batch 里，
 * 保证「给钱」与「记这笔钱」不会分叉；重复调用安全。
 */
export async function ensurePrincipal(env: Env, address: string, at: number): Promise<void> {
  const grant = grantNanos(env);
  await env.DB.batch([
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
      ...(mine ? {} : { key_hint: '', sealed_key: '' }),
    };
  });
}

export async function findProvider(env: Env, address: string, id: string): Promise<ProviderRow | null> {
  return env.DB.prepare('SELECT * FROM providers WHERE id = ? AND address = ? AND revoked_at IS NULL')
    .bind(id, address)
    .first<ProviderRow>();
}

/**
 * 一次调用的全部记账：扣钱、记流水、记请求，三步只描述同一件事。
 *
 * 余额的扣减用一条 `UPDATE ... MIN(?, balance)` 完成：扣掉的是「该付的」与「还剩下的」
 * 里较小的那个，返回值天然与并发隔离。为什么允许扣不满：上游提供商已经执行完了，
 * 这笔钱该记下来，而账不能变成负数——差的那部分记成 `unbilled_nanos`，
 * 由站点承担，并在页面上如实显示。
 *
 * 余额充足时 `unbilled_nanos` 恒为 0，`fee_nanos = gas_fee_nanos + token_nanos`。
 * 失败（上游提供商报错、网络不可达）也走这里：Gas 照收，token 那部分是 0。
 */

export type Settled = {
  /** 真正从余额里扣掉的数。 */
  billedNanos: number;
  /** 扣不满、由站点承担的部分。 */
  unbilledNanos: number;
  balanceNanos: number;
};

export type RequestRecord = {
  requestId: string;
  address: string;
  providerId: string | null;
  /** 收钱的那一方的地址（provider 的持有者）：公共池时与 address 不同。 */
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
  gasFeeNanos: number;
  tokenNanos: number;
  feeNanos: number;
  unbilledNanos: number;
  at: number;
};

/** 只写请求记录、不扣费：`settle` 三次都被并发改写时用它兜底，那一笔标成未收。 */
export async function recordRequest(env: Env, row: RequestRecord, spendNanos: number): Promise<void> {
  await requestInsert(env, row, spendNanos, spendNanos).run();
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
 * 写清单的 INSERT 每行 3 个变量，所以一条语句最多 33 行——取 30 留余量。
 * 这个数不是性能参数，是**正确性**参数：越过去就是整条写入失败，而它在
 * 「清单有多少条」这个维度上才暴露，夹具只有三五个模型时永远看不见。
 */
export const MODEL_ROWS_PER_STATEMENT = 30;

/** 问清单时的 IN (...) 宽度：一个模型名 + N 个上游 id，同样要留在 100 以内。 */
const MODEL_QUERY_CHUNK = 40;

/** 把一串模型名切成每次 INSERT 能装下的若干批。纯函数，方便钉住上面那条上限。 */
export function modelInsertChunks(names: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < names.length; start += MODEL_ROWS_PER_STATEMENT) {
    chunks.push(names.slice(start, start + MODEL_ROWS_PER_STATEMENT));
  }
  return chunks;
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

/**
 * 整份替换一条上游的清单。
 *
 * 替换而不是合并：清单是「它现在有什么」的事实，上游撤掉的型号不该在表里留下来。
 *
 * 空清单**不写**：一条 200 但不认识形状的回答，和「这家什么模型都没有」看起来一样，
 * 而前者真会发生（中转层回 `{}`）。旧快照至少是上一次的真话，不该被一次答不上话覆盖。
 * 抓取时刻与行一起写：两样合起来才是「知不知道」的完整答案。
 */
export async function recordProviderModels(
  env: Env,
  providerId: string,
  models: readonly string[],
  at: number,
): Promise<void> {
  const names = [...new Set(models.filter((name) => name.length > 0))];
  if (names.length === 0) return;

  const statements = [env.DB.prepare('DELETE FROM provider_models WHERE provider_id = ?').bind(providerId)];
  for (const chunk of modelInsertChunks(names)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO provider_models (provider_id, model, fetched_at)
         VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
         ON CONFLICT(provider_id, model) DO UPDATE SET fetched_at = excluded.fetched_at`,
      ).bind(...chunk.flatMap((name) => [providerId, name, at])),
    );
  }
  statements.push(env.DB.prepare('UPDATE providers SET models_fetched_at = ? WHERE id = ?').bind(at, providerId));
  await env.DB.batch(statements);
}

/** 上游自己说没有这个型号：把那一行划掉，下一次选址就不会再选到它。 */
export async function dropProviderModel(env: Env, providerId: string, model: string): Promise<void> {
  if (model.length === 0) return;
  await env.DB.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model = ?')
    .bind(providerId, model)
    .run();
}

/** 忘掉一条会话的粘性：这条路选错了，下一次重挑。 */
export async function forgetAffinity(env: Env, address: string, hash: string): Promise<void> {
  await env.DB.prepare('DELETE FROM affinities WHERE affinity_hash = ? AND address = ?').bind(hash, address).run();
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
  const pinned = await env.DB.prepare('SELECT provider_id, expires_at FROM affinities WHERE affinity_hash = ?')
    .bind(hash)
    .first<{ provider_id: string; expires_at: number }>();

  if (pinned && affinityFresh(pinned.expires_at, now)) {
    const hit = candidates.find((candidate) => candidate.id === pinned.provider_id);
    // 钉住的那条还在候选里才算命中。不在（禁用了、撤销了、自己的上游恢复把池子挤掉）
    // 就重挑——粘性是「尽量不搬家」，不是「宁可失败也不搬家」。
    if (hit) return { provider: hit, via: via(hit), sticky: true };
  }

  const chosen = pickByRendezvous(candidates, hash);
  await rememberAffinity(env, address, hash, chosen.id, now);
  return { provider: chosen, via: via(chosen), sticky: false };
}

/**
 * 写回亲和。只在「没记住 / 记住的不是这条 / 那条已过期」时才写：稳态下每个请求
 * 只多一次读，不额外写 D1。顺手清掉本账户的过期行，表因此不会无限长。
 */
async function rememberAffinity(
  env: Env,
  address: string,
  hash: string,
  providerId: string,
  now: number,
): Promise<void> {
  const ttl = affinityTtlSeconds(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM affinities WHERE address = ? AND expires_at <= ?').bind(address, now),
    env.DB.prepare(
      `INSERT INTO affinities (affinity_hash, address, provider_id, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(affinity_hash) DO UPDATE SET
         provider_id = excluded.provider_id,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    ).bind(hash, address, providerId, now + ttl, now),
  ]);
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
 * 扣费 + 流水 + 请求记录：一次调用的三件事，写在一起。
 *
 * 扣多少：该付多少就扣多少，余额不够时把剩下的全扣掉（余额落到 0），
 * 差的那部分记成 `unbilled_nanos` 由站点承担——上游提供商已经执行完了，账要记，
 * 但余额不能变成负数。
 *
 * 为什么是「先读再带条件更新」而不是一条 `UPDATE ... RETURNING`：
 * 我们需要知道**扣掉了多少**才能写流水，而 RETURNING 只给新余额，
 * 分不清「余额刚好够」与「余额不够」这两种都落到 0 的情况。
 * 于是用读到的累计消费做乐观并发条件（`spend_nanos = ?`），被并发改掉就重读重算。
 * 同一个账户同时打多个请求时才会撞上，最多重试 3 次。
 */
export async function settle(env: Env, row: RequestRecord): Promise<Settled> {
  const due = row.gasFeeNanos + row.tokenNanos;
  const counters = 'recharge_nanos, voucher_nanos, spend_nanos, withdraw_nanos';
  type Counters = { recharge_nanos: number; voucher_nanos: number; spend_nanos: number; withdraw_nanos: number };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await env.DB.prepare(`SELECT ${counters} FROM principals WHERE address = ?`)
      .bind(row.address)
      .first<Counters>();
    if (!current) throw new Error(`账户不存在：${row.address}`);

    // 能收多少收多少：余额不够时把剩下的花光，差额记成未收（站点承担）。
    const billed = Math.min(due, Math.max(availableNanos(current), 0));

    // 只往「累计消费」这一块上加，其余三块不动——四块累计数各自只增，
    // 条件更新盯住旧的 spend，被并发改过就重读重算，绝不覆盖别人的加法。
    const updated = await env.DB.prepare(
      `UPDATE principals SET spend_nanos = spend_nanos + ?
       WHERE address = ? AND spend_nanos = ?
       RETURNING ${counters}`,
    )
      .bind(billed, row.address, current.spend_nanos)
      .first<Counters>();
    if (!updated) continue;

    const settled: Settled = {
      billedNanos: billed,
      unbilledNanos: due - billed,
      balanceNanos: availableNanos(updated),
    };

    // 消费的账就在请求表里：这一笔之前 / 之后的累计消费 + 本笔的 fee，三者互相能验。
    await requestInsert(
      env,
      { ...row, feeNanos: billed, unbilledNanos: settled.unbilledNanos },
      current.spend_nanos,
      updated.spend_nanos,
    ).run();
    return settled;
  }

  // 三次都被并发改写：宁可不扣，也不猜一个数。请求照样落库，账面上标成未收。
  const latest = await env.DB.prepare(`SELECT ${counters} FROM principals WHERE address = ?`)
    .bind(row.address)
    .first<Counters>();
  await recordRequest(env, { ...row, feeNanos: 0, unbilledNanos: due }, latest?.spend_nanos ?? 0);
  return { billedNanos: 0, unbilledNanos: due, balanceNanos: latest ? availableNanos(latest) : 0 };
}

function requestInsert(env: Env, row: RequestRecord, spendBeforeNanos: number, spendAfterNanos: number) {
  return env.DB.prepare(
    `INSERT INTO requests
       (id, address, provider_id, provider_user, consumer_id, consumer_user, base_url, model, status, status_code, latency_ms,
        input_tokens, cached_tokens, output_tokens,
        gas_fee_nanos, token_nanos, fee_nanos, unbilled_nanos,
        spend_before_nanos, spend_after_nanos, first_token_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    row.gasFeeNanos,
    row.tokenNanos,
    row.feeNanos,
    row.unbilledNanos,
    spendBeforeNanos,
    spendAfterNanos,
    row.firstTokenMs,
    row.at,
  );
}
