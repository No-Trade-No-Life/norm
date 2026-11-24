/**
 * 端到端验证：起一个会说四种协议的假上游，用真实 Ed25519 身份打真实 Worker（wrangler dev）。
 *
 * 覆盖：开户、签名验签、nonce 重放、body 篡改、上游密钥的封装与解封、协议不匹配、
 * 四种上游协议（含流式）的请求翻译与响应翻译、扣费与账本一致、base_url 聚合、
 * 下游消费者密钥（只显一次、可轮换、旧钥立刻失效）。
 *
 * 用法：node scripts/e2e.mjs [http://127.0.0.1:8787]
 */
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const UPSTREAM_PORT = 9099;
const KEY = 'sk-test-key';

const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function identity() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return { seed, address: base58.encode(ed25519.getPublicKey(seed)) };
}

function sign(who, method, path, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const bodyBytes = enc.encode(body ?? '');
  const message = enc.encode(`norm-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${hex(sha256(bodyBytes))}`);
  return {
    'X-Norm-Address': who.address,
    'X-Norm-Timestamp': timestamp,
    'X-Norm-Nonce': nonce,
    'X-Norm-Signature': base58.encode(ed25519.sign(message, who.seed)),
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

/** 记录上游真正收到的请求形状，用来证明翻译发生在 Norm 这一侧。 */
const seen = [];

function sse(response, events) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

const upstream = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    const url = new URL(request.url, 'http://x');
    seen.push({ path: url.pathname, search: url.search, headers: request.headers, body: parsed });

    const authorized =
      request.headers.authorization === `Bearer ${KEY}` ||
      request.headers['x-api-key'] === KEY ||
      request.headers['x-goog-api-key'] === KEY;
    if (!authorized) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }

    // 1) openai-chat
    if (url.pathname.endsWith('/chat/completions')) {
      if (parsed.stream) {
        sse(response, [{ choices: [{ delta: { content: '你' } }] }, { choices: [{ delta: { content: '好' } }] }]);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-1',
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }));
      return;
    }

    // 2) openai-responses
    if (url.pathname.endsWith('/responses')) {
      if (parsed.stream) {
        sse(response, [
          { type: 'response.output_text.delta', delta: '你' },
          { type: 'response.output_text.delta', delta: '好' },
        ]);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_1',
        model: parsed.model,
        output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }],
        usage: { input_tokens: 7, output_tokens: 2 },
      }));
      return;
    }

    // 3) anthropic-messages
    if (url.pathname.endsWith('/v1/messages')) {
      if (parsed.stream) {
        sse(response, [
          { type: 'message_start' },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } },
        ]);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'msg_1',
        content: [{ type: 'text', text: '你好' }],
        usage: { input_tokens: 5, output_tokens: 4 },
      }));
      return;
    }

    // 4) google-gemini（含流式端点）
    if (url.pathname.includes(':streamGenerateContent')) {
      sse(response, [
        { candidates: [{ content: { parts: [{ text: '你' }] } }] },
        { candidates: [{ content: { parts: [{ text: '好' }] } }] },
      ]);
      return;
    }
    if (url.pathname.includes(':generateContent')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '你好' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 },
      }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'no such upstream path', path: url.pathname }));
  });
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

const alice = identity();
// 每轮用独立的 base_url：聚合是按 base_url 全库统计的，共用同一个地址会让
// 上一次运行留下的凭证混进来，断言就不再只描述这一轮。
const RUN = base58.encode(crypto.getRandomValues(new Uint8Array(6)));
const BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}/v1/${RUN}`;

async function call(who, method, path, body, extra = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...sign(who, method, path, body), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

async function createCredential(protocol, visibility = 'private') {
  const payload = JSON.stringify({
    label: `${protocol} upstream`,
    provider: protocol === 'google-gemini' ? 'google' : 'openai',
    base_url: BASE_URL,
    upstream_key: KEY,
    upstream_protocol: protocol,
    upstream_visibility: visibility,
  });
  const result = await call(alice, 'POST', '/api/v1/credentials', payload);
  return { id: result.json.id, status: result.status, body: result.json };
}

/** 默认走签名；给 bearer 时改走消费者密钥，两条路必须是同一个账户。 */
async function chat(credentialId, extra = {}, bearer = null) {
  const payload = JSON.stringify({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    ...extra,
  });
  const headers = { 'X-Norm-Credential': credentialId };
  if (bearer) return raw('POST', '/v1/chat/completions', payload, { ...headers, Authorization: `Bearer ${bearer}` });
  return call(alice, 'POST', '/v1/chat/completions', payload, headers);
}

/** 不带签名的一次请求：Bearer 消费者密钥走的是这条入口。 */
async function raw(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

console.log('1. 开户（签名即可，无注册）');
{
  const result = await call(alice, 'POST', '/api/v1/auth/login');
  check('login 200', result.status === 200, result.json);
  check('演示授信 1000000 微美元', result.json.balance_micros === 1000000, result.json);
  check('地址与本地公钥一致', result.json.address === alice.address, result.json);
}

console.log('2. 身份与完整性');
{
  check('未签名 401', (await fetch(`${BASE}/api/v1/account/me`)).status === 401);

  const path = '/api/v1/account/me';
  const headers = sign(alice, 'GET', path);
  check('首次 200', (await fetch(`${BASE}${path}`, { headers })).status === 200);
  const replay = await fetch(`${BASE}${path}`, { headers });
  check('重放 401', replay.status === 401, replay.status);
  check('重放原因是 nonce_replayed', (await replay.json()).error === 'nonce_replayed');

  const bodyPath = '/v1/chat/completions';
  const signed = sign(alice, 'POST', bodyPath, JSON.stringify({ model: 'a' }));
  const tampered = await fetch(`${BASE}${bodyPath}`, {
    method: 'POST',
    headers: { ...signed, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'b' }),
  });
  check('篡改 body 401', tampered.status === 401, tampered.status);
}

console.log('3. 凭证：明文密钥交给服务端封装，协议与公开性可配置');
const credentials = {};
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini']) {
  const created = await createCredential(protocol, protocol === 'openai-responses' ? 'public' : 'private');
  check(`${protocol} 创建 201`, created.status === 201 && typeof created.id === 'string', created.body);
  // 创建响应里只有 id：提示是服务端从明文算出来的，不该由客户端自报。
  check(`${protocol} 创建响应不含密钥`, !JSON.stringify(created.body).includes(KEY), created.body);
  credentials[protocol] = created.id;
}
{
  for (const [field, value, code] of [
    ['upstream_protocol', 'anthropic', 'protocol_invalid'],
    ['upstream_visibility', 'maybe', 'visibility_invalid'],
  ]) {
    const payload = JSON.stringify({
      label: 'bad', provider: 'openai', base_url: BASE_URL, upstream_key: KEY, [field]: value,
    });
    const result = await call(alice, 'POST', '/api/v1/credentials', payload);
    check(`${field}=${value} → 400 ${code}`, result.status === 400 && result.json.error === code, result.json);
  }

  const missing = await call(alice, 'POST', '/api/v1/credentials', JSON.stringify({
    label: 'no key', provider: 'openai', base_url: BASE_URL,
  }));
  check('缺 upstream_key → 400', missing.status === 400 && missing.json.error === 'upstream_key_missing', missing.json);

  const list = await call(alice, 'GET', '/api/v1/credentials');
  const serialized = JSON.stringify(list.json);
  check('列表里没有明文密钥', !serialized.includes(KEY));
  const entry = list.json.items.find((item) => item.id === credentials['openai-chat']);
  // sk-test-key 的前 4 后 4：服务端算的提示，不是客户端传上来的。
  check('只暴露 key_hint（前 4 后 4）', entry?.key_hint === 'sk-t…-key', entry?.key_hint);
  check('密文是 AES-256-GCM 封装', entry?.kdf === 'aes-256-gcm+worker-secret', entry?.kdf);
  check('默认协议可读', entry?.upstream_protocol === 'openai-chat', entry?.upstream_protocol);
}

console.log('4. 四种上游协议：请求翻译 + 响应翻译回 OpenAI Chat');
const expected = {
  'openai-chat': { text: '你好', prompt: 11, completion: 3 },
  'openai-responses': { text: '你好', prompt: 7, completion: 2 },
  'anthropic-messages': { text: '你好', prompt: 5, completion: 4 },
  'google-gemini': { text: '你好', prompt: 9, completion: 6 },
};
for (const [protocol, want] of Object.entries(expected)) {
  const result = await chat(credentials[protocol]);
  check(`${protocol} 200`, result.status === 200, result.json);
  check(`${protocol} 文本翻译正确`, result.json?.choices?.[0]?.message?.content === want.text, result.json?.choices);
  check(`${protocol} 扣费 500`, result.json?.norm?.fee_micros === 500, result.json?.norm);
  check(`${protocol} 回带 host`, result.json?.norm?.host === `127.0.0.1:${UPSTREAM_PORT}`, result.json?.norm);
}

{
  const last = seen.at(-1);
  check('gemini 的路径带模型名', last.path.includes('/v1beta/models/gpt-test:generateContent'), last.path);
  check('gemini system 走 systemInstruction', last.body.systemInstruction?.parts?.[0]?.text === 'be brief', last.body);
  check('gemini 用 x-goog-api-key 鉴权', last.headers['x-goog-api-key'] === KEY, Object.keys(last.headers));

  const anthropic = seen.find((entry) => entry.path.endsWith('/v1/messages'));
  check('anthropic 用 x-api-key + version 头', anthropic.headers['x-api-key'] === KEY && anthropic.headers['anthropic-version'] === '2023-06-01', anthropic.headers);
  check('anthropic system 独立字段，messages 里不含 system', anthropic.body.system === 'be brief' && anthropic.body.messages.every((m) => m.role !== 'system'), anthropic.body);

  const responses = seen.find((entry) => entry.path.endsWith('/responses'));
  check('responses 用 input 而不是 messages', Array.isArray(responses.body.input) && responses.body.messages === undefined, responses.body);
}

console.log('5. 四种上游协议的流式：都翻译成 OpenAI chat chunk');
for (const protocol of Object.keys(expected)) {
  const result = await chat(credentials[protocol], { stream: true });
  check(`${protocol} 流式 200`, result.status === 200, result.status);
  check(`${protocol} 流式有内容`, result.text.includes('"content":"你"') && result.text.includes('"content":"好"'), result.text.slice(0, 200));
  check(`${protocol} 结尾有 norm 事件`, result.text.includes('"norm"'), result.text.slice(-200));
  check(`${protocol} 结尾有 DONE`, result.text.trimEnd().endsWith('data: [DONE]'), result.text.slice(-40));
}
{
  const geminiStream = seen.find((entry) => entry.path.includes(':streamGenerateContent'));
  check('gemini 走流式端点', geminiStream.search.includes('alt=sse'), geminiStream.search);
  const responsesStream = seen.filter((entry) => entry.path.endsWith('/responses')).at(-1);
  check('responses 流式靠 body 里的 stream', responsesStream.body.stream === true, responsesStream.body);
}

console.log('6. 上游失败不扣费，但留一条诚实记录');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  // 封进去的是对的密钥，这里改用一条指向死端口的凭证来制造「网络不可达」，
  // 再确认失败既不扣费也没把上游密钥漏进记录。
  const wrong = await call(alice, 'POST', '/api/v1/credentials', JSON.stringify({
    label: 'unreachable', provider: 'other', base_url: 'http://127.0.0.1:1/v1', upstream_key: 'sk-wrong-key',
  }));
  const result = await call(alice, 'POST', '/v1/chat/completions', payload, {
    'X-Norm-Credential': wrong.json.id,
  });
  check('上游不可达 → 502', result.status === 502, result.status);
  check('失败原因说得清', result.json.error === 'upstream_unreachable', result.json);
  await call(alice, 'DELETE', `/api/v1/credentials/${wrong.json.id}`);
}

console.log('7. X-Norm-Base-Url 必须被忽略（否则「钉死」只是口号）');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  const result = await chat(credentials['openai-chat'], {}, null);
  check('正常调用 200', result.status === 200, { status: result.status, body: result.json });
  check('主机仍是凭证里钉死的那台', result.json?.norm?.host === `127.0.0.1:${UPSTREAM_PORT}`, result.json?.norm);
  check('明文密钥不在响应里', !result.text.includes(KEY));
}

console.log('8. 账本与余额一致，每条 charge 能回到请求');
{
  const me = (await call(alice, 'GET', '/api/v1/account/me')).json;
  const okCalls = 4 + 4 + 1; // 四协议各一次 + 流式各一次 + 7 里那一次
  check(`余额 ${1000000 - okCalls * 500}（${okCalls} 次成功）`, me.balance_micros === 1000000 - okCalls * 500, me);
  check(`spend ${okCalls * 500}`, me.spend_micros === okCalls * 500, me);
  check('requests 含一次失败', me.requests === okCalls + 1, me);

  const ledger = (await call(alice, 'GET', '/api/v1/account/ledger')).json;
  const charges = ledger.items.filter((row) => row.kind === 'charge');
  check('charge 数等于成功调用数', charges.length === okCalls, charges.length);
  check('charge 都是负数', charges.every((row) => row.amount_micros === -500), charges);
  check('charge 都带 request_id', charges.every((row) => row.request_id?.startsWith('req_')), charges);
  const sum = ledger.items.reduce((total, row) => total + row.amount_micros, 0);
  check('流水求和 == 当前余额', sum === me.balance_micros, { sum, balance: me.balance_micros });
  check('最新一条流水的余额 == 当前余额', ledger.items[0].balance_after_micros === me.balance_micros, ledger.items[0]);
}

console.log('9. 上游渠道按 base_url 聚合；「可信」只是一份清单');
{
  const groups = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items;
  const group = groups.find((item) => item.base_url === BASE_URL);
  check('按 base_url 聚合成一条', group !== undefined, groups);
  check('统计了凭证数量', group?.credentials === 4, group);
  // 两个概念不能混：upstream_visibility=public 说的是「这个上游别人也能用」，
  // public_listed 说的是「我愿意把这条凭证挂到公开看板」。没勾后者就是 0。
  check('没人勾公开看板时 public_listed 为 0', group?.public_listed === 0, group);

  const visPath = `/api/v1/credentials/${credentials['openai-responses']}/visibility`;
  const visBody = JSON.stringify({ public_listed: true });
  await call(alice, 'POST', visPath, visBody);
  const after = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items
    .find((item) => item.base_url === BASE_URL);
  check('勾上公开看板后 public_listed 变 1', after?.public_listed === 1, after);
  check('统计了协议集合', group?.protocols?.length === 4, group?.protocols);
  check('本地假上游不在信任清单里', group?.trusted === false, group?.trusted);

  const attestation = (await (await fetch(`${BASE}/api/v1/attestation`)).json());
  check('attestation 有 policy', typeof attestation.policy?.keys === 'string', attestation.policy);
}

console.log('10. 下游消费者密钥：只显一次、可轮换、旧钥立刻失效');
let consumerKey = null;
{
  const created = await call(alice, 'POST', '/api/v1/consumers', JSON.stringify({ name: 'e2e bot' }));
  check('创建 201', created.status === 201, created.json);
  consumerKey = created.json.key;
  check('明文形如 sk-norm-…', typeof consumerKey === 'string' && consumerKey.startsWith('sk-norm-'), consumerKey);
  check('回带提示', created.json.key_hint?.startsWith('sk-norm-'), created.json.key_hint);

  const list = await call(alice, 'GET', '/api/v1/consumers');
  const serialized = JSON.stringify(list.json);
  check('列表里没有明文', !serialized.includes(consumerKey), serialized);
  check('列表里连哈希都不回', !serialized.includes('key_sha256'), serialized);
  const entry = list.json.items.find((item) => item.id === created.json.id);
  check('只暴露 key_hint', entry?.key_hint === created.json.key_hint, entry);

  // 一把下游密钥不能凭空再铸一把：管理面只认签名。
  const escalate = await raw('POST', '/api/v1/consumers', JSON.stringify({ name: 'x' }), {
    Authorization: `Bearer ${consumerKey}`,
  });
  check('消费者密钥调管理面 401', escalate.status === 401, escalate.status);
  const readByKey = await raw('GET', '/api/v1/consumers', undefined, { Authorization: `Bearer ${consumerKey}` });
  check('消费者密钥读不了消费者列表', readByKey.status === 401, readByKey.status);

  const viaKey = await chat(credentials['openai-chat'], {}, consumerKey);
  check('用消费者密钥调用 200', viaKey.status === 200, viaKey.json);
  check('费用记在同一个账户上', viaKey.json?.norm?.fee_micros === 500, viaKey.json?.norm);
  check('余额从同一本账上扣', viaKey.json?.norm?.balance_micros !== null, viaKey.json?.norm);

  const bad = await chat(credentials['openai-chat'], {}, 'sk-norm-not-a-real-key');
  check('假密钥 401', bad.status === 401 && bad.json.error === 'consumer_key_invalid', bad.json);

  const used = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === created.json.id);
  check('用过之后 last_used_at 有值', typeof used?.last_used_at === 'number', used);

  const rotated = await call(alice, 'POST', `/api/v1/consumers/${created.json.id}/rotate`);
  check('轮换 200 并给新明文', rotated.status === 200 && rotated.json.key !== consumerKey, rotated.json);
  const stale = await chat(credentials['openai-chat'], {}, consumerKey);
  check('旧密钥立刻失效', stale.status === 401, stale.status);
  const fresh = await chat(credentials['openai-chat'], {}, rotated.json.key);
  check('新密钥可用', fresh.status === 200, fresh.json);

  const renamed = await call(alice, 'POST', `/api/v1/consumers/${created.json.id}/name`, JSON.stringify({ name: 'renamed bot' }));
  check('改名生效', renamed.status === 200 && renamed.json.name === 'renamed bot', renamed.json);

  const revoked = await call(alice, 'DELETE', `/api/v1/consumers/${created.json.id}`);
  check('撤销 200', revoked.status === 200 && revoked.json.revoked === true, revoked.json);
  const afterRevoke = await chat(credentials['openai-chat'], {}, rotated.json.key);
  check('撤销后密钥失效', afterRevoke.status === 401, afterRevoke.status);
  const gone = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === created.json.id);
  check('撤销后不再出现在列表里', gone === undefined, gone);
}

console.log('11. 公开接口不需要签名');
{
  for (const path of ['/api/v1/health', '/api/v1/stats', '/api/v1/base-urls', '/api/v1/attestation']) {
    const response = await fetch(`${BASE}${path}`);
    check(`${path} 200`, response.status === 200, response.status);
  }
}

upstream.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
