/**
 * 端到端验证：起一个假上游，用真实 Ed25519 身份打真实 Worker（wrangler dev）。
 * 覆盖：开户、签名验签、nonce 重放、BYOK 转发（流式与非流式）、扣费与账本一致、来源核验。
 *
 * 用法：node scripts/e2e.mjs [http://127.0.0.1:8787]
 */
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const UPSTREAM_PORT = 9099;

const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function identity() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return { seed, address: base58.encode(ed25519.getPublicKey(seed)) };
}

function sign({ seed, address }, method, path, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const bodyBytes = enc.encode(body ?? '');
  const message = enc.encode(`norm-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${hex(sha256(bodyBytes))}`);
  return {
    'X-Norm-Address': address,
    'X-Norm-Timestamp': timestamp,
    'X-Norm-Nonce': nonce,
    'X-Norm-Signature': base58.encode(ed25519.sign(message, seed)),
  };
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

// ---- 假上游：一个只认 Bearer 的 OpenAI 兼容端点 ----
const upstream = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    if (request.headers.authorization !== 'Bearer sk-test-key') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    const parsed = JSON.parse(body || '{}');
    if (!parsed.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '你好' } }],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

const alice = identity();

console.log('1. 开户（签名即可，无注册）');
{
  const path = '/api/v1/auth/login';
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: sign(alice, 'POST', path) });
  const body = await response.json();
  check('login 200', response.status === 200, body);
  check('拿到演示授信 1000000 微美元', body.balance_micros === 1000000, body);
  check('address 与本地公钥一致', body.address === alice.address, body);
}

console.log('2. 无签名必须被拒');
{
  const response = await fetch(`${BASE}/api/v1/account/me`);
  check('未签名 401', response.status === 401, response.status);
}

console.log('3. nonce 重放必须被拒');
{
  const path = '/api/v1/account/me';
  const headers = sign(alice, 'GET', path);
  const first = await fetch(`${BASE}${path}`, { headers });
  const second = await fetch(`${BASE}${path}`, { headers });
  check('首次 200', first.status === 200, first.status);
  check('重放 401', second.status === 401, second.status);
  check('重放原因是 nonce_replayed', (await second.json()).error === 'nonce_replayed');
}

console.log('4. 请求体被篡改必须被拒（签名绑定 body）');
{
  const path = '/api/v1/credentials';
  const headers = sign(alice, 'POST', path, JSON.stringify({ label: 'a' }));
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'b' }),
  });
  check('篡改 body 401', response.status === 401, response.status);
}

console.log('5. 新建凭证（只上传密文）');
let credentialId;
{
  const path = '/api/v1/credentials';
  const payload = JSON.stringify({
    label: 'mock upstream',
    provider: 'openai',
    base_url: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    key_hint: 'sk-t…-key',
    sealed_key: base58.encode(crypto.getRandomValues(new Uint8Array(48))),
    kdf: 'pbkdf2-sha256-600000+xchacha20poly1305',
    declared_source: 'official-api-key',
  });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...sign(alice, 'POST', path, payload), 'Content-Type': 'application/json' },
    body: payload,
  });
  const body = await response.json();
  check('201', response.status === 201, body);
  credentialId = body.id;
  check('返回 credential id', typeof credentialId === 'string' && credentialId.startsWith('cred_'), body);
}

console.log('6. 明文密钥上游密钥不允许落库');
{
  const path = '/api/v1/credentials';
  const response = await fetch(`${BASE}${path}`, { headers: sign(alice, 'GET', path) });
  const body = await response.json();
  const raw = JSON.stringify(body);
  check('列表里没有明文密钥', !raw.includes('sk-test-key'));
  check('只暴露 key_hint', body.items[0].key_hint === 'sk-t…-key', body.items[0]);
}

console.log('7. 非流式转发 + 逐请求扣费');
{
  const path = '/v1/chat/completions';
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...sign(alice, 'POST', path, payload),
      'Content-Type': 'application/json',
      'X-Norm-Credential': credentialId,
      'X-Norm-Upstream-Key': 'sk-test-key',
    },
    body: payload,
  });
  const body = await response.json();
  check('200', response.status === 200, body);
  check('上游响应原样透传', body.choices?.[0]?.message?.content === '你好', body);
  check('附带 norm 元数据', body.norm?.request_id?.startsWith('req_'), body.norm);
  check('扣费 500 微美元', body.norm?.fee_micros === 500, body.norm);
  check('余额 999500', body.norm?.balance_micros === 999500, body.norm);
  check('来源核验结果随响应公开', body.norm?.provenance?.declared_source === 'official-api-key', body.norm?.provenance);
  check('非官方主机被判为未通过', body.norm?.provenance?.verified === false, body.norm?.provenance);
}

console.log('8. 流式转发 + 结尾补 norm 事件');
{
  const path = '/v1/chat/completions';
  const payload = JSON.stringify({ model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...sign(alice, 'POST', path, payload),
      'Content-Type': 'application/json',
      'X-Norm-Credential': credentialId,
      'X-Norm-Upstream-Key': 'sk-test-key',
    },
    body: payload,
  });
  const text = await response.text();
  check('200', response.status === 200, response.status);
  check('转发了两段 delta', text.includes('"你"') && text.includes('"好"'), text);
  check('结尾有 norm 事件', text.includes('"norm"'), text);
  check('流式也扣了费', text.includes('"fee_micros":500'), text);
}

console.log('9. 上游失败不扣费，但留一条诚实记录');
{
  const path = '/v1/chat/completions';
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...sign(alice, 'POST', path, payload),
      'Content-Type': 'application/json',
      'X-Norm-Credential': credentialId,
      'X-Norm-Upstream-Key': 'sk-wrong-key',
    },
    body: payload,
  });
  check('上游 401 原样返回', response.status === 401, response.status);
}

console.log('10. 账本与余额一致，且每条 charge 能回到请求');
{
  const mePath = '/api/v1/account/me';
  const me = await (await fetch(`${BASE}${mePath}`, { headers: sign(alice, 'GET', mePath) })).json();
  check('余额 999000（两次成功调用）', me.balance_micros === 999000, me);
  check('spend 1000', me.spend_micros === 1000, me);
  check('requests 3（含一次失败）', me.requests === 3, me);

  const ledgerPath = '/api/v1/account/ledger';
  const ledger = await (await fetch(`${BASE}${ledgerPath}`, { headers: sign(alice, 'GET', ledgerPath) })).json();
  const charges = ledger.items.filter((row) => row.kind === 'charge');
  check('两条 charge', charges.length === 2, charges);
  check('charge 都是负数', charges.every((row) => row.amount_micros === -500), charges);
  check('charge 都带 request_id', charges.every((row) => row.request_id?.startsWith('req_')), charges);
  const sum = ledger.items.reduce((total, row) => total + row.amount_micros, 0);
  check('流水求和 == 当前余额', sum === me.balance_micros, { sum, balance: me.balance_micros });
  check('最新一条流水的 balance_after 等于当前余额', ledger.items[0].balance_after_micros === me.balance_micros, ledger.items[0]);
}

console.log('11. 来源核验跟着真实调用刷新，并公开可见');
{
  const visPath = `/api/v1/credentials/${credentialId}/visibility`;
  const visPayload = JSON.stringify({ public_listed: true });
  const vis = await fetch(`${BASE}${visPath}`, {
    method: 'POST',
    headers: { ...sign(alice, 'POST', visPath, visPayload), 'Content-Type': 'application/json' },
    body: visPayload,
  });
  check('打开公开开关', vis.status === 200, vis.status);

  const listed = await (await fetch(`${BASE}/api/v1/provenance`)).json();
  const entry = listed.items.find((row) => row.id === credentialId);
  check('公开看板里能看到它', entry !== undefined, listed.items.length);
  // 创建时没有明文密钥，key_prefix 无从判断；真实调用之后它才变成 true。
  check('key_prefix 已由真实密钥补齐', entry?.provenance?.checks?.key_prefix === true, entry?.provenance?.checks);
  check('models_probe 已探测过', entry?.provenance?.checks?.models_probe === false, entry?.provenance?.checks);
  check('base_url 原文公开，供人自己重跑核验', entry?.base_url === `http://127.0.0.1:${UPSTREAM_PORT}/v1`, entry?.base_url);
}

console.log('12. 公开接口不需要签名');
{
  for (const path of ['/api/v1/health', '/api/v1/stats', '/api/v1/provenance', '/api/v1/attestation']) {
    const response = await fetch(`${BASE}${path}`);
    check(`${path} 200`, response.status === 200, response.status);
  }
}

upstream.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
