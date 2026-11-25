/**
 * 端到端验证：起一个会说四种协议的假上游提供商，用真实 Ed25519 身份打真实 Worker（wrangler dev）。
 *
 * 覆盖：开户、签名验签、nonce 重放、body 篡改、上游提供商密钥的封装与解封、协议不匹配、
 * 四种上游提供商协议（含流式）的请求翻译与响应翻译、扣费与账本一致、base_url 聚合、
 * 上游提供商的启用/禁用（不参与选址、不能被指名、公开看板不计入）、
 * 下游消费者密钥（只显一次、可轮换、旧钥立刻失效）。
 *
 * 用法：node scripts/e2e.mjs [http://127.0.0.1:8787]
 */
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
// 端口可以覆盖：同一台机器上并行跑两个 worktree 时，9099 只有一个能拿到。
const PROVIDER_PORT = Number(process.env.PROVIDER_PORT ?? 9099);
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

/** 记录上游提供商真正收到的请求形状，用来证明翻译发生在 Norm 这一侧。 */
const seen = [];

function sse(response, events) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

const provider = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    const url = new URL(request.url, 'http://x');
    seen.push({ path: url.pathname, search: url.search, headers: request.headers, body: parsed, raw: body });

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
        // 其中 8 个 token 命中上游提供商缓存：账本要按 cached 价算这 8 个。
        usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } },
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
        object: 'response',
        status: 'completed',
        model: parsed.model,
        output: [{ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
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
        type: 'message',
        role: 'assistant',
        model: parsed.model,
        content: [{ type: 'text', text: '你好' }],
        stop_reason: 'end_turn',
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
        candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 },
        modelVersion: parsed.model ?? 'gemini-test',
      }));
      return;
    }

    // 5) 四种协议的模型清单：路径与形状各不相同，翻译必须发生在 Norm 这一侧。
    // 顺序要紧：anthropic 的 /v1/models 也以 /models 结尾，先认更长的那个。
    if (request.method === 'GET') {
      if (url.pathname.endsWith('/v1beta/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
          { name: 'models/gemini-2.0-pro', displayName: 'Gemini 2.0 Pro' },
        ] }));
        return;
      }
      if (url.pathname.endsWith('/v1/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: 'claude-sonnet-4-20250514', type: 'model', created_at: '2025-05-14T00:00:00Z' },
          { id: 'claude-haiku-3', type: 'model', created_at: '2024-03-07T00:00:00Z' },
        ] }));
        return;
      }
      if (url.pathname.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [
          { id: 'gpt-4o-mini', object: 'model', created: 1721174400, owned_by: 'openai' },
          { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'openai' },
        ] }));
        return;
      }
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'no such provider path', path: url.pathname }));
  });
});
await new Promise((resolve) => provider.listen(PROVIDER_PORT, '127.0.0.1', resolve));

const alice = identity();
// 每轮用独立的 base_url：聚合是按 base_url 全库统计的，共用同一个地址会让
// 上一次运行留下的上游提供商混进来，断言就不再只描述这一轮。
const RUN = base58.encode(crypto.getRandomValues(new Uint8Array(6)));
const BASE_URL = `http://127.0.0.1:${PROVIDER_PORT}/v1/${RUN}`;

async function call(who, method, path, body, extra = {}) {
  // 签名只覆盖 pathname（docs/crypto.md）：query 不进待签名串，所以这里也要去掉它。
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...sign(who, method, path.split('?')[0], body), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
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

async function createProvider(protocol, visibility = 'private') {
  const payload = JSON.stringify({
    label: `${protocol} provider`,
    base_url: BASE_URL,
    provider_key: KEY,
    protocol: protocol,
    visibility: visibility,
  });
  const result = await call(alice, 'POST', '/api/v1/providers', payload);
  return { id: result.json.id, status: result.status, body: result.json };
}

/**
 * 两种身份，两种调用形状：
 *   签名（人）        → 需要 X-Norm-Provider 说清用哪条上游提供商
 *   消费者 Token      → 账户里只有一条上游提供商时就是一个 Authorization，多上游提供商时才指名
 * 刻意不给 Bearer 那条路补任何头：这一条断言的就是「程序侧只要一个 api key」。
 */
async function chat(providerId, extra = {}, bearer = null) {
  const payload = JSON.stringify({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    ...extra,
  });
  if (bearer) return raw('POST', '/v1/chat/completions', payload, { Authorization: `Bearer ${bearer}` });
  return call(alice, 'POST', '/v1/chat/completions', payload, { 'X-Norm-Provider': providerId });
}

/** 建一条下游 Token：只有一个名字，与上游提供商无关。 */
async function createConsumer(who, name) {
  return call(who, 'POST', '/api/v1/consumers', JSON.stringify({ name }));
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
  check('演示授信 $1.00（1e9 纳美元）', result.json.balance_nanos === 1_000_000_000, result.json);
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

console.log('3. 上游提供商：明文密钥交给服务端封装，协议与公开性可配置');
const providers = {};
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini']) {
  const created = await createProvider(protocol, protocol === 'openai-responses' ? 'public' : 'private');
  check(`${protocol} 创建 201`, created.status === 201 && typeof created.id === 'string', created.body);
  // 创建响应里只有 id：提示是服务端从明文算出来的，不该由客户端自报。
  check(`${protocol} 创建响应不含密钥`, !JSON.stringify(created.body).includes(KEY), created.body);
  providers[protocol] = created.id;
}
{
  for (const [field, value, code] of [
    ['protocol', 'anthropic', 'protocol_invalid'],
    ['visibility', 'maybe', 'visibility_invalid'],
    ['enabled', 'yes', 'enabled_invalid'],
  ]) {
    const payload = JSON.stringify({
      label: 'bad', base_url: BASE_URL, provider_key: KEY, [field]: value,
    });
    const result = await call(alice, 'POST', '/api/v1/providers', payload);
    check(`${field}=${value} → 400 ${code}`, result.status === 400 && result.json.error === code, result.json);
  }

  const missing = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'no key', base_url: BASE_URL,
  }));
  check('缺 provider_key → 400', missing.status === 400 && missing.json.error === 'provider_key_missing', missing.json);

  const list = await call(alice, 'GET', '/api/v1/providers');
  const serialized = JSON.stringify(list.json);
  check('列表里没有明文密钥', !serialized.includes(KEY));
  const entry = list.json.items.find((item) => item.id === providers['openai-chat']);
  // sk-test-key 的前 4 后 4：服务端算的提示，不是客户端传上来的。
  check('只暴露 key_hint（前 4 后 4）', entry?.key_hint === 'sk-t…-key', entry?.key_hint);
  check('密文是 AES-256-GCM 封装', entry?.kdf === 'aes-256-gcm+worker-secret', entry?.kdf);
  check('默认协议可读', entry?.protocol === 'openai-chat', entry?.protocol);
  // 新加的一条就是拿来用的：默认启用，禁用是用户主动做的减法。
  check('默认启用', entry?.enabled === 1, entry?.enabled);
}

console.log('4. 四种上游提供商协议：请求翻译 + 响应翻译回 OpenAI Chat');
// input 含缓存命中，cached 是其中命中的那部分：账本只认这三种数字。
const expected = {
  'openai-chat': { text: '你好', input: 11, cached: 8, output: 3 },
  'openai-responses': { text: '你好', input: 7, cached: 0, output: 2 },
  'anthropic-messages': { text: '你好', input: 5, cached: 0, output: 4 },
  'google-gemini': { text: '你好', input: 9, cached: 0, output: 6 },
};
for (const [protocol, want] of Object.entries(expected)) {
  const result = await chat(providers[protocol]);
  check(`${protocol} 200`, result.status === 200, result.json);
  check(`${protocol} 文本翻译正确`, result.json?.choices?.[0]?.message?.content === want.text, result.json?.choices);
  const norm = result.json?.norm;
  check(`${protocol} 记下三项 token`, norm?.input_tokens === want.input && norm?.cached_tokens === want.cached && norm?.output_tokens === want.output, norm);
  // 一次调用的钱 = 服务费 + 三项 token 折出来的钱；两个数都能自己核。
  check(`${protocol} 服务费 300 纳美元`, norm?.service_fee_nanos === 300, norm);
  check(`${protocol} token 有价`, norm?.token_nanos > 0, norm);
  check(`${protocol} 总价 = 服务费 + token`, norm?.fee_nanos === norm?.service_fee_nanos + norm?.token_nanos, norm);
  check(`${protocol} 回带 host`, norm?.host === `127.0.0.1:${PROVIDER_PORT}`, norm);
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

console.log('5. 四种上游提供商协议的流式：都翻译成 OpenAI chat chunk');
for (const protocol of Object.keys(expected)) {
  const result = await chat(providers[protocol], { stream: true });
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

console.log('6. 上游提供商失败不扣费，但留一条诚实记录');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  // 封进去的是对的密钥，这里改用一条指向死端口的上游提供商来制造「网络不可达」，
  // 再确认失败既不扣费也没把上游提供商密钥漏进记录。
  const wrong = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'unreachable', base_url: 'http://127.0.0.1:1/v1', provider_key: 'sk-wrong-key',
  }));
  const result = await call(alice, 'POST', '/v1/chat/completions', payload, {
    'X-Norm-Provider': wrong.json.id,
  });
  check('上游提供商不可达 → 502', result.status === 502, result.status);
  check('失败原因说得清', result.json.error === 'provider_unreachable', result.json);
  await call(alice, 'DELETE', `/api/v1/providers/${wrong.json.id}`);
}

console.log('7. X-Norm-Base-Url 必须被忽略（否则「钉死」只是口号）');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  const result = await chat(providers['openai-chat'], {}, null);
  check('正常调用 200', result.status === 200, { status: result.status, body: result.json });
  check('主机仍是上游提供商里钉死的那台', result.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, result.json?.norm);
  check('明文密钥不在响应里', !result.text.includes(KEY));
}

console.log('8. 账本按 Token 记：三项 token、费用构成、打给谁、谁发起');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
{
  const me = (await call(alice, 'GET', '/api/v1/account/me')).json;
  const okCalls = 4 + 4 + 1; // 四协议各一次 + 流式各一次 + 7 里那一次
  check('requests 含一次失败', me.requests === okCalls + 1, me);
  check('三项 token 合计可读', (me.usage?.input_tokens ?? 0) > 0 && (me.usage?.cached_tokens ?? 0) > 0 && (me.usage?.output_tokens ?? 0) > 0, me.usage);
  check('费用按服务费 + token 拆开', (me.billed?.service_fee_nanos ?? 0) > 0 && (me.billed?.token_nanos ?? 0) > 0, me.billed);

  const ledger = (await call(alice, 'GET', '/api/v1/account/ledger')).json;
  const charges = ledger.items.filter((row) => row.kind === 'charge');
  check('charge 数等于成功调用数', charges.length === okCalls, charges.length);
  check('charge 都是负数', charges.every((row) => row.amount_nanos < 0), charges.map((row) => row.amount_nanos));
  // request_id 是 UUID v7：字典序即时间序，账本按它翻页。
  check('charge 都带 UUID v7 的 request_id', charges.every((row) => UUID_V7.test(row.request_id ?? '')), charges.map((row) => row.request_id));
  check('流水带了翻页游标', typeof ledger.items[0]?.cursor === 'number', ledger.items[0]);

  const sum = ledger.items.reduce((total, row) => total + row.amount_nanos, 0);
  check('流水求和 == 当前余额', sum === me.balance_nanos, { sum, balance: me.balance_nanos });
  check('最新一条流水的余额 == 当前余额', ledger.items[0].balance_after_nanos === me.balance_nanos, ledger.items[0]);
  const charged = charges.reduce((total, row) => total + row.amount_nanos, 0);
  check('累计花费 == 流水扣费之和', me.spend_nanos === -charged, { spend: me.spend_nanos, charged });

  const usage = (await call(alice, 'GET', '/api/v1/account/usage?limit=50')).json;
  const ok = usage.items.filter((row) => row.status === 'ok');
  check('请求记录里带着上游提供商地址', ok.every((row) => row.base_url === BASE_URL), ok.map((row) => row.base_url));
  check('请求记录里带着提供者 id', ok.every((row) => row.provider_id !== null), ok.map((row) => row.provider_id));
  check('请求记录里带着三项 token', ok.every((row) => 'input_tokens' in row && 'cached_tokens' in row && 'output_tokens' in row), ok[0]);
  // 每一条都能自己核对：服务费 + token 折价 = 扣费。
  check('每条请求的账都能对上', ok.every((row) => row.fee_nanos === row.service_fee_nanos + row.token_nanos - row.unbilled_nanos), ok[0]);
  check('失败那条 token 与费用都是 0', usage.items.some((row) => row.status !== 'ok' && row.fee_nanos === 0 && row.input_tokens === 0), usage.items.find((row) => row.status !== 'ok'));

  // 按 id 翻页：第一页最后一条之后接着往下取，不会与第一页重叠。
  const firstPage = (await call(alice, 'GET', '/api/v1/account/usage?limit=2')).json.items;
  const nextPage = (await call(alice, 'GET', `/api/v1/account/usage?limit=2&before=${firstPage.at(-1).id}`)).json.items;
  check('游标翻页不重叠', nextPage.every((row) => !firstPage.some((first) => first.id === row.id)), { firstPage: firstPage.map((r) => r.id), nextPage: nextPage.map((r) => r.id) });

  const byConsumer = (await call(alice, 'GET', '/api/v1/account/usage/by-consumer')).json.items;
  check('按钥匙聚合里有签名直连那一档', byConsumer.some((row) => row.consumer_id === null), byConsumer);
  const byProvider = (await call(alice, 'GET', '/api/v1/account/usage/by-provider')).json.items;
  check('按上游提供商聚合回了提供者的名字', byProvider.every((row) => typeof row.provider_label === 'string'), byProvider);

  const pricing = (await (await fetch(`${BASE}/api/v1/pricing`)).json());
  check('价目表公开可读', typeof pricing.default?.input === 'number' && Array.isArray(pricing.models), pricing);
  check('价目表带服务费', pricing.service_fee?.nanos === 300, pricing.service_fee);
}

console.log('9. 上游提供商按 base_url 聚合；「可信」只是一份清单');
{
  const groups = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items;
  const group = groups.find((item) => item.base_url === BASE_URL);
  check('按 base_url 聚合成一条', group !== undefined, groups);
  check('统计了上游提供商数量', group?.providers === 4, group);
  // 两个概念不能混：visibility=public 说的是「这个上游提供商别人也能用」，
  // public_listed 说的是「我愿意把这条上游提供商挂到公开看板」。没勾后者就是 0。
  check('没人勾公开看板时 public_listed 为 0', group?.public_listed === 0, group);

  const visPath = `/api/v1/providers/${providers['openai-responses']}/visibility`;
  const visBody = JSON.stringify({ public_listed: true });
  await call(alice, 'POST', visPath, visBody);
  const after = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items
    .find((item) => item.base_url === BASE_URL);
  check('勾上公开看板后 public_listed 变 1', after?.public_listed === 1, after);
  check('统计了协议集合', group?.protocols?.length === 4, group?.protocols);
  check('本地假上游提供商不在信任清单里', group?.trusted === false, group?.trusted);

  const attestation = (await (await fetch(`${BASE}/api/v1/attestation`)).json());
  check('attestation 有 policy', typeof attestation.policy?.keys === 'string', attestation.policy);
}

console.log('10. 下游消费者 Token：只记名字、只显一次、可轮换、旧钥立刻失效');
let consumerKey = null;
{
  // 建钥只要一个名字：上游提供商不是身份的一部分，旧请求体里还带着 provider_id 也照样接受（并忽略）。
  const anonymous = await call(alice, 'POST', '/api/v1/consumers', JSON.stringify({}));
  check('没有名字 → 400', anonymous.status === 400 && anonymous.json.error === 'name_missing', anonymous.json);

  const created = await createConsumer(alice, 'e2e bot');
  check('创建 201', created.status === 201, created.json);
  check('回带名字', created.json.name === 'e2e bot', created.json);
  check('不回带任何上游提供商绑定', created.json.provider_id === undefined, created.json);
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

  // 此时 alice 名下有 4 条上游提供商：多条又不指名是歧义，不猜。
  const ambiguous = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${consumerKey}` });
  check('多上游提供商又不指名 → 409 provider_ambiguous', ambiguous.status === 409 && ambiguous.json.error === 'provider_ambiguous', ambiguous.json);

  // 指了名就是那一条：一把 Token 可以打任何一条上游提供商，它不再是「钥匙的属性」。
  const viaKey = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${consumerKey}`, 'X-Norm-Provider': providers['openai-chat'] });
  check('指名上游提供商就能调用 200', viaKey.status === 200, viaKey.json);
  check('打到指名的那台上游提供商', viaKey.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, viaKey.json?.norm);
  check('费用记在同一个账户上', viaKey.json?.norm?.fee_nanos > 0, viaKey.json?.norm);
  check('余额从同一本账上扣', viaKey.json?.norm?.balance_nanos !== null, viaKey.json?.norm);

  const bad = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: 'Bearer sk-norm-not-a-real-key', 'X-Norm-Provider': providers['openai-chat'] });
  check('假密钥 401', bad.status === 401 && bad.json.error === 'consumer_key_invalid', bad.json);

  const used = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === created.json.id);
  check('用过之后 last_used_at 有值', typeof used?.last_used_at === 'number', used);

  const rotated = await call(alice, 'POST', `/api/v1/consumers/${created.json.id}/rotate`);
  check('轮换 200 并给新明文', rotated.status === 200 && rotated.json.key !== consumerKey, rotated.json);
  const stale = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${consumerKey}`, 'X-Norm-Provider': providers['openai-chat'] });
  check('旧密钥立刻失效', stale.status === 401, stale.status);
  const fresh = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${rotated.json.key}`, 'X-Norm-Provider': providers['openai-chat'] });
  check('新密钥可用', fresh.status === 200, fresh.json);

  const renamed = await call(alice, 'POST', `/api/v1/consumers/${created.json.id}/name`, JSON.stringify({ name: 'renamed bot' }));
  check('改名生效', renamed.status === 200 && renamed.json.name === 'renamed bot', renamed.json);

  const revoked = await call(alice, 'DELETE', `/api/v1/consumers/${created.json.id}`);
  check('撤销 200', revoked.status === 200 && revoked.json.revoked === true, revoked.json);
  const gone = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === created.json.id);
  check('撤销后不再出现在列表里', gone === undefined, gone);
}

console.log('10b. 只有一个上游提供商账户：一个 Bearer 就是完整调用，不用任何专有头');
{
  // bob 只有一条上游提供商：默认值唯一的场合，「一条 Token」才真的等于「一次完整调用」。
  const bob = identity();
  await call(bob, 'POST', '/api/v1/auth/login');
  const provider = await call(bob, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'bob provider',
    base_url: BASE_URL,
    provider_key: KEY,
    protocol: 'openai-chat',
  }));
  check('bob 建了一条上游提供商', provider.status === 201, provider.json);

  const withoutProvider = await call(bob, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('签名身份不指名也能调用 200', withoutProvider.status === 200, withoutProvider.json);
  check('走到了唯一的那条上游提供商', withoutProvider.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, withoutProvider.json?.norm);

  const key = (await createConsumer(bob, 'bob bot')).json.key;
  const viaKey = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${key}` });
  check('一条 Bearer 就够了', viaKey.status === 200, viaKey.json);
  check('打到唯一的那条上游提供商', viaKey.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, viaKey.json?.norm);

  // 没有上游提供商时才轮到「你先去加一条上游提供商」这条错误。
  const carol = identity();
  await call(carol, 'POST', '/api/v1/auth/login');
  const noProvider = await call(carol, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('没有上游提供商 → 400 provider_missing', noProvider.status === 400 && noProvider.json.error === 'provider_missing', noProvider.json);

  const carolKey = (await createConsumer(carol, 'carol bot')).json.key;
  const noProviderByKey = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${carolKey}` });
  check('没上游提供商时调用方拿到的是同一个 400', noProviderByKey.status === 400 && noProviderByKey.json.error === 'provider_missing', noProviderByKey.json);

  const unknown = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${carolKey}`, 'X-Norm-Provider': 'cred_does_not_exist' });
  check('指名一条不存在的上游提供商 → 404', unknown.status === 404 && unknown.json.error === 'provider_not_found', unknown.json);
}

console.log('10c. 上游提供商启用/禁用：不参与选址、不能被指名、公开看板不计入');
{
  const dave = identity();
  await call(dave, 'POST', '/api/v1/auth/login');
  // 独立的 base_url：第 9 节按 base_url 全库聚合，混进 alice 的组会污染计数。
  const OFF_BASE_URL = `${BASE_URL}-off`;
  const create = (extra = {}) =>
    call(dave, 'POST', '/api/v1/providers', JSON.stringify({
      label: 'dave provider',
      base_url: OFF_BASE_URL,
      provider_key: KEY,
      protocol: 'openai-chat',
      ...extra,
    }));

  const on = await create();
  const off = await create({ enabled: false });
  check('创建时 enabled=false 仍 201', off.status === 201, off.json);
  const bad = await create({ enabled: 'yes' });
  check('enabled=yes → 400 enabled_invalid', bad.status === 400 && bad.json.error === 'enabled_invalid', bad.json);

  const list = (await call(dave, 'GET', '/api/v1/providers')).json.items;
  const onRow = list.find((item) => item.id === on.json.id);
  const offRow = list.find((item) => item.id === off.json.id);
  check('默认 enabled=1', onRow?.enabled === 1, onRow);
  check('显式禁用存成 0', offRow?.enabled === 0, offRow);

  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  // 两条里只有一条启用：自动选址必须落在启用的那条上。
  const auto = await call(dave, 'POST', '/v1/chat/completions', payload);
  check('禁用的不参与自动选址', auto.status === 200 && auto.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, auto.json);

  const namedOff = await call(dave, 'POST', '/v1/chat/completions', payload, { 'X-Norm-Provider': off.json.id });
  check('指名禁用的上游提供商 → 409 provider_disabled', namedOff.status === 409 && namedOff.json.error === 'provider_disabled', namedOff.json);

  // 模型清单与转发是同一套判定，否则「禁用了却还能读清单」就自相矛盾。
  const modelsOff = await call(dave, 'GET', '/v1/models', undefined, { 'X-Norm-Provider': off.json.id });
  check('禁用的上游提供商也列不了模型 → 409', modelsOff.status === 409 && modelsOff.json.error === 'provider_disabled', modelsOff.json);

  // 公开看板只数启用的：同一个 base_url 下有 2 条，在服务的只有 1 条。
  const group = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items
    .find((item) => item.base_url === OFF_BASE_URL);
  check('公开看板只数启用的上游提供商', group?.providers === 1, group);

  const offToggle = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({ enabled: false }));
  check('开关返回 enabled=0', offToggle.status === 200 && offToggle.json.enabled === 0, offToggle.json);
  const none = await call(dave, 'POST', '/v1/chat/completions', payload);
  check('全部禁用 → 409 provider_disabled', none.status === 409 && none.json.error === 'provider_disabled', none.json);

  const onToggle = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({ enabled: true }));
  check('拨回来返回 enabled=1', onToggle.status === 200 && onToggle.json.enabled === 1, onToggle.json);
  const back = await call(dave, 'POST', '/v1/chat/completions', payload);
  check('重新启用后自动选址恢复 200', back.status === 200, back.json);

  const missing = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({}));
  check('开关缺 enabled → 400 enabled_invalid', missing.status === 400 && missing.json.error === 'enabled_invalid', missing.json);
}

console.log('11. 公开接口不需要签名');
{
  for (const path of ['/api/v1/health', '/api/v1/stats', '/api/v1/base-urls', '/api/v1/attestation']) {
    const response = await fetch(`${BASE}${path}`);
    check(`${path} 200`, response.status === 200, response.status);
  }
}

console.log('12. 4×4 矩阵：入口方言 × 上游提供商协议');
{
  // 每一格都要能跑通，且回到客户端的是「入口方言」的形状。
  const ENTRIES = {
    'openai-chat': (model, stream) => ({
      path: '/v1/chat/completions',
      body: { model, stream, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] },
    }),
    'openai-responses': (model, stream) => ({
      path: '/v1/responses',
      body: { model, stream, instructions: 'be brief', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    }),
    'anthropic-messages': (model, stream) => ({
      path: '/v1/messages',
      body: { model, stream, max_tokens: 64, system: 'be brief', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    }),
    'google-gemini': (model, stream) => ({
      path: `/v1/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`,
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: 'be brief' }] } },
    }),
  };

  // 各入口的响应必须长成本方言的样子——这是「出口翻译」的唯一证据。
  const SHAPE = {
    'openai-chat': (json) => Array.isArray(json.choices) && json.choices[0]?.message?.content === '你好',
    'openai-responses': (json) => json.object === 'response' && json.output?.[0]?.content?.[0]?.type === 'output_text' && json.output[0].content[0].text === '你好',
    'anthropic-messages': (json) => json.type === 'message' && json.content?.[0]?.type === 'text' && json.content[0].text === '你好',
    'google-gemini': (json) => json.candidates?.[0]?.content?.parts?.[0]?.text === '你好',
  };

  const entries = Object.keys(ENTRIES);
  const protocols = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'];

  for (const entry of entries) {
    for (const protocol of protocols) {
      const same = entry === protocol;
      const { path, body } = ENTRIES[entry]('gpt-test', false);
      const payload = JSON.stringify(body);
      const before = seen.length;
      const result = await call(alice, 'POST', path, payload, { 'X-Norm-Provider': providers[protocol] });
      const label = `${entry} → ${protocol}${same ? '（直通）' : ''}`;

      check(`${label} 200`, result.status === 200, result.json);
      const providerSeen = seen.slice(before).at(-1);

      if (same) {
        // 对角线：请求体必须一个字节都不变地到了上游提供商。
        check(`${label} 请求体按原字节转发`, providerSeen?.raw === payload, {
          sent: payload.slice(0, 80),
          got: providerSeen?.raw?.slice(0, 80),
        });
      } else {
        check(`${label} 请求被翻译过`, providerSeen?.raw !== payload, providerSeen?.raw?.slice(0, 80));
        // 跨方言时上游提供商收到的是它自己的方言，不是入口的那一套。
        const providerShape = {
          'openai-chat': (b) => Array.isArray(b.messages),
          'openai-responses': (b) => Array.isArray(b.input),
          'anthropic-messages': (b) => Array.isArray(b.messages) && typeof b.system === 'string',
          'google-gemini': (b) => Array.isArray(b.contents),
        }[protocol];
        check(`${label} 上游提供商收到 ${protocol} 的形状`, providerShape(providerSeen?.body ?? {}), providerSeen?.body);
        // 内容本身不能丢：三种方言都该把 system 与 user 带过去。
        const wire = JSON.stringify(providerSeen?.body ?? {});
        check(`${label} 内容没丢`, wire.includes('be brief') && wire.includes('hi'), wire.slice(0, 160));
      }

      check(`${label} 响应是入口方言的形状`, SHAPE[entry](result.json), result.json);
      check(`${label} 带 norm`, typeof result.json?.norm?.request_id === 'string', result.json?.norm);
    }
  }

  // 对角线不能只是「能跑」：上游提供商多给的字段必须原样保留下来，否则就不叫直通。
  {
    const { path, body } = ENTRIES['openai-chat']('gpt-test', false);
    const result = await call(alice, 'POST', path, JSON.stringify(body), { 'X-Norm-Provider': providers['openai-chat'] });
    check('直通保留上游提供商特有的字段（id/finish_reason）', result.json?.id === 'chatcmpl-1' && result.json?.choices?.[0]?.finish_reason === 'stop', result.json);
  }

  // 各家 SDK 用各自的头带密钥：Claude Code 走 x-api-key，Google SDK 走 x-goog-api-key。
  // 这里刻意给每条 Token 都指名上游提供商（这个账户有 4 条，不指名就是歧义），
  // 于是三种写法都只带「自己的 api key + 一条 X-Norm-Provider 」——没有别的 Norm 专有头。
  {
    const anthKey = (await createConsumer(alice, 'matrix bot (anthropic)')).json.key;
    const gemKey = (await createConsumer(alice, 'matrix bot (gemini)')).json.key;

    const anth = ENTRIES['anthropic-messages']('gpt-test', false);
    const viaApiKey = await raw('POST', anth.path, JSON.stringify(anth.body), {
      'x-api-key': anthKey, 'X-Norm-Provider': providers['anthropic-messages'],
    });
    check('x-api-key 能当消费者密钥（Claude Code 的形状）', viaApiKey.status === 200, viaApiKey.json);

    const gem = ENTRIES['google-gemini']('gpt-test', false);
    const viaGoog = await raw('POST', gem.path, JSON.stringify(gem.body), {
      'x-goog-api-key': gemKey, 'X-Norm-Provider': providers['google-gemini'],
    });
    check('x-goog-api-key 能当消费者密钥（Google SDK 的形状）', viaGoog.status === 200, viaGoog.json);

    const viaBearer = await raw('POST', anth.path, JSON.stringify(anth.body), {
      Authorization: `Bearer ${anthKey}`, 'X-Norm-Provider': providers['anthropic-messages'],
    });
    check('Bearer 也一样', viaBearer.status === 200, viaBearer.json);

    // 没有 sk-norm- 前缀的 api key 不是我们的身份：要说不清就直说不清，不要误判成「钥匙无效」。
    const foreign = await raw('POST', anth.path, JSON.stringify(anth.body), {
      'x-api-key': 'sk-some-provider-key',
      'X-Norm-Provider': providers['anthropic-messages'],
    });
    check('别家的 api key 不被当成消费者密钥', foreign.status === 401 && foreign.json.error === 'signature_required', foreign.json);

    for (const name of ['matrix bot (anthropic)', 'matrix bot (gemini)']) {
      const list = (await call(alice, 'GET', '/api/v1/consumers')).json.items;
      const target = list.find((item) => item.name === name);
      if (target) await call(alice, 'DELETE', `/api/v1/consumers/${target.id}`);
    }
  }

  // 跨方言的工具调用不翻译：早拒绝，而不是让客户端收到一段散文。
  {
    const payload = JSON.stringify({
      model: 'gpt-test',
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = await call(alice, 'POST', '/v1/messages', payload, { 'X-Norm-Provider': providers['openai-chat'] });
    check('跨方言带 tools → 400 tools_unsupported', result.status === 400 && result.json.error === 'tools_unsupported', result.json);

    // 同格式直通时 tools 免费穿过：我们不碰请求体，也就没有「支持不支持」的问题。
    const same = JSON.stringify({ model: 'gpt-test', tools: [{ type: 'function', function: { name: 'w' } }], messages: [{ role: 'user', content: 'hi' }] });
    const passed = await call(alice, 'POST', '/v1/chat/completions', same, { 'X-Norm-Provider': providers['openai-chat'] });
    check('同格式直通时 tools 原样穿过', passed.status === 200, passed.json);
  }

  // 跨方言流式：帧必须是入口方言自己的那套。
  for (const protocol of protocols) {
    if (protocol === 'openai-chat') continue;
    const { path, body } = ENTRIES['openai-responses']('gpt-test', true);
    const result = await call(alice, 'POST', path, JSON.stringify(body), { 'X-Norm-Provider': providers[protocol] });
    check(`流式 openai-responses → ${protocol} 200`, result.status === 200, result.status);
    if (protocol === 'openai-responses') {
      // 对角线：上游提供商的帧原样到达，我们不合成、不改写。
      check('流式 responses 直通保留上游提供商帧', result.text.includes('response.output_text.delta'), result.text.slice(0, 200));
      check('流式 responses 直通不插 norm 帧', !result.text.includes('"norm"'), result.text.slice(-200));
    } else {
      check(`流式 openai-responses → ${protocol} 有 response.completed`, result.text.includes('response.completed'), result.text.slice(0, 200));
      check(`流式 openai-responses → ${protocol} 有增量文本`, result.text.includes('"delta":"你"'), result.text.slice(0, 300));
    }
  }
  for (const protocol of protocols) {
    if (protocol === 'anthropic-messages') continue;
    const { path, body } = ENTRIES['anthropic-messages']('gpt-test', true);
    const result = await call(alice, 'POST', path, JSON.stringify(body), { 'X-Norm-Provider': providers[protocol] });
    check(`流式 anthropic → ${protocol} 200`, result.status === 200, result.status);
    check(`流式 anthropic → ${protocol} 有 message_stop`, result.text.includes('message_stop'), result.text.slice(-200));
    check(`流式 anthropic → ${protocol} 用 text_delta`, result.text.includes('text_delta'), result.text.slice(0, 300));
  }
  {
    const { path, body } = ENTRIES['google-gemini']('gpt-test', true);
    const result = await call(alice, 'POST', path, JSON.stringify(body), { 'X-Norm-Provider': providers['anthropic-messages'] });
    check('流式 gemini → anthropic 200', result.status === 200, result.status);
    // 入口是 gemini，出口就必须是 gemini 的裸 data 帧：没有 event: 前缀，也没有 anthropic 的事件名。
    check('流式 gemini 出口是 gemini 帧', result.text.includes('"candidates"') && !result.text.includes('message_stop'), result.text.slice(0, 200));
    check('流式 gemini 带回增量文本', result.text.includes('"text":"你"'), result.text.slice(0, 300));
  }

  // 同格式流式直通：上游提供商的帧原样过来，不再被二次解读。
  {
    const { path, body } = ENTRIES['anthropic-messages']('gpt-test', true);
    const result = await call(alice, 'POST', path, JSON.stringify(body), { 'X-Norm-Provider': providers['anthropic-messages'] });
    check('anthropic 流式直通 200', result.status === 200, result.status);
    check('anthropic 流式直通保留上游提供商事件名', result.text.includes('event: message_start') === false ? result.text.includes('"message_start"') : true, result.text.slice(0, 200));
    check('anthropic 流式直通保留上游提供商 delta 原文', result.text.includes('"text_delta"'), result.text.slice(0, 300));
  }
}

console.log('13. 模型清单：四种上游归一成 OpenAI /models，且不扣费');
{
  const WANT = {
    'openai-chat': ['gpt-4o-mini', 'gpt-4o'],
    'openai-responses': ['gpt-4o-mini', 'gpt-4o'],
    'anthropic-messages': ['claude-sonnet-4-20250514', 'claude-haiku-3'],
    'google-gemini': ['gemini-2.0-flash', 'gemini-2.0-pro'],
  };

  // 余额与请求数在清单这一路上一分都不能动：先记下来，最后对一遍。
  const before = (await call(alice, 'GET', '/api/v1/account/me')).json;

  for (const [protocol, ids] of Object.entries(WANT)) {
    const seenBefore = seen.length;
    const result = await call(alice, 'GET', '/v1/models', undefined, { 'X-Norm-Provider': providers[protocol] });
    check(`${protocol} 清单 200`, result.status === 200, result.json);
    check(`${protocol} 清单是 OpenAI 形状`, result.json?.object === 'list' && Array.isArray(result.json.data), result.json);
    check(`${protocol} 模型名归一正确`, JSON.stringify(result.json?.data?.map((m) => m.id)) === JSON.stringify(ids), result.json?.data);
    check(`${protocol} 每个条目都是 model`, result.json?.data?.every((m) => m.object === 'model'), result.json?.data);
    // 唯一不扣费的一条路：服务费与 token 都是 0，也没去读余额。
    check(`${protocol} 清单不扣费`, result.json?.norm?.fee_nanos === 0 && result.json?.norm?.service_fee_nanos === 0, result.json?.norm);
    check(`${protocol} 清单不报余额`, result.json?.norm?.balance_nanos === null, result.json?.norm);
    check(`${protocol} 清单回带 host`, result.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, result.json?.norm);

    const upstreamSeen = seen.slice(seenBefore).at(-1);
    check(`${protocol} 用 GET 打清单端点`, upstreamSeen?.path.includes('models'), upstreamSeen?.path);
  }

  const gemini = (await call(alice, 'GET', '/v1/models', undefined, { 'X-Norm-Provider': providers['google-gemini'] })).json;
  check('gemini 名字去掉了 models/ 前缀', gemini.data.every((m) => !m.id.startsWith('models/')), gemini.data);

  const anthropic = (await call(alice, 'GET', '/v1/models', undefined, { 'X-Norm-Provider': providers['anthropic-messages'] })).json;
  check('anthropic 的 created_at 转成 unix 秒', anthropic.data[0]?.created === 1747180800, anthropic.data[0]);
  check('anthropic 不凭空编 owned_by', anthropic.data[0]?.owned_by === undefined, anthropic.data[0]);

  const openai = (await call(alice, 'GET', '/v1/models', undefined, { 'X-Norm-Provider': providers['openai-chat'] })).json;
  check('openai 保留 created 与 owned_by', openai.data[0]?.created === 1721174400 && openai.data[0]?.owned_by === 'openai', openai.data[0]);

  const one = await call(alice, 'GET', '/v1/models/gpt-4o-mini', undefined, { 'X-Norm-Provider': providers['openai-chat'] });
  check('单个模型 200', one.status === 200 && one.json.id === 'gpt-4o-mini' && one.json.object === 'model', one.json);
  const missing = await call(alice, 'GET', '/v1/models/no-such-model', undefined, { 'X-Norm-Provider': providers['openai-chat'] });
  check('不存在的模型 404 model_not_found', missing.status === 404 && missing.json.error === 'model_not_found', missing.json);

  // 消费者密钥同样能列清单：程序拿着一条 Token 就能看见自己能调什么。
  const token = (await createConsumer(alice, 'models bot')).json.key;
  const byKey = await raw('GET', '/v1/models', undefined, {
    Authorization: `Bearer ${token}`, 'X-Norm-Provider': providers['openai-chat'],
  });
  check('消费者密钥能列清单', byKey.status === 200 && byKey.json?.data?.length === 2, byKey.json);

  const anonymous = await raw('GET', '/v1/models', undefined, { 'X-Norm-Provider': providers['openai-chat'] });
  check('无身份 401', anonymous.status === 401, anonymous.status);

  const after = (await call(alice, 'GET', '/api/v1/account/me')).json;
  check('清单不写请求记录', after.requests === before.requests, { before: before.requests, after: after.requests });
  check('清单不动余额', after.balance_nanos === before.balance_nanos, { before: before.balance_nanos, after: after.balance_nanos });
}

provider.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
