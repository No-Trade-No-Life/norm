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
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（缺省用 wrangler 的 OAuth 登录态）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GAS_CPU_BASE_NANOS = 700;   // 与 src/gas.ts 的 cpu_base 一致（35 ms × 20 纳/CPU-ms）
const GAS_CPU_PER_KB_NANOS = 2;   // 与 src/gas.ts 的 cpu_per_kb 一致
const NANOS_PER_CPU_MS = 20;      // $0.02 / 1M CPU-ms
const BYTES_PER_TOKEN = 4;        // JSON 文本的粗略密度

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hours = Number(arg('hours', process.env.CPU_DRIFT_HOURS ?? 6));
const threshold = Number(arg('threshold', process.env.CPU_DRIFT_THRESHOLD ?? 0.2));
const asJson = process.argv.includes('--json');

const wranglerToken = () => {
  try {
    const text = readFileSync(join(homedir(), '.wrangler/config/default.toml'), 'utf8');
    return text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  } catch {
    return '';
  }
};
const token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken();
if (!token) {
  console.error('没有凭据：设置 CLOUDFLARE_API_TOKEN，或先 wrangler login');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return res.json();
};

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (await api('/accounts')).result?.[0]?.id;
if (!accountId) {
  console.error('拿不到 account id：设置 CLOUDFLARE_ACCOUNT_ID');
  process.exit(2);
}

const end = new Date();
const start = new Date(end.getTime() - hours * 3600_000);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const gql = await api('/graphql', {
  method: 'POST',
  body: JSON.stringify({
    query: `query($acc:String!,$s:Time!,$e:Time!){ viewer{ accounts(filter:{accountTag:$acc}){
      workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:$s,datetime_leq:$e,scriptName:"norm"}){
        sum{ requests cpuTimeUs } } } } }`,
    variables: { acc: accountId, s: iso(start), e: iso(end) },
  }),
});
if (gql.errors?.length) {
  console.error('GraphQL 失败:', JSON.stringify(gql.errors[0].message));
  process.exit(2);
}
const buckets = gql.data.viewer.accounts[0].workersInvocationsAdaptive;
const invocations = buckets.reduce((n, b) => n + b.sum.requests, 0);
const cpuUs = buckets.reduce((n, b) => n + b.sum.cpuTimeUs, 0);

// 体积只存在于账本里：把窗口内的 input_tokens 折成字节，再按 2 纳/KB 计
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
  threshold,
};

if (asJson) console.log(JSON.stringify(summary));
else {
  console.log(`${hours}h 窗口：${invocations} 次调用 / ${rows.n} 次推理，CF 实测 CPU ${(cpuUs / 1000).toFixed(1)} ms`);
  console.log(`应收 ${expectedNanos} 纳 vs 实测 ${actualNanos} 纳 → 系数 ${ratio.toFixed(2)}`);
  console.log(`建议：cpu_base ${GAS_CPU_BASE_NANOS} → ${summary.suggested_cpu_base}，cpu_per_kb ${GAS_CPU_PER_KB_NANOS} → ${summary.suggested_cpu_per_kb}`);
}

if (drift > threshold) {
  console.error(`✗ CPU 定额漂了：实测/应收 = ${ratio.toFixed(2)}（阈值 ±${threshold}）。按上面的「建议」改 src/gas.ts 的 cpu_base / cpu_per_kb。`);
  process.exit(1);
}
console.log('✓ CPU 定额在阈值内');
