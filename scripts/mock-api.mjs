#!/usr/bin/env node
/**
 * Norm mock API —— 无后端时的本地视觉核验用。
 *
 * 它按 docs/api.md 的形状返回数据，并且**真的验签**（docs/crypto.md 第 2 节）：
 * 前端签名写错了，这里会 401，比"看起来能跑"更早暴露问题。
 *
 *   node scripts/mock-api.mjs          # 监听 127.0.0.1:8787
 *   pnpm preview                       # 另一个终端；/api 与 /v1 由 vite 代理过来
 *
 * 数据是内存里的，重启即清空；每个地址第一次登录时注入一批假数据，方便看真实数据量下的排版。
 */
import { createServer } from 'node:http';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const PORT = Number(process.env.PORT ?? 8787);
const FEE_MICROS = 500;
const GRANT_MICROS = 1_000_000;

const encoder = new TextEncoder();

/** 演示口令：mock 扮演「一个用固定口令建过凭证的用户」，这样视觉核验才能真的走到解封与转发。 */
export const DEMO_PASSPHRASE = 'norm-demo';

/** docs/crypto.md 第 3 节，与 web/src/byok.ts 同一算法——服务端只是存密文，解封在浏览器。 */
function sealDemoUpstreamKey(address, upstreamKey) {
  const key = pbkdf2(sha256, encoder.encode(DEMO_PASSPHRASE), encoder.encode(`norm-v1|${address}`), { c: 600_000, dkLen: 32 });
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const sealed = xchacha20poly1305(key, nonce, encoder.encode(address)).encrypt(encoder.encode(upstreamKey));
  const packed = new Uint8Array(24 + sealed.length);
  packed.set(nonce, 0);
  packed.set(sealed, 24);
  return base58.encode(packed);
}

/** address → 账户状态 */
const accounts = new Map();
const nonces = new Set();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function token(bytes = 16) {
  return base58.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function signingMessage({ method, path, timestamp, nonce, bodySha256Hex }) {
  return encoder.encode(`norm-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodySha256Hex}`);
}

function sha256Hex(bytes) {
  return [...sha256(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res, status, code, message) {
  json(res, status, { error: code, message });
}

/** 前端签名对不对，这里说了算：任何一步不对都 401，并在消息里指出是哪一步。 */
function authenticate(req, path, rawBody) {
  const address = req.headers['x-norm-address'];
  const timestamp = req.headers['x-norm-timestamp'];
  const nonce = req.headers['x-norm-nonce'];
  const signature = req.headers['x-norm-signature'];
  if (!address || !timestamp || !nonce || !signature) return { error: [401, 'signature_required', '缺少签名头'] };
  if (!Number.isInteger(Number(timestamp)) || Math.abs(nowSeconds() - Number(timestamp)) > 120) {
    return { error: [401, 'timestamp_out_of_window', '时间戳超出 ±120s'] };
  }
  const message = signingMessage({
    method: req.method,
    path,
    timestamp: String(timestamp),
    nonce: String(nonce),
    bodySha256Hex: sha256Hex(rawBody),
  });
  let publicKey;
  let sig;
  try {
    publicKey = base58.decode(String(address));
    sig = base58.decode(String(signature));
  } catch {
    return { error: [401, 'signature_invalid', 'base58 解码失败'] };
  }
  if (publicKey.length !== 32 || sig.length !== 64) return { error: [401, 'signature_invalid', '公钥或签名长度不对'] };
  let ok = false;
  try {
    ok = ed25519.verify(sig, message, publicKey);
  } catch {
    ok = false;
  }
  if (!ok) return { error: [401, 'signature_invalid', `签名不匹配（${req.method} ${path}）`] };
  const key = `${address}:${nonce}`;
  if (nonces.has(key)) return { error: [401, 'nonce_replayed', 'nonce 已经用过了'] };
  nonces.add(key);
  return { address: String(address) };
}

const SOURCES = ['official-api-key', 'official-subscription', 'self-hosted', 'other'];
const HOSTS = {
  openai: ['api.openai.com'],
  deepseek: ['api.deepseek.com'],
  anthropic: ['api.anthropic.com'],
  google: ['generativelanguage.googleapis.com'],
};

/** 与 src/provenance.ts 同义的信号核验；这里只看 base_url 与伪造的前缀信号。 */
function provenanceOf({ provider, baseUrl, declaredSource, keyPrefixHit }) {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = '';
  }
  const hostHit = (HOSTS[provider] ?? []).includes(host);
  const relevant = declaredSource === 'official-api-key' || declaredSource === 'official-subscription';
  const signals = [];
  if (hostHit) signals.push('host');
  if (keyPrefixHit) signals.push('key_prefix');
  return {
    declared_source: declaredSource,
    verified: relevant ? hostHit && keyPrefixHit : hostHit,
    signals,
    checks: { host: hostHit, key_prefix: keyPrefixHit, models_probe: keyPrefixHit ? true : null },
    host,
    checked_at: nowSeconds() - 900,
    note: relevant ? '声明为官方来源' : '非官方来源：主机表不适用，只公开 base_url 供人工核对',
  };
}

const CREDENTIAL_SEEDS = [
  { label: 'OpenAI 个人', provider: 'openai', base_url: 'https://api.openai.com/v1', source: 'official-api-key', hint: 'sk-p…9f2a', prefix: true },
  { label: 'DeepSeek 主力', provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', source: 'official-api-key', hint: 'sk-8…c41d', prefix: true },
  { label: 'Anthropic 订阅', provider: 'anthropic', base_url: 'https://api.anthropic.com/v1', source: 'official-subscription', hint: 'sk-a…7b30', prefix: true },
  { label: '中转：某宝 8 折池', provider: 'openai', base_url: 'https://api.cheap-relay.example.com/v1', source: 'official-api-key', hint: 'sk-p…9f2a', prefix: true },
  { label: '自建 vLLM（4090）', provider: 'self-hosted', base_url: 'https://llm.home.arpa/v1', source: 'self-hosted', hint: 'sk-l…0011', prefix: true },
  { label: 'Google AI Studio', provider: 'google', base_url: 'https://generativelanguage.googleapis.com/v1beta', source: 'official-api-key', hint: 'AIza…Kd9Q', prefix: true },
  { label: '另一家中转（存疑）', provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', source: 'official-api-key', hint: 'ds-p…4410', prefix: false },
];

const MODELS = ['gpt-4o-mini', 'deepseek-chat', 'claude-3-5-haiku-latest', 'gemini-2.0-flash', 'gpt-4o'];

function seedAccount(address) {
  const credentials = CREDENTIAL_SEEDS.map((seed, index) => {
    const id = `cred_mock${String(index + 1).padStart(2, '0')}`;
    const provenance = provenanceOf({
      provider: seed.provider,
      baseUrl: seed.base_url,
      declaredSource: seed.source,
      keyPrefixHit: seed.prefix,
    });
    return {
      id,
      address,
      label: seed.label,
      provider: seed.provider,
      base_url: seed.base_url,
      key_hint: seed.hint,
      sealed_key: sealDemoUpstreamKey(address, `sk-mock-${seed.provider}-${index}`),
      kdf: 'pbkdf2-sha256-600000+xchacha20poly1305',
      declared_source: seed.source,
      public_listed: index < 5 ? 1 : 0,
      provenance: JSON.stringify(provenance),
      created_at: nowSeconds() - 86_400 * (12 - index),
      revoked_at: null,
    };
  });

  const requests = [];
  const ledger = [{ id: token(), address, request_id: null, kind: 'grant', amount_micros: GRANT_MICROS, balance_after_micros: GRANT_MICROS, created_at: nowSeconds() - 86_400 * 12 }];
  let balance = GRANT_MICROS;
  let spend = 0;
  for (let index = 0; index < 45; index += 1) {
    const failed = index % 9 === 4;
    const fee = failed ? 0 : FEE_MICROS;
    const created = nowSeconds() - index * 640;
    const id = `req_mock${String(45 - index).padStart(3, '0')}`;
    const credential = credentials[index % credentials.length];
    requests.push({
      id,
      address,
      credential_id: credential.id,
      model: MODELS[index % MODELS.length],
      status: failed ? 'upstream_error' : 'ok',
      status_code: failed ? 429 : 200,
      latency_ms: 240 + ((index * 137) % 2600),
      prompt_tokens: 120 + ((index * 37) % 900),
      completion_tokens: failed ? 0 : 40 + ((index * 53) % 600),
      fee_micros: fee,
      provenance: credential.provenance,
      created_at: created,
    });
    if (fee > 0) {
      balance -= fee;
      spend += fee;
      ledger.push({ id: token(), address, request_id: id, kind: 'charge', amount_micros: -fee, balance_after_micros: balance, created_at: created });
    }
  }

  accounts.set(address, {
    address,
    label: '',
    balance_micros: balance,
    granted_micros: GRANT_MICROS,
    spend_micros: spend,
    created_at: nowSeconds() - 86_400 * 12,
    credentials,
    requests,
    ledger,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const STREAM_REPLY = [
  'Norm 只做一件事：把请求原样转给你自己声明的上游，然后诚实地记一笔账。',
  '\n\n这段文字是流式返回的，逐字符到达。你看到的字来自 mock 上游，',
  '底下的 norm 元数据来自这次调用的记账结果。',
];

async function relay(req, res, account, body) {
  const credentialId = req.headers['x-norm-credential'];
  const upstreamKey = req.headers['x-norm-upstream-key'];
  if (!upstreamKey) return fail(res, 400, 'upstream_key_required', '缺少 X-Norm-Upstream-Key');
  const credential = account.credentials.find((item) => item.id === credentialId);
  if (!credential) return fail(res, 404, 'credential_not_found', '凭证不存在或已撤销');

  const requestId = `req_${token(12)}`;
  const startedAt = Date.now();
  const parsed = JSON.parse(body.toString('utf8'));
  const model = parsed.model || 'unknown-model';

  if (String(model).includes('fail')) {
    return fail(res, 502, 'upstream_unreachable', '上游不可达（mock：模型名里含 fail 就走失败路径）');
  }

  const provenance = JSON.parse(credential.provenance);

  if (parsed.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Norm-Request-Id': requestId });
    for (const piece of STREAM_REPLY) {
      for (const char of [...piece]) {
        sse(res, { id: 'chatcmpl-mock', model, choices: [{ delta: { content: char }, finish_reason: null }] });
        await new Promise((resolve) => setTimeout(resolve, 6));
      }
    }
    account.balance_micros -= FEE_MICROS;
    account.spend_micros += FEE_MICROS;
    const meta = {
      request_id: requestId,
      fee_micros: FEE_MICROS,
      balance_micros: account.balance_micros,
      latency_ms: Date.now() - startedAt,
      provenance: { declared_source: credential.declared_source, verified: provenance.verified, signals: provenance.signals, host: provenance.host },
    };
    sse(res, { norm: meta });
    res.write('data: [DONE]\n\n');
    res.end();
    account.requests.unshift({
      id: requestId,
      address: account.address,
      credential_id: credential.id,
      model,
      status: 'ok',
      status_code: 200,
      latency_ms: meta.latency_ms,
      prompt_tokens: 42,
      completion_tokens: STREAM_REPLY.join('').length,
      fee_micros: FEE_MICROS,
      provenance: credential.provenance,
      created_at: nowSeconds(),
    });
    account.ledger.unshift({ id: token(), address: account.address, request_id: requestId, kind: 'charge', amount_micros: -FEE_MICROS, balance_after_micros: account.balance_micros, created_at: nowSeconds() });
    return;
  }

  account.balance_micros -= FEE_MICROS;
  account.spend_micros += FEE_MICROS;
  return json(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: STREAM_REPLY.join('') }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 96 },
    norm: {
      request_id: requestId,
      fee_micros: FEE_MICROS,
      balance_micros: account.balance_micros,
      latency_ms: Date.now() - startedAt,
      provenance: { declared_source: credential.declared_source, verified: provenance.verified, signals: provenance.signals, host: provenance.host },
    },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const body = await readBody(req);

  try {
    if (req.method === 'GET' && path === '/api/v1/health') {
      return json(res, 200, { ok: true, service: 'norm', version: '0.1.0-mock', now: nowSeconds() });
    }

    if (req.method === 'GET' && path === '/api/v1/stats') {
      const list = [...accounts.values()];
      return json(res, 200, {
        principals: list.length,
        credentials: list.reduce((sum, item) => sum + item.credentials.length, 0),
        requests: list.reduce((sum, item) => sum + item.requests.length, 0),
        spend_micros: list.reduce((sum, item) => sum + item.spend_micros, 0),
        window_hours: null,
      });
    }

    if (req.method === 'GET' && path === '/api/v1/provenance') {
      // 公开看板：所有账号里打开公开开关的凭证合并展示。
      const items = [...accounts.values()].flatMap((account) =>
        account.credentials
          .filter((item) => item.public_listed === 1)
          .map((item) => ({
            id: item.id,
            label: item.label,
            provider: item.provider,
            base_url: item.base_url,
            key_hint: item.key_hint,
            declared_source: item.declared_source,
            provenance: JSON.parse(item.provenance),
            created_at: item.created_at,
          })),
      );
      return json(res, 200, { items });
    }

    if (req.method === 'GET' && path === '/api/v1/attestation') {
      return json(res, 200, {
        service: 'norm',
        repository: 'https://github.com/No-Trade-No-Life/norm',
        commit: 'd34cd72a1b6f5c8e9d0f4a7b2c3d5e6f70819a2b',
        built_at: '2026-11-24T12:04:11Z',
        source_sha256: 'b7f0c2d9e5a41f83c6b20d7e9a4c1f5b83d6e0a27c4f19b5d8e3a6c0f2b7d914',
        assets_sha256: '4a1e9c7d2b83f5061e4d8a3c9b7f20d56a3e1c8b4f97d2e60c5a8b3f1d7e9c24',
        run_url: 'https://github.com/No-Trade-No-Life/norm/actions/runs/12345678901',
        policy: {
          logs: '不留请求体、不留响应体、不留上游密钥',
          storage: 'D1 只存记账所需的最小字段（模型名、token 数、状态、延迟、费用）',
          keys: '上游密钥只在请求头里经过，不落库；库里只有客户端加密后的密文',
        },
      });
    }

    if (req.method === 'POST' && path === '/api/v1/auth/login') {
      const auth = authenticate(req, path, body);
      if (auth.error) return fail(res, ...auth.error);
      const created = !accounts.has(auth.address);
      if (created) seedAccount(auth.address);
      const account = accounts.get(auth.address);
      return json(res, 200, { address: account.address, balance_micros: account.balance_micros, created });
    }

    const auth = authenticate(req, path, body);
    if (auth.error) return fail(res, ...auth.error);
    const account = accounts.get(auth.address);
    if (!account) return fail(res, 401, 'unknown_principal', '请先登录');

    if (req.method === 'GET' && path === '/api/v1/account/me') {
      return json(res, 200, {
        address: account.address,
        label: account.label,
        balance_micros: account.balance_micros,
        granted_micros: account.granted_micros,
        spend_micros: account.spend_micros,
        requests: account.requests.length,
        credentials: account.credentials.filter((item) => !item.revoked_at).length,
        created_at: account.created_at,
      });
    }

    if (req.method === 'GET' && path === '/api/v1/account/usage') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
      return json(res, 200, { items: account.requests.slice(0, limit) });
    }

    if (req.method === 'GET' && path === '/api/v1/account/ledger') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
      return json(res, 200, { items: account.ledger.slice(0, limit) });
    }

    if (req.method === 'GET' && path === '/api/v1/credentials') {
      return json(res, 200, { items: account.credentials.filter((item) => !item.revoked_at) });
    }

    if (req.method === 'POST' && path === '/api/v1/credentials') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      if (!payload.sealed_key) return fail(res, 400, 'sealed_key_missing', '缺少密文；明文密钥不允许上传');
      if (String(payload.sealed_key).includes('sk-live-')) {
        return fail(res, 400, 'plaintext_key_detected', 'mock：请求体里出现了明文密钥形态的字符串');
      }
      const provenance = provenanceOf({
        provider: payload.provider,
        baseUrl: payload.base_url,
        declaredSource: payload.declared_source,
        keyPrefixHit: String(payload.key_hint ?? '').startsWith('sk-') || String(payload.key_hint ?? '').startsWith('AIza'),
      });
      const item = {
        id: `cred_${token(12)}`,
        address: account.address,
        label: payload.label || payload.provider,
        provider: payload.provider,
        base_url: payload.base_url,
        key_hint: payload.key_hint ?? '••••',
        sealed_key: payload.sealed_key,
        kdf: payload.kdf,
        declared_source: payload.declared_source,
        public_listed: 0,
        provenance: JSON.stringify(provenance),
        created_at: nowSeconds(),
        revoked_at: null,
      };
      account.credentials.unshift(item);
      return json(res, 201, { id: item.id });
    }

    const visibility = path.match(/^\/api\/v1\/credentials\/([^/]+)\/visibility$/);
    if (req.method === 'POST' && visibility) {
      const item = account.credentials.find((credential) => credential.id === visibility[1]);
      if (!item) return fail(res, 404, 'credential_not_found', '凭证不存在或已撤销');
      const payload = JSON.parse(body.toString('utf8') || '{}');
      item.public_listed = payload.public_listed ? 1 : 0;
      return json(res, 200, { id: item.id, public_listed: item.public_listed });
    }

    const revoke = path.match(/^\/api\/v1\/credentials\/([^/]+)$/);
    if (req.method === 'DELETE' && revoke) {
      const item = account.credentials.find((credential) => credential.id === revoke[1]);
      if (!item) return fail(res, 404, 'credential_not_found', '凭证不存在或已撤销');
      item.revoked_at = nowSeconds();
      return json(res, 200, { id: item.id, revoked: true });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return await relay(req, res, account, body);
    }

    return fail(res, 404, 'not_found', `没有这个接口：${path}`);
  } catch (error) {
    console.error('mock error', error);
    return fail(res, 500, 'internal_error', String(error?.message ?? error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`norm mock api on http://127.0.0.1:${PORT}`);
});
