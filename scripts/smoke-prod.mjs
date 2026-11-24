/**
 * 线上冒烟：对 https://norm.ntnl.io 用一次性密钥走一遍真实链路。
 * 只碰公开接口与自己新建的账户，跑完由调用方清理（见 README 的 wrangler d1 execute）。
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const BASE = process.argv[2] ?? 'https://norm.ntnl.io';
const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const seed = crypto.getRandomValues(new Uint8Array(32));
const address = base58.encode(ed25519.getPublicKey(seed));

function sign(method, path, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const message = enc.encode(`norm-v1\n${method}\n${path}\n${timestamp}\n${nonce}\n${hex(sha256(enc.encode(body ?? '')))}`);
  return {
    'X-Norm-Address': address,
    'X-Norm-Timestamp': timestamp,
    'X-Norm-Nonce': nonce,
    'X-Norm-Signature': base58.encode(ed25519.sign(message, seed)),
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

console.log(`0. 公开接口（${BASE}）`);
for (const path of ['/api/v1/health', '/api/v1/stats', '/api/v1/provenance', '/api/v1/attestation']) {
  const response = await fetch(`${BASE}${path}`);
  check(`${path} 200`, response.status === 200, response.status);
}
const attestation = await (await fetch(`${BASE}/api/v1/attestation`)).json();
check('线上带上了构建哈希', typeof attestation.source_sha256 === 'string' && attestation.source_sha256.length === 64, attestation.source_sha256);

console.log('1. 开户');
{
  const response = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: sign('POST', '/api/v1/auth/login') });
  const body = await response.json();
  check('login 200', response.status === 200, body);
  check('地址与本地公钥一致', body.address === address, body);
  check('演示授信已到账', body.balance_micros === 1000000, body);
}

console.log('2. 未签名与重放');
{
  check('未签名 401', (await fetch(`${BASE}/api/v1/account/me`)).status === 401);
  const headers = sign('GET', '/api/v1/account/me');
  check('首次 200', (await fetch(`${BASE}/api/v1/account/me`, { headers })).status === 200);
  check('重放 401', (await fetch(`${BASE}/api/v1/account/me`, { headers })).status === 401);
}

console.log('3. 新建凭证（只上传密文）');
let credentialId;
{
  const path = '/api/v1/credentials';
  const payload = JSON.stringify({
    label: 'smoke',
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    key_hint: 'sk-s…moke',
    sealed_key: base58.encode(crypto.getRandomValues(new Uint8Array(48))),
    kdf: 'pbkdf2-sha256-600000+xchacha20poly1305',
    declared_source: 'official-api-key',
  });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...sign('POST', path, payload), 'Content-Type': 'application/json' },
    body: payload,
  });
  const body = await response.json();
  check('201', response.status === 201, body);
  credentialId = body.id;
}

console.log('4. 上游拒绝时不扣费（用一把假密钥打真·官方端点）');
{
  const path = '/v1/chat/completions';
  const payload = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...sign('POST', path, payload),
      'Content-Type': 'application/json',
      'X-Norm-Credential': credentialId,
      'X-Norm-Upstream-Key': 'sk-invalid-smoke-key',
    },
    body: payload,
  });
  check('上游 401 原样返回', response.status === 401, response.status);
  const me = await (await fetch(`${BASE}/api/v1/account/me`, { headers: sign('GET', '/api/v1/account/me') })).json();
  check('余额没被扣', me.balance_micros === 1000000, me);
  check('但留下了一条失败记录', me.requests === 1, me);
}

console.log('5. 清理');
{
  const path = `/api/v1/credentials/${credentialId}`;
  const response = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: sign('DELETE', path) });
  check('撤销凭证 200', response.status === 200, response.status);
}

console.log(failures === 0 ? '\n线上冒烟全部通过' : `\n${failures} 项失败`);
console.log(`TEST_ADDRESS=${address}`);
process.exit(failures === 0 ? 0 : 1);
