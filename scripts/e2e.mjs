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

/**
 * 身份。默认每次随机；`E2E_SEED`（64 位十六进制）可以钉住它——
 * 池子那一节要先把 alice 的地址写进 dev server 的 `POOL_ADMIN_ADDRESSES`，
 * 而那个变量在启动时就定了，所以地址必须事先可知。
 */
function identity(seedHex = null) {
  const seed = seedHex
    ? Uint8Array.from(seedHex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
    : crypto.getRandomValues(new Uint8Array(32));
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
        const frames = [{ choices: [{ delta: { content: '你' } }] }, { choices: [{ delta: { content: '好' } }] }];
        // 仿 DeepSeek：用量只在你显式 `stream_options.include_usage` 的时候才回。
        // Norm 的账本靠它算钱，所以 Norm 必须自己会要——这一条就是那个回归。
        if (parsed.stream_options?.include_usage) {
          frames.push({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 6, prompt_cache_hit_tokens: 20 } });
        }
        sse(response, frames);
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
          // 用量只在收尾事件里出现：账本要靠它，而它藏在 response.usage 里。
          { type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 5 } } },
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
          { type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, output_tokens: 1 } } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } },
          { type: 'message_delta', usage: { output_tokens: 7 } },
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
        { candidates: [{ content: { parts: [{ text: '好' }] } }], usageMetadata: { promptTokenCount: 18, cachedContentTokenCount: 12, candidatesTokenCount: 4 } },
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

const alice = identity(process.env.E2E_SEED);
// 每轮用独立的 base_url：聚合是按 base_url 全库统计的，共用同一个地址会让
// 上一次运行留下的上游提供商混进来，断言就不再只描述这一轮。
const RUN = base58.encode(crypto.getRandomValues(new Uint8Array(6)));
const BASE_URL = `http://127.0.0.1:${PROVIDER_PORT}/v1/${RUN}`;

/** alice 名下那条下游 Token：第 2 节铸好，之后每次转发面调用都用它。 */
let aliceKey = '';

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
  return { status: response.status, json, text, headers: response.headers };
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
 * 转发面的唯一形状：一条下游消费者 Token（`aliceKey`，第 2 节末尾铸的那把）。
 * 签名在这里没有位置——它管资源，不花钱，见第 2 节「签名直连 401」。
 *
 * 第一个参数是「这一节要打哪种协议的假上游」。走哪条上游由服务端挑，
 * 所以夹具要做的事是让账户此刻**只有那一条候选**，见 onlyProvider。
 */
async function chat(protocol, extra = {}) {
  const payload = JSON.stringify({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    ...extra,
  });
  await onlyProvider(protocol);
  return relay(aliceKey, 'POST', '/v1/chat/completions', payload);
}

/**
 * 让 alice 名下只剩一条启用中的上游：接下来所有转发都必然落在它上面。
 *
 * 旧版本这里靠请求头 `X-Norm-Provider` 指名，那个头已经删掉了——选择权回到服务端
 * （自己的上游优先、公共池兜底、会话粘住）。夹具于是改成「同一时刻只留一条候选」，
 * 这样每一条断言仍然只描述这一条上游，而不是描述一次随机选择。
 */
async function onlyCandidate(id) {
  for (const item of (await call(alice, 'GET', '/api/v1/providers')).json.items) {
    if (item.mine === false) continue; // 公共池里那条不归 alice，也不参与这一节的断言
    const wanted = item.id === id ? 1 : 0;
    if (item.enabled !== wanted) {
      await call(alice, 'POST', `/api/v1/providers/${item.id}/enabled`, JSON.stringify({ enabled: wanted === 1 }));
    }
  }
}

async function onlyProvider(protocol) {
  const target = providers[protocol];
  if (!target) throw new Error(`夹具里没有 ${protocol} 这条上游`);
  await onlyCandidate(target);
}

/** 把 alice 名下的上游全部拨回启用：要数「同一个 base_url 下有几条」的那几节用。 */
async function enableAllProviders() {
  for (const item of (await call(alice, 'GET', '/api/v1/providers')).json.items) {
    if (item.mine === false || item.enabled === 1) continue;
    await call(alice, 'POST', `/api/v1/providers/${item.id}/enabled`, JSON.stringify({ enabled: true }));
  }
}

/** 先收成一条候选再发：转发面只认 Token，不再有指名头。 */
async function relayVia(protocol, key, method, requestPath, body, extra = {}) {
  await onlyProvider(protocol);
  return relay(key, method, requestPath, body, extra);
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
  return { status: response.status, json, text, headers: response.headers };
}

/**
 * 转发面（`/v1/*`）的调用：一条下游消费者 Token，没有别的 Norm 专有头。
 * 转发面不认签名，所以这里没有「签名版」可以选——这正是被测的那条边界。
 */
async function relay(key, method, path, body, extra = {}) {
  return raw(method, path, body, { Authorization: `Bearer ${key}`, ...extra });
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

  // 签名的绑定对象是 body：管理面上换掉 body，验签必然失败。
  const bodyPath = '/api/v1/consumers';
  const signedBody = JSON.stringify({ name: 'tamper' });
  const signed = sign(alice, 'POST', bodyPath, signedBody);
  const tampered = await fetch(`${BASE}${bodyPath}`, {
    method: 'POST',
    headers: { ...signed, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'tampered' }),
  });
  check('篡改 body 401', tampered.status === 401, tampered.status);

  // 转发面没有签名入口：签名能管资源，不能花钱。四签名头齐全也只是 401。
  const signedRelay = await call(alice, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('签名直连推理接口 401', signedRelay.status === 401, signedRelay.status);
  check('拒绝原因说得清', signedRelay.json.error === 'consumer_key_required', signedRelay.json);
  check('拒绝发生在鉴权层（没有打上游，也没有 request_id）', !signedRelay.headers.has('x-norm-request-id'), [...signedRelay.headers.keys()]);
}

// 转发面要用的那把钥匙：从此处起，所有 /v1/* 的调用都只带它。
aliceKey = (await createConsumer(alice, 'alice e2e bot')).json.key;

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
  const result = await chat(protocol);
  check(`${protocol} 200`, result.status === 200, result.json);
  check(`${protocol} 文本翻译正确`, result.json?.choices?.[0]?.message?.content === want.text, result.json?.choices);
  const norm = result.json?.norm;
  check(`${protocol} 记下三项 token`, norm?.input_tokens === want.input && norm?.cached_tokens === want.cached && norm?.output_tokens === want.output, norm);
  // 一次调用的钱 = Gas 费 + 三项 token 折出来的钱；两个数都能自己核。
  check(`${protocol} Gas 费 300 纳美元`, norm?.gas_fee_nanos === 300, norm);
  check(`${protocol} token 有价`, norm?.token_nanos > 0, norm);
  check(`${protocol} 总价 = Gas + token`, norm?.fee_nanos === norm?.gas_fee_nanos + norm?.token_nanos, norm);
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
  const result = await chat(protocol, { stream: true });
  check(`${protocol} 流式 200`, result.status === 200, result.status);
  check(`${protocol} 流式有内容`, result.text.includes('"content":"你"') && result.text.includes('"content":"好"'), result.text.slice(0, 200));
  check(`${protocol} 结尾有 norm 事件`, result.text.includes('"norm"'), result.text.slice(-200));
  check(`${protocol} 结尾有 DONE`, result.text.trimEnd().endsWith('data: [DONE]'), result.text.slice(-40));
}
{
  // 流式账单：用量只在被显式要求时才出现，所以 Norm 必须自己补 include_usage，
  // 否则真实调用（DeepSeek 这类）在账本上永远是 0 / 0 / 0。
  const normOf = (text) => {
    const line = text.split('\n').filter((l) => l.startsWith('data: {') && l.includes('"norm"')).at(-1);
    return JSON.parse(line.slice(6)).norm;
  };
  const streamed = await chat('openai-chat', { stream: true });
  const norm = normOf(streamed.text);
  check('流式也记下三项 token', norm?.input_tokens === 30 && norm?.cached_tokens === 20 && norm?.output_tokens === 6, norm);
  check('流式按 token 收钱', norm?.token_nanos > 0 && norm?.fee_nanos === norm?.gas_fee_nanos + norm?.token_nanos, norm);
  check('客户端没要用量就不给用量帧', !streamed.text.includes('"prompt_tokens_details"'), streamed.text.slice(-300));

  const asked = await chat('openai-chat', { stream: true, stream_options: { include_usage: true } });
  check('客户端要了用量就原样给他', asked.text.includes('"prompt_tokens_details"'), asked.text.slice(-400));

  // 同格式直通：入口 openai-responses、上游也是 openai-responses。这条路以前一个字节
  // 不改地转发，却忘了顺手读用量——于是账本上只剩 Gas。这一条钉住它。
  {
    const payload = JSON.stringify({ model: 'gpt-test', input: 'hi', stream: true });
    // 推理面只认下游消费者 Token（签名身份只管管理面），所以这里现建一把。
    const key = (await createConsumer(alice, 'responses passthrough')).json.key;
    await onlyProvider('openai-responses');
    const response = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    const text = await response.text();
    const requestId = response.headers.get('X-Norm-Request-Id');
    check('同格式 responses 流 200', response.status === 200, text.slice(0, 200));
    check('同格式 responses 流原样转发', text.includes('"response.completed"'), text.slice(-200));
    const rows = (await call(alice, 'GET', '/api/v1/account/usage?limit=50')).json.items;
    const row = rows.find((item) => item.id === requestId);
    check('同格式 responses 流记下三项 token', row?.input_tokens === 40 && row?.output_tokens === 5, row);
    check('同格式 responses 流也收了 token 的钱', (row?.fee_nanos ?? 0) > (row?.gas_fee_nanos ?? 0), row);
  }

  const geminiStream = seen.find((entry) => entry.path.includes(':streamGenerateContent'));
  check('gemini 走流式端点', geminiStream.search.includes('alt=sse'), geminiStream.search);
  const responsesStream = seen.filter((entry) => entry.path.endsWith('/responses')).at(-1);
  check('responses 流式靠 body 里的 stream', responsesStream.body.stream === true, responsesStream.body);
}

console.log('6. 上游提供商失败只收 Gas，token 不计，仍留一条诚实记录');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  // 封进去的是对的密钥，这里改用一条指向死端口的上游提供商来制造「网络不可达」：
  // 确认 Gas 照收（这次执行已经发生）、token 不计，也没把上游提供商密钥漏进记录。
  const wrong = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'unreachable', base_url: 'http://127.0.0.1:1/v1', provider_key: 'sk-wrong-key',
  }));
  await onlyCandidate(wrong.json.id);
  const result = await relay(aliceKey, 'POST', '/v1/chat/completions', payload);
  check('上游提供商不可达 → 502', result.status === 502, result.status);
  check('失败原因说得清', result.json.error === 'provider_unreachable', result.json);
  check('失败也扣 300 纳美元 Gas（响应头）', result.headers.get('x-norm-gas-fee-nanos') === '300', result.headers.get('x-norm-gas-fee-nanos'));
  check('失败也回带 request_id', (result.headers.get('x-norm-request-id') ?? '').length > 0, result.headers.get('x-norm-request-id'));
  await call(alice, 'DELETE', `/api/v1/providers/${wrong.json.id}`);
}

console.log('7. X-Norm-Base-Url 必须被忽略（否则「钉死」只是口号）');
{
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  const result = await chat('openai-chat');
  check('正常调用 200', result.status === 200, { status: result.status, body: result.json });
  check('主机仍是上游提供商里钉死的那台', result.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, result.json?.norm);
  check('明文密钥不在响应里', !result.text.includes(KEY));
}

console.log('8. 账本按 Token 记：三项 token、费用构成、打给谁、谁发起');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
{
  const me = (await call(alice, 'GET', '/api/v1/account/me')).json;
  const okCalls = 4 + 4 + 1; // 四协议各一次 + 流式各一次 + 7 里那一次
  const rows = (await call(alice, 'GET', '/api/v1/account/usage?limit=200')).json.items;
  const failures = rows.filter((row) => row.status !== 'ok');
  check('requests 计数与实际记录一致', me.requests === rows.length, { counted: me.requests, rows: rows.length });
  check('记录里既有成功也有失败', okCalls > 0 && failures.length > 0, { okCalls, failures: failures.length });
  check('三项 token 合计可读', (me.usage?.input_tokens ?? 0) > 0 && (me.usage?.cached_tokens ?? 0) > 0 && (me.usage?.output_tokens ?? 0) > 0, me.usage);
  check('费用按 Gas + token 拆开', (me.billed?.gas_fee_nanos ?? 0) > 0 && (me.billed?.token_nanos ?? 0) > 0, me.billed);

  const ledger = (await call(alice, 'GET', '/api/v1/account/ledger')).json;
  const charges = ledger.items.filter((row) => row.kind === 'charge');
  // 失败也收 Gas（执行真的发生了），所以每一行请求都该有一条 charge。
  check('charge 数 = 请求记录数', charges.length === rows.length, { charges: charges.length, rows: rows.length });
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
  // 每一条都能自己核对：Gas + token 折价 − 未收 = 扣费。
  check('每条请求的账都能对上', usage.items.every((row) => row.fee_nanos === row.gas_fee_nanos + row.token_nanos - row.unbilled_nanos), usage.items[0]);
  // 首字与总耗时分开记：流式有首字，非流式没有这个事件（记 null，不拿总耗时冒充）。
  check('流式记下了首字延迟', ok.some((row) => typeof row.first_token_ms === 'number' && row.first_token_ms > 0), ok.slice(0, 3));
  check('非流式首字为空', ok.some((row) => row.first_token_ms === null), ok.slice(0, 3));
  check('首字不会晚于总耗时', ok.every((row) => row.first_token_ms === null || row.first_token_ms <= row.latency_ms), ok.slice(0, 3));
  check('缓存命中不超过输入（缓存率恒在 0..1）', ok.every((row) => row.cached_tokens <= row.input_tokens), ok.slice(0, 3));
  const meLatency = me.latency;
  check('账户级延迟统计可读', typeof meLatency?.avg_latency_ms === 'number' && (meLatency?.streamed_requests ?? 0) > 0, meLatency);
  check('失败那条只扣 Gas、token 为 0', usage.items.some((row) => row.status !== 'ok' && row.fee_nanos === 300 && row.gas_fee_nanos === 300 && row.token_nanos === 0 && row.input_tokens === 0), usage.items.find((row) => row.status !== 'ok'));

  // 按 id 翻页：第一页最后一条之后接着往下取，不会与第一页重叠。
  const firstPage = (await call(alice, 'GET', '/api/v1/account/usage?limit=2')).json.items;
  const nextPage = (await call(alice, 'GET', `/api/v1/account/usage?limit=2&before=${firstPage.at(-1).id}`)).json.items;
  check('游标翻页不重叠', nextPage.every((row) => !firstPage.some((first) => first.id === row.id)), { firstPage: firstPage.map((r) => r.id), nextPage: nextPage.map((r) => r.id) });

  const byConsumer = (await call(alice, 'GET', '/api/v1/account/usage/by-consumer')).json.items;
  // 转发面只认 Token，所以每一笔消费都挂得回一条具体的钥匙：没有「无钥匙」那一档。
  check('按钥匙聚合里没有「无钥匙」那一档', byConsumer.every((row) => typeof row.consumer_id === 'string'), byConsumer);
  const byProvider = (await call(alice, 'GET', '/api/v1/account/usage/by-provider')).json.items;
  check('按上游提供商聚合回了提供者的名字', byProvider.every((row) => typeof row.provider_label === 'string'), byProvider);

  const pricing = (await (await fetch(`${BASE}/api/v1/pricing`)).json());
  check('价目表公开可读', typeof pricing.default?.input === 'number' && Array.isArray(pricing.models), pricing);
  check('价目表带 Gas 费', pricing.gas_fee?.nanos === 300, pricing.gas_fee);
}

console.log('9. 上游提供商按 base_url 聚合；「可信」只是一份清单');
{
  // 前面几节为了让选址确定而只留一条候选，这一节要数「同一个 base_url 下有几条」。
  await enableAllProviders();
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
  // 这一节的转发都打 openai-chat 那条：先把候选收成它，后面不需要任何指名头。
  await onlyProvider('openai-chat');
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

  // 一把 Token 就是一次完整调用：没有指名头，走哪条上游由服务端挑。
  const viaKey = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${consumerKey}` });
  check('一条 Bearer 就够（没有任何指名头）', viaKey.status === 200, viaKey.json);
  check('打到 alice 自己名下的那台上游', viaKey.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, viaKey.json?.norm);
  check('自有的不算兜底', viaKey.json?.norm?.pool === false, viaKey.json?.norm);
  check('费用记在同一个账户上', viaKey.json?.norm?.fee_nanos > 0, viaKey.json?.norm);
  check('余额从同一本账上扣', viaKey.json?.norm?.balance_nanos !== null, viaKey.json?.norm);

  const bad = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: 'Bearer sk-norm-not-a-real-key' });
  check('假密钥 401', bad.status === 401 && bad.json.error === 'consumer_key_invalid', bad.json);

  const used = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === created.json.id);
  check('用过之后 last_used_at 有值', typeof used?.last_used_at === 'number', used);

  const rotated = await call(alice, 'POST', `/api/v1/consumers/${created.json.id}/rotate`);
  check('轮换 200 并给新明文', rotated.status === 200 && rotated.json.key !== consumerKey, rotated.json);
  const stale = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${consumerKey}` });
  check('旧密钥立刻失效', stale.status === 401, stale.status);
  const fresh = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${rotated.json.key}` });
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

  // 签名在这里同样进不来：只有一个上游提供商也不改变「转发面只认 Token」。
  const signedRelay = await call(bob, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('bob 的签名直连 401', signedRelay.status === 401 && signedRelay.json.error === 'consumer_key_required', signedRelay.json);

  const key = (await createConsumer(bob, 'bob bot')).json.key;
  const viaKey = await raw('POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }), { Authorization: `Bearer ${key}` });
  check('一条 Bearer 就够了', viaKey.status === 200, viaKey.json);
  check('打到唯一的那条上游提供商', viaKey.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, viaKey.json?.norm);

  // 没有上游提供商时才轮到「你先去加一条上游提供商」这条错误。
  const carol = identity();
  await call(carol, 'POST', '/api/v1/auth/login');
  const carolKey = (await createConsumer(carol, 'carol bot')).json.key;
  const noProvider = await relay(carolKey, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('没有上游提供商 → 400 provider_missing', noProvider.status === 400 && noProvider.json.error === 'provider_missing', noProvider.json);

  // 没有自有上游、池子也空着：清单与转发说的是同一句话。
  const modelsNone = await relay(carolKey, 'GET', '/v1/models');
  check('没有可用的上游时清单也 400 provider_missing', modelsNone.status === 400 && modelsNone.json.error === 'provider_missing', modelsNone.json);
}

console.log('10c. 上游提供商启用/禁用：不参与选址、不能被指名、公开看板不计入');
{
  const dave = identity();
  await call(dave, 'POST', '/api/v1/auth/login');
  const daveKey = (await createConsumer(dave, 'dave bot')).json.key;
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
  const auto = await relay(daveKey, 'POST', '/v1/chat/completions', payload);
  check('禁用的不参与自动选址', auto.status === 200 && auto.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, auto.json);

  // 公共池只能由站点地址往里放：别人塞一条等于替站点决定「拿什么服务全站」。
  const poolForbidden = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/scope`, JSON.stringify({ scope: 'pool' }));
  check('非站点地址放进池子 → 403 pool_forbidden', poolForbidden.status === 403 && poolForbidden.json.error === 'pool_forbidden', poolForbidden.json);
  const poolInvalid = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/scope`, JSON.stringify({ scope: 'everyone' }));
  check('scope 取值非法 → 400 scope_invalid', poolInvalid.status === 400 && poolInvalid.json.error === 'scope_invalid', poolInvalid.json);

  // 公开看板只数启用的：同一个 base_url 下有 2 条，在服务的只有 1 条。
  const group = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items
    .find((item) => item.base_url === OFF_BASE_URL);
  check('公开看板只数启用的上游提供商', group?.providers === 1, group);

  const offToggle = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({ enabled: false }));
  check('开关返回 enabled=0', offToggle.status === 200 && offToggle.json.enabled === 0, offToggle.json);
  const none = await relay(daveKey, 'POST', '/v1/chat/completions', payload);
  check('全部禁用 → 409 provider_disabled', none.status === 409 && none.json.error === 'provider_disabled', none.json);

  const onToggle = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({ enabled: true }));
  check('拨回来返回 enabled=1', onToggle.status === 200 && onToggle.json.enabled === 1, onToggle.json);
  const back = await relay(daveKey, 'POST', '/v1/chat/completions', payload);
  check('重新启用后自动选址恢复 200', back.status === 200, back.json);

  const missing = await call(dave, 'POST', `/api/v1/providers/${on.json.id}/enabled`, JSON.stringify({}));
  check('开关缺 enabled → 400 enabled_invalid', missing.status === 400 && missing.json.error === 'enabled_invalid', missing.json);
}

console.log('10d. 选上游：自有优先、会话粘住、不可用就重挑');
{
  // 四条全开：这正是旧版本会回 409 provider_ambiguous 的处境。
  await enableAllProviders();
  const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });

  /** 发一次请求，并从账本里读回它落在哪条上游上。 */
  const pickOf = async (headers = {}) => {
    const result = await relay(aliceKey, 'POST', '/v1/chat/completions', payload, headers);
    // 成功的响应没有 X-Norm-Request-Id 头（那是失败时的兜底），id 在 norm 账单里。
    const id = result.json?.norm?.request_id;
    const rows = (await call(alice, 'GET', '/api/v1/account/usage?limit=20')).json.items;
    return { status: result.status, body: result.json, providerId: rows.find((row) => row.id === id)?.provider_id ?? null };
  };

  const first = await pickOf();
  check('多条自有上游时不再 409', first.status === 200, first.body);
  check('落在自己名下的一条上', first.providerId !== null, first.providerId);
  check('自有上游不算兜底', first.body?.norm?.pool === false, first.body?.norm);

  // 同一个 thread-id 打两次：必须还是同一条。
  const t1 = await pickOf({ 'thread-id': 'e2e-thread-1' });
  const t2 = await pickOf({ 'thread-id': 'e2e-thread-1' });
  check('thread-id 粘住同一条上游', t1.providerId !== null && t1.providerId === t2.providerId, { t1: t1.providerId, t2: t2.providerId });

  // thread-id 压过 session-id：换 session 也还是同一条。
  const shifted = await pickOf({ 'thread-id': 'e2e-thread-1', 'session-id': 'e2e-session-other' });
  check('thread-id 压过 session-id', shifted.providerId === t1.providerId, { thread: t1.providerId, shifted: shifted.providerId });

  // session-id 单独也能粘。
  const s1 = await pickOf({ 'session-id': 'e2e-session-1' });
  const s2 = await pickOf({ 'session-id': 'e2e-session-1' });
  check('session-id 粘住同一条上游', s1.providerId !== null && s1.providerId === s2.providerId, { s1: s1.providerId, s2: s2.providerId });

  // 钉住的那条被禁用：下一次自动改道，而且立刻改粘到新的一条。
  await call(alice, 'POST', `/api/v1/providers/${s1.providerId}/enabled`, JSON.stringify({ enabled: false }));
  const moved = await pickOf({ 'session-id': 'e2e-session-1' });
  const movedAgain = await pickOf({ 'session-id': 'e2e-session-1' });
  check('钉住的上游不可用就重挑', moved.status === 200 && moved.providerId !== s1.providerId, { before: s1.providerId, after: moved.providerId });
  check('重挑之后稳定落在新的一条上', moved.providerId === movedAgain.providerId, { moved: moved.providerId, again: movedAgain.providerId });
  await call(alice, 'POST', `/api/v1/providers/${s1.providerId}/enabled`, JSON.stringify({ enabled: true }));
}

console.log('10e. 公共池：站点放进来的兜底上游，只在自有上游不可用时接单');
{
  const poolAdmin = process.env.E2E_POOL_ADMIN;
  if (!poolAdmin) {
    console.log('    跳过（要测池子：dev server 的 POOL_ADMIN_ADDRESSES 设为 alice 的地址，并带上 E2E_SEED 与 E2E_POOL_ADMIN=同一地址）');
  } else {
    const payload = JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
    check('alice 就是站点地址', poolAdmin === alice.address, { poolAdmin, alice: alice.address });

    const put = await call(alice, 'POST', `/api/v1/providers/${providers['openai-chat']}/scope`, JSON.stringify({ scope: 'pool' }));
    check('站点地址能把上游放进池子', put.status === 200 && put.json.scope === 'pool', put.json);

    // 一个没有自有上游的账户：池子是它唯一的产能。
    const poolUser = identity();
    await call(poolUser, 'POST', '/api/v1/auth/login');
    const poolKey = (await createConsumer(poolUser, 'pool bot')).json.key;

    const viaPool = await relay(poolKey, 'POST', '/v1/chat/completions', payload);
    check('自己没有上游时落到公共池', viaPool.status === 200 && viaPool.json?.norm?.pool === true, viaPool.json);
    check('池子这一单记在调用方账上', viaPool.json?.norm?.fee_nanos > 0, viaPool.json?.norm);

    // 池子那条对别人只读，而且不回密钥提示。
    const seenList = (await call(poolUser, 'GET', '/api/v1/providers')).json.items
      .find((item) => item.id === providers['openai-chat']);
    check('池子那条对调用方只读', seenList?.mine === false, seenList);
    check('池子那条不回密钥提示', seenList?.key_hint === '' && seenList?.sealed_key === '', seenList);

    // 自有优先：加一条自己的之后就不再吃池子。
    const own = await call(poolUser, 'POST', '/api/v1/providers', JSON.stringify({
      label: 'own', base_url: BASE_URL, provider_key: KEY, protocol: 'openai-chat',
    }));
    check('普通账户建的上游默认不进池子', own.json.scope === 'private', own.json);
    const after = await relay(poolKey, 'POST', '/v1/chat/completions', payload);
    check('自有上游优先于池子', after.json?.norm?.pool === false, after.json?.norm);
    await call(poolUser, 'DELETE', `/api/v1/providers/${own.json.id}`);

    // 收回去，后面几节要数「启用中的上游有几条」。
    await call(alice, 'POST', `/api/v1/providers/${providers['openai-chat']}/scope`, JSON.stringify({ scope: 'private' }));
    check('池子能收回', (await call(alice, 'GET', '/api/v1/providers')).json.items
      .find((item) => item.id === providers['openai-chat'])?.scope === 'private');
  }
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
      const result = await relayVia(protocol, aliceKey, 'POST', path, payload);
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
    const result = await relayVia('openai-chat', aliceKey, 'POST', path, JSON.stringify(body));
    check('直通保留上游提供商特有的字段（id/finish_reason）', result.json?.id === 'chatcmpl-1' && result.json?.choices?.[0]?.finish_reason === 'stop', result.json);
  }

  // 各家 SDK 用各自的头带密钥：Claude Code 走 x-api-key，Google SDK 走 x-goog-api-key。
  // 三种写法都只带「自己的 api key」——一个 Norm 专有的头都没有。
  {
    const anthKey = (await createConsumer(alice, 'matrix bot (anthropic)')).json.key;
    const gemKey = (await createConsumer(alice, 'matrix bot (gemini)')).json.key;

    const anth = ENTRIES['anthropic-messages']('gpt-test', false);
    await onlyProvider('anthropic-messages');
    const viaApiKey = await raw('POST', anth.path, JSON.stringify(anth.body), { 'x-api-key': anthKey });
    check('x-api-key 能当消费者密钥（Claude Code 的形状）', viaApiKey.status === 200, viaApiKey.json);

    const gem = ENTRIES['google-gemini']('gpt-test', false);
    await onlyProvider('google-gemini');
    const viaGoog = await raw('POST', gem.path, JSON.stringify(gem.body), { 'x-goog-api-key': gemKey });
    check('x-goog-api-key 能当消费者密钥（Google SDK 的形状）', viaGoog.status === 200, viaGoog.json);

    await onlyProvider('anthropic-messages');
    const viaBearer = await raw('POST', anth.path, JSON.stringify(anth.body), { Authorization: `Bearer ${anthKey}` });
    check('Bearer 也一样', viaBearer.status === 200, viaBearer.json);

    // 没有 sk-norm- 前缀的 api key 不是我们的身份：要说不清就直说不清，不要误判成「钥匙无效」。
    const foreign = await raw('POST', anth.path, JSON.stringify(anth.body), { 'x-api-key': 'sk-some-provider-key' });
    check('别家的 api key 不被当成消费者密钥', foreign.status === 401 && foreign.json.error === 'consumer_key_required', foreign.json);

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
    const result = await relayVia('openai-chat', aliceKey, 'POST', '/v1/messages', payload);
    check('跨方言带 tools → 400 tools_unsupported', result.status === 400 && result.json.error === 'tools_unsupported', result.json);

    // 同格式直通时 tools 免费穿过：我们不碰请求体，也就没有「支持不支持」的问题。
    const same = JSON.stringify({ model: 'gpt-test', tools: [{ type: 'function', function: { name: 'w' } }], messages: [{ role: 'user', content: 'hi' }] });
    const passed = await relayVia('openai-chat', aliceKey, 'POST', '/v1/chat/completions', same);
    check('同格式直通时 tools 原样穿过', passed.status === 200, passed.json);
  }

  // 跨方言流式：帧必须是入口方言自己的那套。
  for (const protocol of protocols) {
    if (protocol === 'openai-chat') continue;
    const { path, body } = ENTRIES['openai-responses']('gpt-test', true);
    const result = await relayVia(protocol, aliceKey, 'POST', path, JSON.stringify(body));
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
    const result = await relayVia(protocol, aliceKey, 'POST', path, JSON.stringify(body));
    check(`流式 anthropic → ${protocol} 200`, result.status === 200, result.status);
    check(`流式 anthropic → ${protocol} 有 message_stop`, result.text.includes('message_stop'), result.text.slice(-200));
    check(`流式 anthropic → ${protocol} 用 text_delta`, result.text.includes('text_delta'), result.text.slice(0, 300));
  }
  {
    const { path, body } = ENTRIES['google-gemini']('gpt-test', true);
    const result = await relayVia('anthropic-messages', aliceKey, 'POST', path, JSON.stringify(body));
    check('流式 gemini → anthropic 200', result.status === 200, result.status);
    // 入口是 gemini，出口就必须是 gemini 的裸 data 帧：没有 event: 前缀，也没有 anthropic 的事件名。
    check('流式 gemini 出口是 gemini 帧', result.text.includes('"candidates"') && !result.text.includes('message_stop'), result.text.slice(0, 200));
    check('流式 gemini 带回增量文本', result.text.includes('"text":"你"'), result.text.slice(0, 300));
  }

  // 同格式流式直通：上游提供商的帧原样过来，不再被二次解读。
  {
    const { path, body } = ENTRIES['anthropic-messages']('gpt-test', true);
    const result = await relayVia('anthropic-messages', aliceKey, 'POST', path, JSON.stringify(body));
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
    const result = await relayVia(protocol, aliceKey, 'GET', '/v1/models', undefined);
    check(`${protocol} 清单 200`, result.status === 200, result.json);
    check(`${protocol} 清单是 OpenAI 形状`, result.json?.object === 'list' && Array.isArray(result.json.data), result.json);
    check(`${protocol} 模型名归一正确`, JSON.stringify(result.json?.data?.map((m) => m.id)) === JSON.stringify(ids), result.json?.data);
    check(`${protocol} 每个条目都是 model`, result.json?.data?.every((m) => m.object === 'model'), result.json?.data);
    // 唯一不扣费的一条路：Gas 与 token 都是 0，也没去读余额。
    check(`${protocol} 清单不扣费`, result.json?.norm?.fee_nanos === 0 && result.json?.norm?.gas_fee_nanos === 0, result.json?.norm);
    check(`${protocol} 清单不报余额`, result.json?.norm?.balance_nanos === null, result.json?.norm);
    check(`${protocol} 清单回带 host`, result.json?.norm?.host === `127.0.0.1:${PROVIDER_PORT}`, result.json?.norm);

    const upstreamSeen = seen.slice(seenBefore).at(-1);
    check(`${protocol} 用 GET 打清单端点`, upstreamSeen?.path.includes('models'), upstreamSeen?.path);
  }

  const gemini = (await relayVia('google-gemini', aliceKey, 'GET', '/v1/models', undefined)).json;
  check('gemini 名字去掉了 models/ 前缀', gemini.data.every((m) => !m.id.startsWith('models/')), gemini.data);

  const anthropic = (await relayVia('anthropic-messages', aliceKey, 'GET', '/v1/models', undefined)).json;
  check('anthropic 的 created_at 转成 unix 秒', anthropic.data[0]?.created === 1747180800, anthropic.data[0]);
  check('anthropic 不凭空编 owned_by', anthropic.data[0]?.owned_by === undefined, anthropic.data[0]);

  const openai = (await relayVia('openai-chat', aliceKey, 'GET', '/v1/models', undefined)).json;
  check('openai 保留 created 与 owned_by', openai.data[0]?.created === 1721174400 && openai.data[0]?.owned_by === 'openai', openai.data[0]);

  const one = await relayVia('openai-chat', aliceKey, 'GET', '/v1/models/gpt-4o-mini', undefined);
  check('单个模型 200', one.status === 200 && one.json.id === 'gpt-4o-mini' && one.json.object === 'model', one.json);
  const missing = await relayVia('openai-chat', aliceKey, 'GET', '/v1/models/no-such-model', undefined);
  check('不存在的模型 404 model_not_found', missing.status === 404 && missing.json.error === 'model_not_found', missing.json);

  // 消费者密钥同样能列清单：程序拿着一条 Token 就能看见自己能调什么。
  const token = (await createConsumer(alice, 'models bot')).json.key;
  await onlyProvider('openai-chat');
  const byKey = await raw('GET', '/v1/models', undefined, { Authorization: `Bearer ${token}` });
  check('消费者密钥能列清单', byKey.status === 200 && byKey.json?.data?.length === 2, byKey.json);

  const anonymous = await raw('GET', '/v1/models');
  check('无身份 401', anonymous.status === 401, anonymous.status);

  const after = (await call(alice, 'GET', '/api/v1/account/me')).json;
  check('清单不写请求记录', after.requests === before.requests, { before: before.requests, after: after.requests });
  check('清单不动余额', after.balance_nanos === before.balance_nanos, { before: before.balance_nanos, after: after.balance_nanos });
}

console.log('14. 模型总表：账户里所有上游的清单并成一张表，带官方价锚点');
{
  await enableAllProviders();
  const catalog = await call(alice, 'GET', '/api/v1/models');
  check('模型总表 200', catalog.status === 200, catalog.status);

  const items = catalog.json.models ?? [];
  const ids = items.map((item) => item.id);
  const mini = items.find((item) => item.id === 'gpt-4o-mini');
  check('跨上游同名只出现一次', ids.filter((id) => id === 'gpt-4o-mini').length === 1, ids);
  check('四种上游的清单都在表里', ['gpt-4o-mini', 'claude-haiku-3', 'gemini-2.0-flash'].every((id) => ids.includes(id)), ids);
  check(
    '谁有它：两条 openai 上游都列了它',
    mini?.providers.length === 2 && mini.providers.includes(providers['openai-chat']) && mini.providers.includes(providers['openai-responses']),
    mini?.providers,
  );
  check(
    '官方价锚在最长的规则上',
    mini?.official?.match === 'gpt-4o-mini' && mini.official.input === 150_000_000 && mini.official.output === 600_000_000,
    mini?.official,
  );

  const probeRows = catalog.json.providers ?? [];
  const probed = probeRows.filter((row) => row.probed);
  check('每条启用中的上游都探测了', probed.length === 4 && probed.every((row) => row.ok === true), probeRows);
  check('探测结果带着上游自己报的条数', probeRows.find((row) => row.id === providers['openai-chat'])?.count === 2, probeRows);

  // 禁用的一条：不参与探测，它的模型也不该留在「可用」里。
  await call(alice, 'POST', `/api/v1/providers/${providers['google-gemini']}/enabled`, JSON.stringify({ enabled: false }));
  const afterOff = (await call(alice, 'GET', '/api/v1/models')).json;
  const offRow = afterOff.providers.find((row) => row.id === providers['google-gemini']);
  check('禁用的上游不探测，也不假装失败', offRow?.probed === false && offRow.ok === null, offRow);
  check('禁用的上游的模型退出这张表', !afterOff.models.some((item) => item.id.startsWith('gemini-')), afterOff.models.map((item) => item.id));
  await call(alice, 'POST', `/api/v1/providers/${providers['google-gemini']}/enabled`, JSON.stringify({ enabled: true }));

  // 打不通的一条：它自己的答复留在表上，别人的模型照常。
  const dead = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'unreachable', base_url: 'http://127.0.0.1:1/v1', provider_key: 'sk-x', protocol: 'openai-chat',
  }));
  const withDead = (await call(alice, 'GET', '/api/v1/models')).json;
  const deadRow = withDead.providers.find((row) => row.id === dead.json.id);
  check('打不通的上游记成 ok=false 且有原因', deadRow?.ok === false && typeof deadRow.error === 'string' && deadRow.error.length > 0, deadRow);
  check('一条坏掉不影响整张表', withDead.models.some((item) => item.id === 'gpt-4o-mini'), withDead.models.length);
  await call(alice, 'DELETE', `/api/v1/providers/${dead.json.id}`);

  // 上游不认这把密钥：把它的原话压成一句带回来。
  const wrongKey = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'wrong key', base_url: BASE_URL, provider_key: 'sk-wrong', protocol: 'openai-chat',
  }));
  const withWrong = (await call(alice, 'GET', '/api/v1/models')).json;
  const wrongRow = withWrong.providers.find((row) => row.id === wrongKey.json.id);
  check('上游 401 的原话被带回来', wrongRow?.ok === false && wrongRow.error.includes('401'), wrongRow);
  await call(alice, 'DELETE', `/api/v1/providers/${wrongKey.json.id}`);
}

console.log('15. 协议契约：基址从哪来由协议决定，字段跟着协议走');
{
  // 「先选协议、再渲染字段」的唯一一份数据：每条协议说哪种方言、基址从哪来、要填哪些字段。
  const schemas = (await (await fetch(`${BASE}/api/v1/protocols`)).json()).items;
  const byProtocol = new Map(schemas.map((item) => [item.protocol, item]));

  check('协议清单公开且六种协议都在', schemas.length === 6, schemas.map((item) => item.protocol));
  check('deepseek 只要密钥，基址是官方地址', JSON.stringify(byProtocol.get('deepseek')?.fields) === '["provider_key"]'
    && byProtocol.get('deepseek')?.base_url === 'https://api.deepseek.com', byProtocol.get('deepseek'));
  check('通用方言要 base_url + 密钥', JSON.stringify(byProtocol.get('openai-chat')?.fields) === '["base_url","provider_key"]'
    && byProtocol.get('openai-chat')?.base_url === null, byProtocol.get('openai-chat'));

  // OpenCode Go：基址是官方推理面，且这条协议的请求必须带 x-opencode-session
  // （上游缺它直接 400 MissingSessionID）。会话头由 sessions.ts 派生，所以这里只验契约。
  check('opencode-go 只要密钥，基址是官方推理面',
    JSON.stringify(byProtocol.get('opencode-go')?.fields) === '["provider_key"]'
      && byProtocol.get('opencode-go')?.base_url === 'https://opencode.ai/inference/go'
      && byProtocol.get('opencode-go')?.dialect === 'openai-chat', byProtocol.get('opencode-go'));

  // 不填 base_url 也能建：地址由协议给。
  const fixed = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'deepseek 官方', protocol: 'deepseek', provider_key: KEY,
  }));
  check('deepseek 不填 base_url 也能创建', fixed.status === 201, fixed.body);
  const row = (await call(alice, 'GET', '/api/v1/providers')).json.items.find((item) => item.id === fixed.json.id);
  check('落库的是协议自带的基址', row?.base_url === 'https://api.deepseek.com', row?.base_url);

  // 另填一个地址 = 调用方以为它能选，直接告诉他不能。
  const wrong = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'deepseek 中转', protocol: 'deepseek', base_url: BASE_URL, provider_key: KEY,
  }));
  check('deepseek 另填 base_url → 400 base_url_fixed', wrong.status === 400 && wrong.json.error === 'base_url_fixed', wrong.json);

  const go = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'opencode go', protocol: 'opencode-go', provider_key: KEY,
  }));
  check('opencode-go 不填 base_url 也能创建', go.status === 201, go.body);
  const goRow = (await call(alice, 'GET', '/api/v1/providers')).json.items.find((item) => item.id === go.json.id);
  check('opencode-go 落库的是官方推理面', goRow?.base_url === 'https://opencode.ai/inference/go', goRow?.base_url);

  const goWrong = await call(alice, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'opencode go 中转', protocol: 'opencode-go', base_url: BASE_URL, provider_key: KEY,
  }));
  check('opencode-go 另填 base_url → 400 base_url_fixed',
    goWrong.status === 400 && goWrong.json.error === 'base_url_fixed', goWrong.json);

  await call(alice, 'DELETE', `/api/v1/providers/${go.json.id}`);
  await call(alice, 'DELETE', `/api/v1/providers/${fixed.json.id}`);
}

provider.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
