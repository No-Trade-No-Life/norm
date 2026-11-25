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
for (const path of ['/api/v1/health', '/api/v1/stats', '/api/v1/base-urls', '/api/v1/attestation']) {
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
  check('演示授信已到账', body.balance_nanos > 0, body);
}

console.log('2. 未签名与重放');
{
  check('未签名 401', (await fetch(`${BASE}/api/v1/account/me`)).status === 401);
  const headers = sign('GET', '/api/v1/account/me');
  check('首次 200', (await fetch(`${BASE}/api/v1/account/me`, { headers })).status === 200);
  check('重放 401', (await fetch(`${BASE}/api/v1/account/me`, { headers })).status === 401);
}

console.log('3. 新建上游提供商（明文密钥交给服务端封装）');
let providerId;
let consumerKey;
{
  const path = '/api/v1/providers';
  const payload = JSON.stringify({
    label: 'smoke',
    base_url: 'https://api.openai.com/v1',
    // 假密钥：它只会被用去打真·官方端点，用来验「失败只收 Gas」与「封装/解封跑得通」。
    provider_key: 'sk-invalid-smoke-key',
  });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...sign('POST', path, payload), 'Content-Type': 'application/json' },
    body: payload,
  });
  const body = await response.json();
  check('201', response.status === 201, body);
  providerId = body.id;

  // 列表里只能有提示，不能有明文。
  const listPath = '/api/v1/providers';
  const list = await (await fetch(`${BASE}${listPath}`, { headers: sign('GET', listPath) })).json();
  check('列表不含明文密钥', !JSON.stringify(list).includes('sk-invalid-smoke-key'), list);
  check('列表只回提示', typeof list.items?.[0]?.key_hint === 'string', list.items?.[0]);
}

console.log('4. 下游消费者 Token：只记名字、只显一次、能调用、能轮换');
{
  const path = '/api/v1/consumers';
  // Token 只有一个名字：走哪条上游提供商是转发时的决定，这个账户只有一条上游提供商，所以不必指名。
  const payload = JSON.stringify({ name: 'smoke bot' });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...sign('POST', path, payload), 'Content-Type': 'application/json' },
    body: payload,
  });
  const body = await response.json();
  check('创建 201', response.status === 201, body);
  consumerKey = body.key;
  check('明文形如 sk-norm-…', typeof consumerKey === 'string' && consumerKey.startsWith('sk-norm-'), consumerKey);

  const list = await (await fetch(`${BASE}${path}`, { headers: sign('GET', path) })).json();
  check('列表不含明文', !JSON.stringify(list).includes(consumerKey), list);

  // 一把下游密钥不该能进管理面：否则它就能再铸一把下游密钥。
  const escalate = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${consumerKey}`, 'Content-Type': 'application/json' },
    body: payload,
  });
  check('消费者密钥调管理面 401', escalate.status === 401, escalate.status);

  // 用消费者密钥打真·官方端点（假密钥）→ 上游提供商拒绝，但请求本身被受理了。
  const relayPath = '/v1/chat/completions';
  const relayBody = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  // 只带一个 Bearer：账户里只有一条上游提供商，探测到的 401 必须是上游提供商给的 401，
  // 而不是 Norm 的 400（那说明它还在等工作要一个额外的头）。
  const viaKey = await fetch(`${BASE}${relayPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${consumerKey}`, 'Content-Type': 'application/json' },
    body: relayBody,
  });
  check('一条 Bearer 就被转发面接受（上游提供商 401）', viaKey.status === 401, viaKey.status);

  const rotatePath = `/api/v1/consumers/${body.id}/rotate`;
  const rotated = await fetch(`${BASE}${rotatePath}`, { method: 'POST', headers: sign('POST', rotatePath) });
  const rotatedBody = await rotated.json();
  check('轮换给新明文', rotated.status === 200 && rotatedBody.key && rotatedBody.key !== consumerKey, rotatedBody);

  const stale = await fetch(`${BASE}${relayPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${consumerKey}`, 'Content-Type': 'application/json' },
    body: relayBody,
  });
  check('旧密钥立刻失效', stale.status === 401, stale.status);
}

console.log('5. 上游提供商拒绝时只收 Gas（假密钥打真·官方端点）');
{
  // 只比「这一次」的差额：前面那条 Bearer 调用（同样被上游 401 拒）也扣了 Gas。
  const before = (await (await fetch(`${BASE}/api/v1/account/me`, { headers: sign('GET', '/api/v1/account/me') })).json()).balance_nanos;
  const path = '/v1/chat/completions';
  const payload = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...sign('POST', path, payload),
      'Content-Type': 'application/json',
      'X-Norm-Provider': providerId,
    },
    body: payload,
  });
  check('上游提供商 401 原样返回', response.status === 401, response.status);
  const me = await (await fetch(`${BASE}/api/v1/account/me`, { headers: sign('GET', '/api/v1/account/me') })).json();
  check('这一次只扣 300 纳美元 Gas', me.balance_nanos === before - 300, { before, after: me.balance_nanos });
  check('但留下了失败记录', me.requests === 2, me);
}

console.log('6. 清理');
{
  const path = `/api/v1/providers/${providerId}`;
  const response = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: sign('DELETE', path) });
  check('撤销上游提供商 200', response.status === 200, response.status);
}

console.log(failures === 0 ? '\n线上冒烟全部通过' : `\n${failures} 项失败`);
console.log(`TEST_ADDRESS=${address}`);
process.exit(failures === 0 ? 0 : 1);
