#!/usr/bin/env node
/**
 * cpu-drift —— 校准 `gas.ts` 的 CPU 定额。
 *
 * Worker 自己读不到自己的 CPU（运行时只暴露墙钟），所以「实测」只能从外面取：
 * Cloudflare GraphQL 的 `workersInvocationsAdaptive.sum.cpuTimeUs` 是唯一可信的 CPU 总量。
 * 本脚本把「CF 实测」与「按 gas 表现行常数算出的应收」相除，漂出阈值就以非零码退出，
 * 交给终极机器的修复线程去改常数——改价永远走一次可审查的提交，不做运行时隐藏配置。
 *
 * 用法：
 *   node scripts/cpu-drift.mjs [--hours 6] [--threshold 0.2] [--json]
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（缺省用 wrangler 的 OAuth 登录态；
 *   OAuth 访问令牌只有一小时寿命，过期就先让 wrangler 续一次再读回来）
 *
 * 窗口内调用太少（<MIN_INVOCATIONS）时不判定、退出 0：没有流量就没有「实测 CPU」可比，
 * 拿空窗口报「漂了」只会叫醒一个无事可做的修复线程。
 *
 * 现行常数不在这里抄一份：直接读线上 `GET /api/v1/pricing` 的 `gas_fee.schedule`。
 * 抄一份的话，改价那天忘了改脚本就会拿两套价去比（#97 之后已经发生过一次），
 * 而真正决定收多少钱的只有线上那一份。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NORM_DIR = process.env.NORM_DIR ?? join(homedir(), 'Projects', 'norm');
const PRICING_URL = process.env.NORM_PRICING_URL ?? 'https://norm.ntnl.io/api/v1/pricing';
const WRANGLER_AUTH_FILE = process.env.WRANGLER_AUTH_FILE ?? join(homedir(), '.wrangler', 'config', 'default.toml');
const MIN_INVOCATIONS = 20;       // 少于这么多调用就不判定（空窗口没有信噪比）
const NANOS_PER_CPU_MS = 20;      // $0.02 / 1M CPU-ms
const BYTES_PER_TOKEN = 4;        // JSON 文本的粗略密度

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hours = Number(arg('hours', process.env.CPU_DRIFT_HOURS ?? 6));
const threshold = Number(arg('threshold', process.env.CPU_DRIFT_THRESHOLD ?? 0.2));
const asJson = process.argv.includes('--json');
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

// ── 凭据：wrangler 的 OAuth 访问令牌只有一小时寿命，而本脚本每 6 小时才跑一次 ──

/** wrangler 的登录态：令牌与过期时刻（读不到就给空值，交给下面判错）。 */
const wranglerAuth = () => {
  try {
    const text = readFileSync(WRANGLER_AUTH_FILE, 'utf8');
    return {
      token: text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] ?? '',
      expiresAt: Date.parse(text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] ?? '') || 0,
    };
  } catch {
    return { token: '', expiresAt: 0 };
  }
};

/**
 * 让 wrangler 自己续期登录态并写回配置，再读回来（任何 wrangler 命令都会顺手续期，
 * `whoami` 是最便宜的一条）。续不动说明 refresh token 也失效了，返回空串让调用方报错。
 */
const refreshWranglerAuth = () => {
  try {
    execFileSync('npx', ['wrangler', 'whoami'], {
      cwd: NORM_DIR,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` },
    });
  } catch {
    // 续期失败不在这里喊：下面读回配置，真没好就让请求把真实错误暴露出来
  }
  return wranglerAuth().token;
};

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
let token = apiToken || wranglerAuth().token;

/** 只有 OAuth 登录态能自愈：API token 过期或被吊销只能人去换。 */
const reauthorize = () => {
  if (apiToken) return false;
  const refreshed = refreshWranglerAuth();
  if (!refreshed || refreshed === token) return false;
  token = refreshed;
  return true;
};

// 存量令牌已过期（或 5 分钟内到期）就先续一次，省掉一次注定 401 的请求。
if (!apiToken && wranglerAuth().expiresAt <= Date.now() + 300_000) reauthorize();
if (!token) fail('没有凭据：设置 CLOUDFLARE_API_TOKEN，或先 wrangler login');

/** Cloudflare REST / GraphQL；`status` 留给调用方判断要不要续期重试。 */
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
};

/** 需要鉴权的调用：401 且是 OAuth 登录态时续期后重试一次。 */
const call = async (path, init) => {
  const first = await api(path, init);
  if (first.status !== 401 || !reauthorize()) return first;
  return api(path, init);
};

/**
 * account id：环境变量优先，否则问 `/accounts`。失败时把 API 的原话带出来——
 * 只喊「设置 CLOUDFLARE_ACCOUNT_ID」会把「登录态过期」这种真因盖掉。
 */
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
if (!accountId) {
  const listed = await call('/accounts');
  accountId = listed.success ? (listed.result?.[0]?.id ?? '') : '';
  if (!accountId) {
    fail(
      `拿不到 account id：${listed.errors?.[0]?.message ?? `HTTP ${listed.status}`}` +
        '（可设置 CLOUDFLARE_ACCOUNT_ID，或先 wrangler login）',
    );
  }
}

// ── 现行定额：线上价目表是权威来源 ──

/** 读线上 `gas_fee.schedule` 的 CPU 定额；读不到就失败退出（拿旧价去比毫无意义）。 */
const fetchSchedule = async () => {
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const schedule = (await res.json())?.gas_fee?.schedule;
      const base = Number(schedule?.cpu_base);
      const perKb = Number(schedule?.cpu_per_kb);
      if (!Number.isFinite(base) || !Number.isFinite(perKb) || base <= 0) {
        throw new Error('价目表里没有 cpu_base / cpu_per_kb');
      }
      return { base, perKb };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  fail(`读不到线上价目表（${PRICING_URL}）：${lastError}`);
};
const schedule = await fetchSchedule();
const GAS_CPU_BASE_NANOS = schedule.base;
const GAS_CPU_PER_KB_NANOS = schedule.perKb;

const end = new Date();
const start = new Date(end.getTime() - hours * 3600_000);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const gql = await call('/graphql', {
  method: 'POST',
  body: JSON.stringify({
    query: `query($acc:String!,$s:Time!,$e:Time!){ viewer{ accounts(filter:{accountTag:$acc}){
      workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:$s,datetime_leq:$e,scriptName:"norm"}){
        sum{ requests cpuTimeUs } } } } }`,
    variables: { acc: accountId, s: iso(start), e: iso(end) },
  }),
});
if (gql.errors?.length || !gql.data) {
  fail(`GraphQL 失败: ${JSON.stringify(gql.errors?.[0]?.message ?? `HTTP ${gql.status}`)}`);
}
const buckets = gql.data.viewer.accounts[0].workersInvocationsAdaptive;
const invocations = buckets.reduce((n, b) => n + b.sum.requests, 0);
const cpuUs = buckets.reduce((n, b) => n + b.sum.cpuTimeUs, 0);

// 空窗口 / 流量断档：没有调用就没有「实测 CPU」，判定不了定额是否漂移，直接跳过。
if (invocations < MIN_INVOCATIONS) {
  const skipped = { window_hours: hours, invocations, skipped: true };
  if (asJson) console.log(JSON.stringify(skipped));
  else console.log(`${hours}h 窗口内只有 ${invocations} 次调用（< ${MIN_INVOCATIONS}），样本不足，本轮不判定 CPU 定额。`);
  process.exit(0);
}

// 体积只存在于账本里：把窗口内的 input_tokens 折成字节，再按 cpu_per_kb 计
const epoch = Math.floor(start.getTime() / 1000);
const raw = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'norm', '--remote', '--json', '--command',
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS tok FROM requests WHERE created_at >= ${epoch}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);
const rows = JSON.parse(raw.slice(raw.indexOf('\n[\n') + 1))[0].results[0];

const actualNanos = Math.round((cpuUs / 1000) * NANOS_PER_CPU_MS); // cpuUs(µs) → ms → 纳
const kb = Math.ceil((rows.tok * BYTES_PER_TOKEN) / 1024);
const expectedNanos = invocations * GAS_CPU_BASE_NANOS + kb * GAS_CPU_PER_KB_NANOS;
const ratio = expectedNanos === 0 ? 0 : actualNanos / expectedNanos;
const drift = Math.abs(ratio - 1);

const summary = {
  window_hours: hours,
  invocations,
  inferences: rows.n,
  input_tokens: rows.tok,
  actual_cpu_ms: +(cpuUs / 1000).toFixed(1),
  actual_nanos: actualNanos,
  expected_nanos: expectedNanos,
  ratio: +ratio.toFixed(3),
  suggested_cpu_base: Math.round(GAS_CPU_BASE_NANOS * (ratio || 1)),
  suggested_cpu_per_kb: Math.max(1, Math.round(GAS_CPU_PER_KB_NANOS * (ratio || 1))),
  cpu_base: GAS_CPU_BASE_NANOS,
  cpu_per_kb: GAS_CPU_PER_KB_NANOS,
  threshold,
};

if (asJson) console.log(JSON.stringify(summary));
else {
  console.log(`${hours}h 窗口：${invocations} 次调用 / ${rows.n} 次推理，CF 实测 CPU ${(cpuUs / 1000).toFixed(1)} ms`);
  console.log(`线上定额（${PRICING_URL}）：cpu_base ${GAS_CPU_BASE_NANOS} / cpu_per_kb ${GAS_CPU_PER_KB_NANOS}`);
  console.log(`应收 ${expectedNanos} 纳 vs 实测 ${actualNanos} 纳 → 系数 ${ratio.toFixed(2)}`);
  console.log(`建议：cpu_base ${GAS_CPU_BASE_NANOS} → ${summary.suggested_cpu_base}，cpu_per_kb ${GAS_CPU_PER_KB_NANOS} → ${summary.suggested_cpu_per_kb}`);
}

if (drift > threshold) {
  console.error(`✗ CPU 定额漂了：实测/应收 = ${ratio.toFixed(2)}（阈值 ±${threshold}）。按上面的「建议」改 src/gas.ts 的 cpu_base / cpu_per_kb。`);
  process.exit(1);
}
console.log('✓ CPU 定额在阈值内');
