/**
 * 端到端验证：起一个会说四种协议的假上游提供商，用真实 Ed25519 身份打真实 Worker（wrangler dev）。
 *
 * 覆盖：开户、签名验签、重放矩阵（读放行 / 创建只一行 / 修改不二次生效 / rotate 409 /
 * 时间窗外 401）、body 篡改、上游提供商密钥的封装与解封、协议不匹配、
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

/**
 * 一份签名。默认每次都是新的 nonce 与当前时间戳；`options` 可以钉住其中一个：
 * 重放矩阵要的正是「同一份签名打两次」，以及「一小时前签的那一份」。
 */
function sign(who, method, path, body, options = {}) {
  const timestamp = String(options.at ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? base58.encode(crypto.getRandomValues(new Uint8Array(16)));
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

/** 大体量清单：横跨 D1 单条语句绑定变量上限的那条路径用它（见最后一节）。 */
const BULK_MODELS = Array.from({ length: 60 }, (_, index) => ({
  id: `bulk-${String(index).padStart(2, '0')}`,
  object: 'model',
  created: 1700000000,
  owned_by: 'bulk',
}));

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

    // 上游先回 200、再在流里报错：这是真实上游的常见形状（配额、模型下线、内容被拦）。
    // 它不能被当成「成功但零 token」记账，也不能让客户端只看到一片空白。
    if (parsed.model === 'silent-error-model') {
      if (url.pathname.endsWith('/responses')) {
        sse(response, [{ type: 'error', error: { message: 'quota exhausted for silent-error-model' } }]);
        return;
      }
      sse(response, [{ error: { message: 'quota exhausted for silent-error-model' } }]);
      return;
    }

    // 真实上游会把 SSE 拆成极小 TCP 分片（不含换行）、独立空 role 帧、独立 usage 帧与独立 [DONE] 帧：
    // pull() 若对单个空分片直接 return 而未循环读到有效输出，workerd 会提前断流且漏记账。
    if (parsed.model === 'fragmented-stream-model') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const raw = [
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: '碎' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: '片' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      const bytes = Buffer.from(raw, 'utf8');
      let offset = 0;
      const drip = () => {
        if (offset >= bytes.length) {
          response.end();
          return;
        }
        response.write(bytes.subarray(offset, offset + 11));
        offset += 11;
        setTimeout(drip, 1);
      };
      drip();
      return;
    }

    // 工具调用：请求里声明了哪个工具，假上游就按**这一家的形状**要一次调用。
    // 名字取自请求体，所以「声明有没有被翻译对」也一并验到了。
    const declared = {
      chat: parsed.tools?.[0]?.function?.name ?? parsed.tools?.[0]?.name,
      responses: parsed.tools?.[0]?.name,
      anthropic: parsed.tools?.[0]?.name,
      gemini: parsed.tools?.[0]?.functionDeclarations?.[0]?.name,
    };

    // 1) openai-chat
    if (url.pathname.endsWith('/chat/completions')) {
      if (declared.chat) {
        if (parsed.stream) {
          sse(response, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: declared.chat, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"上海"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ...(parsed.stream_options?.include_usage
              ? [{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }]
              : []),
          ]);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'chatcmpl-tool',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: declared.chat, arguments: '{"city":"上海"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }));
        return;
      }
      if (parsed.model === 'flaky-model') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          message: 'The supported API model names are gpt-test, but you passed flaky-model.',
          type: 'invalid_request_error',
        }));
        return;
      }
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
      if (declared.responses) {
        if (parsed.stream) {
          sse(response, [
            { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: declared.responses } },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":"上海"}' },
            { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 6 } } },
          ]);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'resp_tool',
          object: 'response',
          status: 'completed',
          model: parsed.model,
          output: [{ type: 'function_call', call_id: 'call_1', name: declared.responses, arguments: '{"city":"上海"}' }],
          usage: { input_tokens: 20, output_tokens: 6 },
        }));
        return;
      }
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
      if (declared.anthropic) {
        if (parsed.stream) {
          sse(response, [
            { type: 'message_start', message: { usage: { input_tokens: 15, output_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: declared.anthropic } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"上海"}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', usage: { output_tokens: 6 } },
          ]);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'msg_tool',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'tool_use', id: 'toolu_1', name: declared.anthropic, input: { city: '上海' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 6 },
        }));
        return;
      }
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
      if (declared.gemini) {
        sse(response, [
          {
            candidates: [{ content: { parts: [{ functionCall: { name: declared.gemini, args: { city: '上海' } } }] } }],
            usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5 },
          },
        ]);
        return;
      }
      sse(response, [
        { candidates: [{ content: { parts: [{ text: '你' }] } }] },
        { candidates: [{ content: { parts: [{ text: '好' }] } }], usageMetadata: { promptTokenCount: 18, cachedContentTokenCount: 12, candidatesTokenCount: 4 } },
      ]);
      return;
    }
    if (url.pathname.includes(':generateContent')) {
      if (declared.gemini) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: declared.gemini, args: { city: '上海' } } }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5 },
          modelVersion: parsed.model ?? 'gemini-test',
        }));
        return;
      }
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
      // 一条**大体量**清单：真实的聚合上游动辄几十上百条。夹具里的三五条凑不出
      // D1 的 100 个绑定变量，所以「写清单按条件撞上限」这类错只在线上出现——
      // 这条路径就是用来把那个尺寸搬进夹具的。
      if (url.pathname.includes('/big/') && url.pathname.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: BULK_MODELS }));
        return;
      }
      if (url.pathname.endsWith('/v1beta/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ models: [
          // `gpt-test` 是夹具默认的模型名：清单里必须有它，否则它会被按模型筛掉——
          // 假上游嘴上不认自己应答的型号，本来就不该被路由。
          { name: 'models/gpt-test', displayName: 'GPT Test' },
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
          { name: 'models/gemini-2.0-pro', displayName: 'Gemini 2.0 Pro' },
        ] }));
        return;
      }
      if (url.pathname.endsWith('/v1/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: 'gpt-test', type: 'model', created_at: '2025-05-14T00:00:00Z' },
          { id: 'claude-sonnet-4-20250514', type: 'model', created_at: '2025-05-14T00:00:00Z' },
          { id: 'claude-haiku-3', type: 'model', created_at: '2024-03-07T00:00:00Z' },
        ] }));
        return;
      }
      if (url.pathname.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [
          { id: 'gpt-test', object: 'model', created: 1721174400, owned_by: 'openai' },
          { id: 'gpt-4o-mini', object: 'model', created: 1721174400, owned_by: 'openai' },
          { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'openai' },
          // 清单说它有、跑起来却说没有的那种上游：验证 Norm 会划掉这一行并只重试一次。
          { id: 'flaky-model', object: 'model', created: 1715367049, owned_by: 'openai' },
          // 200 但流里只有一句错误：验证它不会被记成「成功但零 token」。
          { id: 'silent-error-model', object: 'model', created: 1715367049, owned_by: 'openai' },
          { id: 'fragmented-stream-model', object: 'model', created: 1715367049, owned_by: 'openai' },
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

async function createProvider(protocol) {
  const payload = JSON.stringify({
    label: `${protocol} provider`,
    base_url: BASE_URL,
    provider_key: KEY,
    protocol: protocol,
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

/**
 * 用**同一份**签名再发一次——连 nonce 都不换。重放矩阵要的就是这个：
 * 服务端必须按幂等键认出「这是同一次意图」，而不是当成第二次操作。
 */
async function resend(signature, method, path, body) {
  return raw(method, path, body, signature);
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
  // 演示授信是一张「抵扣券」，不是充值：它抵消费，但不可提现。
  check('授信记在抵扣券那一块', result.json.voucher_nanos === 1_000_000_000, result.json);
  check(
    '开户时其余三块都是 0',
    result.json.recharge_nanos === 0 && result.json.spend_nanos === 0 && result.json.withdraw_nanos === 0,
    result.json,
  );
  check('地址与本地公钥一致', result.json.address === alice.address, result.json);
}

console.log('2. 身份与完整性');
{
  check('未签名 401', (await fetch(`${BASE}/api/v1/account/me`)).status === 401);

  const path = '/api/v1/account/me';
  const headers = sign(alice, 'GET', path);
  check('首次 200', (await fetch(`${BASE}${path}`, { headers })).status === 200);
  // 读重放不是重放攻击：时间窗只管「这个签名新不新鲜」，读既不查也不写任何去重状态。
  // 完整矩阵见 2b。
  const replay = await fetch(`${BASE}${path}`, { headers });
  check('读重放仍然 200', replay.status === 200, replay.status);

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

/** 上游真正收到的清单请求数：用来证明「重放没有再触发一次后台刷新」。 */
const probeCount = () => seen.filter((row) => row.path.endsWith('/models')).length;

/** 等后台探测落定：连续两次读到同一个数就算稳（探测是 waitUntil 里跑的，比响应慢一拍）。 */
async function probeSettled() {
  let last = probeCount();
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = probeCount();
    if (current === last) return current;
    last = current;
  }
  return last;
}

console.log('2b. 重放矩阵：窗口只管新鲜度，一次性由幂等键保证');
{
  // ── 开户：行内幂等（主键就是地址，授信用 voucher_nanos = 0 兜住），不需要幂等键 ──
  const newcomer = identity();
  const loginPath = '/api/v1/auth/login';
  const loginSignature = sign(newcomer, 'POST', loginPath);
  const firstLogin = await resend(loginSignature, 'POST', loginPath);
  const secondLogin = await resend(loginSignature, 'POST', loginPath);
  check('登录首次 200 且 created=true', firstLogin.status === 200 && firstLogin.json.created === true, firstLogin.json);
  check('登录重放 200 且 created=false', secondLogin.status === 200 && secondLogin.json.created === false, secondLogin.json);
  check(
    '登录重放不会再发一张券',
    secondLogin.json.balance_nanos === 1_000_000_000 && secondLogin.json.voucher_nanos === 1_000_000_000,
    secondLogin.json,
  );

  // ── 读：重放直接放行，一行都不写 ───────────────────────────────────────
  const readPath = '/api/v1/account/me';
  const readSignature = sign(alice, 'GET', readPath);
  const firstRead = await fetch(`${BASE}${readPath}`, { headers: readSignature });
  const secondRead = await fetch(`${BASE}${readPath}`, { headers: readSignature });
  check('GET 首次 200', firstRead.status === 200, firstRead.status);
  check('GET 同一份签名再打一次仍是 200', secondRead.status === 200, secondRead.status);

  // ── 时间窗：超出 60 秒一律 401，与 nonce 无关 ───────────────────────────
  const staleAt = Math.floor(Date.now() / 1000) - 3600;
  const stale = await fetch(`${BASE}${readPath}`, { headers: sign(alice, 'GET', readPath, undefined, { at: staleAt }) });
  const staleBody = await stale.json();
  check('时间窗外的签名 401', stale.status === 401, stale.status);
  check('原因是 timestamp_out_of_window', staleBody.error === 'timestamp_out_of_window', staleBody);
  const future = await fetch(`${BASE}${readPath}`, {
    headers: sign(alice, 'GET', readPath, undefined, { at: Math.floor(Date.now() / 1000) + 3600 }),
  });
  check('未来一小时的时间戳也 401（窗口是双向的）', future.status === 401, future.status);

  // ── 创建：同一份签名打两次 → 库里只有一行 ──────────────────────────────
  // base_url 与后面的夹具分开，免得把「同一 base_url 有几条」那几节的计数带上。
  const createPath = '/api/v1/providers';
  const createBody = JSON.stringify({
    label: 'idempotent provider',
    base_url: `${BASE_URL}/idem`,
    provider_key: KEY,
    protocol: 'openai-chat',
  });
  const createSignature = sign(alice, 'POST', createPath, createBody);
  const created = await resend(createSignature, 'POST', createPath, createBody);
  check('创建首次 201', created.status === 201 && typeof created.json.id === 'string', created.json);
  const createdId = created.json.id;

  const createReplay = await resend(createSignature, 'POST', createPath, createBody);
  check('创建重放 200', createReplay.status === 200, createReplay.status);
  check('创建重放标着 replayed', createReplay.json.replayed === true, createReplay.json);
  check('创建重放回同一个 id', createReplay.json.id === createdId, createReplay.json.id);
  const listed = (await call(alice, 'GET', '/api/v1/providers')).json.items.filter((item) => item.id === createdId);
  check('库里只有一行（同一把幂等键造不出第二条）', listed.length === 1, listed.length);

  // ── 修改：重放不产生第二次副作用（第二次不许再抓一次模型清单）──────────
  await probeSettled();
  const probesBefore = probeCount();
  const patchPath = `/api/v1/providers/${createdId}`;
  const patchBody = JSON.stringify({ label: 'idempotent provider renamed' });
  const patchSignature = sign(alice, 'PATCH', patchPath, patchBody);
  const patched = await resend(patchSignature, 'PATCH', patchPath, patchBody);
  check('修改首次 200', patched.status === 200 && patched.json.replayed === undefined, patched.json);
  check('修改生效', (await call(alice, 'GET', '/api/v1/providers')).json.items.some((item) => item.id === createdId && item.label === 'idempotent provider renamed'));

  let probes = probesBefore;
  for (let i = 0; i < 80 && probes === probesBefore; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    probes = probeCount();
  }
  check('修改第一次顺手刷新了一次清单', probes === probesBefore + 1, { probesBefore, probes });

  const patchReplay = await resend(patchSignature, 'PATCH', patchPath, patchBody);
  check('修改重放 200 + replayed', patchReplay.status === 200 && patchReplay.json.replayed === true, patchReplay.json);
  await new Promise((resolve) => setTimeout(resolve, 800));
  check('修改重放没有再刷新清单（没有第二次副作用）', probeCount() === probes, { probes, after: probeCount() });

  // ── 建钥：重放不造第二行，也不交出第二把明文 ────────────────────────────
  const consumerPath = '/api/v1/consumers';
  const consumerBody = JSON.stringify({ name: 'idempotent bot' });
  const consumerSignature = sign(alice, 'POST', consumerPath, consumerBody);
  const minted = await resend(consumerSignature, 'POST', consumerPath, consumerBody);
  check('建钥首次 201 并给明文', minted.status === 201 && typeof minted.json.key === 'string', minted.json);
  const mintedReplay = await resend(consumerSignature, 'POST', consumerPath, consumerBody);
  check('建钥重放 200 + replayed', mintedReplay.status === 200 && mintedReplay.json.replayed === true, mintedReplay.json);
  check('建钥重放不再交出明文（新生成的那把根本没入库）', mintedReplay.json.key === undefined, mintedReplay.json);
  const mintedRows = (await call(alice, 'GET', '/api/v1/consumers')).json.items.filter((item) => item.id === minted.json.id);
  check('建钥重放没有第二行', mintedRows.length === 1, mintedRows.length);

  // ── 轮换：第二次必须 409，且绝不再签发第二把 ────────────────────────────
  const rotatePath = `/api/v1/consumers/${minted.json.id}/rotate`;
  const rotateSignature = sign(alice, 'POST', rotatePath);
  const rotated = await resend(rotateSignature, 'POST', rotatePath);
  check('轮换首次 200 并给新明文', rotated.status === 200 && typeof rotated.json.key === 'string', rotated.json);
  const rotateReplay = await resend(rotateSignature, 'POST', rotatePath);
  check('轮换重放 409', rotateReplay.status === 409, rotateReplay.status);
  check('轮换重放的原因是 nonce_replayed', rotateReplay.json.error === 'nonce_replayed', rotateReplay.json);
  check('轮换重放不签发第二把密钥', rotateReplay.json.key === undefined, rotateReplay.json);
  const rotatedRow = (await call(alice, 'GET', '/api/v1/consumers')).json.items.find((item) => item.id === minted.json.id);
  check('库里仍是第一次轮换换上的那一把', rotatedRow?.key_hint === rotated.json.key_hint, {
    live: rotatedRow?.key_hint,
    first: rotated.json.key_hint,
  });

  // ── 撤销：重放仍是 200，而不是「已经不存在了」的 404 ─────────────────────
  const deletePath = `/api/v1/providers/${createdId}`;
  const deleteSignature = sign(alice, 'DELETE', deletePath);
  const deleted = await resend(deleteSignature, 'DELETE', deletePath);
  check('撤销首次 200', deleted.status === 200 && deleted.json.revoked === true, deleted.json);
  const deleteReplay = await resend(deleteSignature, 'DELETE', deletePath);
  check('撤销重放 200 而不是 404', deleteReplay.status === 200, deleteReplay.status);
  check('撤销重放标着 replayed', deleteReplay.json.replayed === true, deleteReplay.json);

  // 这一节的消费者密钥不属于后面任何一节：撤掉，列表回到干净状态。
  await call(alice, 'DELETE', `/api/v1/consumers/${minted.json.id}`);
}

console.log('3. 上游提供商：明文密钥交给服务端封装，协议可配置');
const providers = {};
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini']) {
  const created = await createProvider(protocol);
  check(`${protocol} 创建 201`, created.status === 201 && typeof created.id === 'string', created.body);
  // 创建响应里只有 id：提示是服务端从明文算出来的，不该由客户端自报。
  check(`${protocol} 创建响应不含密钥`, !JSON.stringify(created.body).includes(KEY), created.body);
  providers[protocol] = created.id;
}
{
  for (const [field, value, code] of [
    ['protocol', 'anthropic', 'protocol_invalid'],
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
  // 一次调用的钱 = 动态 Gas 费 + 三项 token 折出来的钱：
  // openai-chat 是这把钥匙当日首次调用（含 +1,000 consumer_touch = 3,420 纳）；
  // 后续三条同日调用免 touch，加 +100 跨方言桥接 CPU = 2,520 纳。
  const wantGas = protocol === 'openai-chat' ? 3420 : 2520;
  check(`${protocol} 动态 Gas 费 ${wantGas} 纳美元`, norm?.gas_fee_nanos === wantGas, norm);
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
  if (protocol !== 'openai-chat') {
    check(`${protocol} 跨方言流式带 finish_reason`, result.text.includes('"finish_reason":"stop"'), result.text.slice(-300));
  }
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
  check('流式直通动态 Gas 费 2,480 纳美元（同日免 touch，含 +60 流式 CPU）', norm?.gas_fee_nanos === 2480, norm);
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
  check('失败也扣 2,420 纳美元动态 Gas（响应头）', result.headers.get('x-norm-gas-fee-nanos') === '2420', result.headers.get('x-norm-gas-fee-nanos'));
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
{
  const me = (await call(alice, 'GET', '/api/v1/account/me')).json;
  const okCalls = 4 + 4 + 1; // 四协议各一次 + 流式各一次 + 7 里那一次
  const rows = (await call(alice, 'GET', '/api/v1/account/usage?limit=200')).json.items;
  const failures = rows.filter((row) => row.status !== 'ok');
  check('requests 计数与实际记录一致', me.requests === rows.length, { counted: me.requests, rows: rows.length });
  check('记录里既有成功也有失败', okCalls > 0 && failures.length > 0, { okCalls, failures: failures.length });
  check('三项 token 合计可读', (me.usage?.input_tokens ?? 0) > 0 && (me.usage?.cached_tokens ?? 0) > 0 && (me.usage?.output_tokens ?? 0) > 0, me.usage);
  check('费用按 Gas + token 拆开', (me.billed?.gas_fee_nanos ?? 0) > 0 && (me.billed?.token_nanos ?? 0) > 0, me.billed);

  const ledger = (await call(alice, 'GET', '/api/v1/account/ledger?limit=200')).json;
  // 消费不在账本里：一次调用花掉多少是请求自己的事，账本只记账户级的钱。
  check('账本里没有 charge', ledger.items.every((row) => row.kind !== 'charge'), ledger.items.map((row) => row.kind));
  check('账本不再带 request_id', ledger.items.every((row) => !('request_id' in row)), ledger.items[0]);
  check('流水带了翻页游标', typeof ledger.items[0]?.cursor === 'number', ledger.items[0]);
  // 每条请求自己带着「这一笔之前 / 之后」的累计消费：delta 就是它扣掉的钱。
  check(
    '每条请求的累计消费 delta == 它扣的钱',
    rows.every((row) => row.spend_after_nanos - row.spend_before_nanos === row.fee_nanos),
    rows.filter((row) => row.spend_after_nanos - row.spend_before_nanos !== row.fee_nanos),
  );
  check('累计消费只增', rows.every((row) => row.spend_after_nanos >= row.spend_before_nanos), rows[0]);
  // 请求按 id 倒序（UUID v7），所以第一行就是最新一条：它的 after 就是账户花掉的总数。
  check('最新一条请求的累计消费 == 账户累计消费', rows[0].spend_after_nanos === me.spend_nanos, {
    row: rows[0].spend_after_nanos,
    spend: me.spend_nanos,
  });

  // 余额不落库：它必须永远等于「充值 + 抵扣券 − 消费 − 提现」这一句算式。
  check(
    '余额 == 充值 + 抵扣券 − 消费 − 提现',
    me.balance_nanos === me.recharge_nanos + me.voucher_nanos - me.spend_nanos - me.withdraw_nanos,
    {
      balance: me.balance_nanos,
      recharge: me.recharge_nanos,
      voucher: me.voucher_nanos,
      spend: me.spend_nanos,
      withdraw: me.withdraw_nanos,
    },
  );
  // 四块累计数各自只增：这半天只发生过消费，另外三块一动没动。
  check(
    '只有消费那一块在动',
    me.voucher_nanos === 1_000_000_000 && me.recharge_nanos === 0 && me.withdraw_nanos === 0,
    { voucher: me.voucher_nanos, recharge: me.recharge_nanos, withdraw: me.withdraw_nanos },
  );
  // 两本账各记一半：账本记进项（券 + 充值 − 提现），请求记消费，合起来才是可用余额。
  const sum = ledger.items.reduce((total, row) => total + row.amount_nanos, 0);
  check('账本求和 − 累计消费 == 当前余额', sum - me.spend_nanos === me.balance_nanos, {
    ledger: sum,
    spend: me.spend_nanos,
    balance: me.balance_nanos,
  });
  const charged = rows.reduce((total, row) => total + row.fee_nanos, 0);
  check('累计消费 == 请求扣费之和', me.spend_nanos === charged, { spend: me.spend_nanos, charged });
  // 这个账户只开过一次户：账本里就那一张券。
  check('账本只有开户那一张券', ledger.items.length === 1, {
    ledger: ledger.items.length,
    kinds: ledger.items.map((row) => row.kind),
  });
  const opening = ledger.items.at(-1);
  check('最早一条是开户那张券', opening?.kind === 'voucher' && opening?.amount_nanos === me.voucher_nanos, opening);
  check('开户那一刻的可用余额 == 券面额', opening?.available_after_nanos === opening?.amount_nanos, opening);

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
  // 审计要回答「钱进了谁的口袋、又是谁花的」——记地址（公钥）而不是库内 id。
  check('审计记下了上游用户的地址', ok.every((row) => typeof row.provider_user === 'string' && row.provider_user.length > 20), ok.slice(0, 2));
  // 推理面现在只认下游密钥，所以每条记录都该有下游用户；空值只可能出现在历史行里。
  check('每条记录都有下游用户的地址', ok.every((row) => typeof row.consumer_user === 'string' && row.consumer_user.length > 20), ok.slice(0, 2));
  check('用钥匙的行，下游用户就是账户地址', rows.filter((row) => row.consumer_id).every((row) => row.consumer_user === alice.address), rows.filter((row) => row.consumer_id).slice(0, 2));
  const meLatency = me.latency;
  check('账户级延迟统计可读', typeof meLatency?.avg_latency_ms === 'number' && (meLatency?.streamed_requests ?? 0) > 0, meLatency);
  check('失败那条只扣 Gas、token 为 0', usage.items.some((row) => row.status !== 'ok' && row.fee_nanos === 2420 && row.gas_fee_nanos === 2420 && row.token_nanos === 0 && row.input_tokens === 0), usage.items.find((row) => row.status !== 'ok'));

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
  check(
    '价目表带动态 Gas 费与安全阈值',
    pricing.gas_fee?.base_nanos === 300 &&
      pricing.gas_fee?.floor_nanos === 2420 &&
      pricing.gas_fee?.min_balance_nanos === 10000 &&
      pricing.gas_fee?.margin_bps === 0,
    pricing.gas_fee,
  );
}

console.log('9. 上游提供商按 base_url 聚合；「可信」只是一份清单');
{
  // 前面几节为了让选址确定而只留一条候选，这一节要数「同一个 base_url 下有几条」。
  await enableAllProviders();
  const groups = (await (await fetch(`${BASE}/api/v1/base-urls`)).json()).items;
  const group = groups.find((item) => item.base_url === BASE_URL);
  check('按 base_url 聚合成一条', group !== undefined, groups);
  check('统计了上游提供商数量', group?.providers === 4, group);
  // 「公开」只有一个语义：进公共池。alice 名下的这些都没进，所以池子计数是 0。
  check('没人进公共池时 pool 计数为 0', group?.pool === 0, group);
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

console.log('10c2. 编辑上游提供商：配置可改、密钥可换不可看');
{
  const erin = identity();
  await call(erin, 'POST', '/api/v1/auth/login');
  const EDIT_BASE_URL = `${BASE_URL}-edit`;
  const created = await call(erin, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'before', base_url: EDIT_BASE_URL, provider_key: KEY, protocol: 'openai-chat',
  }));
  const id = created.json.id;

  // 改配置：只发要改的字段，没发的保持不动。
  const patched = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({
    label: 'after', protocol: 'openai-responses', enabled: false,
  }));
  check('PATCH 200', patched.status === 200, patched.json);
  const rowOf = async () => (await call(erin, 'GET', '/api/v1/providers')).json.items.find((item) => item.id === id);
  const row = await rowOf();
  check('标签已更新', row?.label === 'after', row?.label);
  check('协议已更新', row?.protocol === 'openai-responses', row?.protocol);
  check('启用状态已更新', row?.enabled === 0, row?.enabled);
  check('没提交的 base_url 保持不变', row?.base_url === EDIT_BASE_URL, row?.base_url);

  // 换密钥：只回提示（前 4 后 4），明文任何一条响应里都不出现。
  const rerolled = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({ provider_key: 'sk-new-secret-9876' }));
  check('换密钥 200', rerolled.status === 200, rerolled.json);
  const afterKey = await rowOf();
  check('密钥提示更新为前后各四位', afterKey?.key_hint === 'sk-n…9876', afterKey?.key_hint);
  check('列表里没有新密钥明文', !JSON.stringify(afterKey).includes('sk-new-secret-9876'), afterKey);

  // 基址由协议决定：固定基址的协议不接受另一个地址。
  const fixed = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({
    protocol: 'deepseek', base_url: EDIT_BASE_URL,
  }));
  check('固定基址协议另填地址 → 400 base_url_fixed', fixed.status === 400 && fixed.json.error === 'base_url_fixed', fixed.json);
  const toFixed = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({ protocol: 'deepseek' }));
  check('切到 deepseek 200', toFixed.status === 200, toFixed.json);
  const fixedRow = await rowOf();
  check('deepseek 的基址由协议给定', fixedRow?.base_url === 'https://api.deepseek.com', fixedRow?.base_url);

  // 从固定基址换回通用方言：必须自己给地址，不能沿用厂商的。
  const noBase = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({ protocol: 'openai-chat' }));
  check('切回通用方言缺 base_url → 400 base_url_invalid', noBase.status === 400 && noBase.json.error === 'base_url_invalid', noBase.json);

  // 改完立刻生效：下一次转发就打新地址，证明目的地在库里而不是缓存或请求头里。
  const edited = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({
    // 顺手把密钥换回假上游认的那把：上面那一步已经证明「只回提示不回明文」，
    // 这里要验证的是地址切过去之后请求真的打得到。
    protocol: 'openai-chat', base_url: `${EDIT_BASE_URL}-v2`, enabled: true, provider_key: KEY,
  }));
  check('改 base_url 200', edited.status === 200, edited.json);
  // 推理面只认下游消费者 Token：编辑完用一把 Token 验证新地址立刻生效。
  const erinKey = (await call(erin, 'POST', '/api/v1/consumers', JSON.stringify({ name: 'erin e2e' }))).json.key;
  const sent = await relay(erinKey, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }],
  }));
  check('转发 200', sent.status === 200, sent.json);
  check('转发立刻改打新地址', seen.at(-1)?.path === `/v1/${RUN}-edit-v2/chat/completions`, seen.at(-1)?.path);

  // 编辑校验与归属：空标签、别人的 provider 都不行。
  const nameless = await call(erin, 'PATCH', `/api/v1/providers/${id}`, JSON.stringify({ label: '   ' }));
  check('空标签 → 400 label_missing', nameless.status === 400 && nameless.json.error === 'label_missing', nameless.json);
  const notMine = await call(erin, 'PATCH', `/api/v1/providers/${providers['openai-chat']}`, JSON.stringify({ label: 'stolen' }));
  check('编辑别人的 provider → 404', notMine.status === 404 && notMine.json.error === 'provider_not_found', notMine.json);
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

  // 跨方言的工具调用会翻译：Anthropic 入口的 tools → Chat 上游的 function 包装，回来是 tool_use。
  {
    const payload = JSON.stringify({
      model: 'gpt-test',
      max_tokens: 128,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = await relayVia('openai-chat', aliceKey, 'POST', '/v1/messages', payload);
    check('跨方言带 tools → 200，且回来的是 tool_use 块', result.status === 200 && result.json?.content?.[0]?.type === 'tool_use', result.json);
    check('跨方言的工具调用带 stop_reason=tool_use', result.json?.stop_reason === 'tool_use', result.json?.stop_reason);

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
  // 顺序与假上游给的顺序一致：这一节验的是「归一」，不是排序。
  // `gpt-test` 在四条清单里都有 —— 夹具用它当默认模型名，清单里就必须有它，
  // 否则转发会按模型把请求筛掉（见最后一节）。
  const WANT = {
    'openai-chat': ['gpt-test', 'gpt-4o-mini', 'gpt-4o', 'flaky-model', 'silent-error-model', 'fragmented-stream-model'],
    'openai-responses': ['gpt-test', 'gpt-4o-mini', 'gpt-4o', 'flaky-model', 'silent-error-model', 'fragmented-stream-model'],
    'anthropic-messages': ['gpt-test', 'claude-sonnet-4-20250514', 'claude-haiku-3'],
    'google-gemini': ['gpt-test', 'gemini-2.0-flash', 'gemini-2.0-pro'],
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
  // 模型名现在也是选址条件：谁的清单里都没有它时，在选址这一步就拒绝了
  // （`model_not_served`），而不是先挑一条上游再去它的清单里找。
  check('不存在的模型 404 model_not_served', missing.status === 404 && missing.json.error === 'model_not_served', missing.json);

  // 消费者密钥同样能列清单：程序拿着一条 Token 就能看见自己能调什么。
  const token = (await createConsumer(alice, 'models bot')).json.key;
  await onlyProvider('openai-chat');
  const byKey = await raw('GET', '/v1/models', undefined, { Authorization: `Bearer ${token}` });
  check('消费者密钥能列清单', byKey.status === 200 && byKey.json?.data?.length === 6, byKey.json);

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
  check('探测结果带着上游自己报的条数', probeRows.find((row) => row.id === providers['openai-chat'])?.count === 6, probeRows);

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


console.log('\nN. 转发按模型筛上游：没在清单里的型号不硬打');
{
  // 干净的身份：这一节不依赖前面几节留下的上游、启用状态与亲和。
  const watcher = identity();
  await call(watcher, 'POST', '/api/v1/auth/login');
  const created = await call(watcher, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'catalog provider',
    base_url: BASE_URL,
    provider_key: KEY,
    protocol: 'openai-chat',
  }));
  check('新身份建一条上游 201', created.status === 201, created.json);
  const key = (await createConsumer(watcher, 'catalog bot')).json.key;
  check('拿到一把下游 Token', typeof key === 'string' && key.length > 0, key);

  const ask = (model) => relay(key, 'POST', '/v1/chat/completions', JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
  }));

  // 清单还没抓过：不知道它有没有，就不该拿一张空表把请求拦下来。
  const beforeSync = await ask('gpt-test');
  check('清单还没抓过时照常转发（不知道 ≠ 没有）', beforeSync.status === 200, beforeSync.json);

  // 读一次总表：这次读取顺手把清单写进 provider_models，转发从此按模型筛。
  const catalog = await call(watcher, 'GET', '/api/v1/models');
  check('模型总表里有 gpt-test', (catalog.json.models ?? []).some((item) => item.id === 'gpt-test'), catalog.json.models);

  const listed = await ask('gpt-test');
  check('清单里有的型号继续能跑', listed.status === 200, listed.json);

  const stranger = await ask('stranger-model');
  check('谁都没有的型号 → 404 model_not_served', stranger.status === 404 && stranger.json?.error === 'model_not_served', stranger.json);

  const flakyFirst = await ask('flaky-model');
  check(
    '清单说它有、上游说没有 → 上游原话回传（400）',
    flakyFirst.status === 400 && String(flakyFirst.json?.message ?? '').includes('flaky-model'),
    flakyFirst.json,
  );

  // 那一次失败已经把清单里这一行划掉、把这条会话的粘性清掉；没有别的候选可换，
  // 于是这一次直接说没有，而不是再白打一次上游。
  const flakySecond = await ask('flaky-model');
  check(
    '划掉的型号下一次直接 404，不再白打上游',
    flakySecond.status === 404 && flakySecond.json?.error === 'model_not_served',
    flakySecond.json,
  );

  // 划掉的只是「这一次的修正」，不是事实：清单端点还在说它有它，再同步又会回来。
  // 这条断言是故意留着的行为说明——想让它长期消失，得改上游或关掉那条上游。
  const again = await call(watcher, 'GET', '/api/v1/models');
  check(
    '再同步一次，以清单端点为准（划掉不等于改写事实）',
    (again.json.models ?? []).some((item) => item.id === 'flaky-model'),
    (again.json.models ?? []).map((item) => item.id),
  );

  // 大体量清单：60 条模型要写成 60 行，而 D1 每次查询最多 100 个绑定变量。
  // 线上就是因为一条 INSERT 塞了 40 行 × 3 个变量，让整个模型页 500。
  const big = await call(watcher, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'bulk provider',
    base_url: `http://127.0.0.1:${PROVIDER_PORT}/v1/big`,
    provider_key: KEY,
    protocol: 'openai-chat',
  }));
  check('大体量上游建得起来 201', big.status === 201, big.json);

  const bulk = await call(watcher, 'GET', '/api/v1/models');
  check('大体量清单也读得出来 200', bulk.status === 200, bulk.json?.error ?? bulk.status);
  const bulkRow = (bulk.json?.providers ?? []).find((row) => row.id === big.json.id);
  check('大体量上游报出自己的 60 条', bulkRow?.count === 60, bulkRow);
  check(
    '大体量清单整份落进了总表（没被绑定变量上限截断）',
    (bulk.json?.models ?? []).filter((item) => item.id.startsWith('bulk-')).length === 60,
    (bulk.json?.models ?? []).filter((item) => item.id.startsWith('bulk-')).length,
  );
}

console.log('\nN+1. 工具调用的翻译：跨方言也能用');
{
  // 干净身份：先只给一条 Responses 方言的上游（DeepSeek 那一族说的就是它）。
  const tooler = identity();
  await call(tooler, 'POST', '/api/v1/auth/login');
  const responses = await call(tooler, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'responses only', base_url: BASE_URL, provider_key: KEY, protocol: 'openai-responses',
  }));
  check('建一条 Responses 方言的上游 201', responses.status === 201, responses.json);
  const key = (await createConsumer(tooler, 'tools bot')).json.key;

  /** 上游最近收到的那一帧（按路径认，免得被建上游时的清单同步抢走）。 */
  const lastTo = (suffix) => seen.filter((entry) => entry.path.endsWith(suffix)).at(-1);

  const weatherTool = {
    type: 'function',
    function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
  };
  const weatherCall = { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } };
  const askWeather = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: '上海几度？' }],
    tools: [weatherTool],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  };

  // 1) Chat 入口（带 tools）→ Responses 上游：声明翻过去，工具调用翻回来。
  const answered = await relay(key, 'POST', '/v1/chat/completions', JSON.stringify(askWeather));
  check('Chat 入口带 tools → Responses 上游 200', answered.status === 200, answered.json);
  const backToChat = answered.json?.choices?.[0];
  check(
    '回到 Chat 方言：tool_calls 的名字与参数都在',
    backToChat?.message?.tool_calls?.[0]?.function?.name === 'get_weather'
      && backToChat?.message?.tool_calls?.[0]?.function?.arguments === '{"city":"上海"}',
    backToChat?.message,
  );
  check('finish_reason 是 tool_calls（不是 stop）', backToChat?.finish_reason === 'tool_calls', backToChat?.finish_reason);

  const toResponses = lastTo('/responses');
  check(
    '上游收到的是 Responses 形状的 tools（扁平，没有 function 包装）',
    toResponses?.body?.tools?.[0]?.name === 'get_weather' && toResponses.body.tools[0].function === undefined,
    toResponses?.body?.tools,
  );
  check(
    'tool_choice 翻成 Responses 的说法',
    toResponses?.body?.tool_choice?.type === 'function' && toResponses?.body?.tool_choice?.name === 'get_weather',
    toResponses?.body?.tool_choice,
  );

  // 2) 把工具结果带回去：Chat 的 role=tool → Responses 的 function_call_output。
  const roundTrip = await relay(key, 'POST', '/v1/chat/completions', JSON.stringify({
    ...askWeather,
    messages: [
      { role: 'user', content: '上海几度？' },
      { role: 'assistant', content: null, tool_calls: [weatherCall] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
    ],
  }));
  check('带工具结果的第二轮 200', roundTrip.status === 200, roundTrip.json);
  const secondAsk = lastTo('/responses');
  check(
    '工具结果翻成 function_call_output，call_id 对得上',
    secondAsk?.body?.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output === '{"temp":21}'),
    secondAsk?.body?.input,
  );
  check(
    'assistant 的调用翻成 function_call 条目',
    secondAsk?.body?.input?.some((item) => item.type === 'function_call' && item.name === 'get_weather' && item.call_id === 'call_1'),
    secondAsk?.body?.input,
  );

  // 3) 反向：Anthropic 入口 → Chat 上游。
  await call(tooler, 'POST', `/api/v1/providers/${responses.json.id}/enabled`, JSON.stringify({ enabled: false }));
  const chatProvider = await call(tooler, 'POST', '/api/v1/providers', JSON.stringify({
    label: 'chat upstream', base_url: BASE_URL, provider_key: KEY, protocol: 'openai-chat',
  }));
  check('换成一条 Chat 方言的上游 201', chatProvider.status === 201, chatProvider.json);

  const viaAnthropic = await relay(key, 'POST', '/v1/messages', JSON.stringify({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: '上海几度？' }],
  }));
  check('Anthropic 入口带 tools → Chat 上游 200', viaAnthropic.status === 200, viaAnthropic.json);
  const block = viaAnthropic.json?.content?.[0];
  check(
    '回到 Anthropic 方言：tool_use 块，input 是对象',
    block?.type === 'tool_use' && block?.name === 'get_weather' && block?.input?.city === '上海',
    block,
  );
  check('stop_reason 是 tool_use', viaAnthropic.json?.stop_reason === 'tool_use', viaAnthropic.json?.stop_reason);

  const toChat = lastTo('/chat/completions');
  check(
    '上游收到的是 Chat 形状的 tools（套一层 function）',
    toChat?.body?.tools?.[0]?.type === 'function' && toChat?.body?.tools?.[0]?.function?.parameters?.type === 'object',
    toChat?.body?.tools,
  );
  check('tool_choice 的 any 翻成 required', toChat?.body?.tool_choice === 'required', toChat?.body?.tool_choice);

  // 4) Gemini 入口 → Chat 上游：functionCall 与 functionResponse 都要落地。
  const viaGemini = await relay(key, 'POST', '/v1/models/gpt-test:generateContent', JSON.stringify({
    tools: [{ functionDeclarations: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
    contents: [{ role: 'user', parts: [{ text: '上海几度？' }] }],
  }));
  check('Gemini 入口带工具 → Chat 上游 200', viaGemini.status === 200, viaGemini.json);
  const part = viaGemini.json?.candidates?.[0]?.content?.parts?.[0];
  check(
    '回到 Gemini 方言：functionCall part，args 是对象',
    part?.functionCall?.name === 'get_weather' && part?.functionCall?.args?.city === '上海',
    part,
  );
  const toChatFromGemini = lastTo('/chat/completions');
  check(
    '声明翻成 Chat 的 function 包装（Gemini → Chat）',
    toChatFromGemini?.body?.tools?.[0]?.function?.name === 'get_weather',
    toChatFromGemini?.body?.tools,
  );

  // 5) Gemini 的 functionResponse 只说得出函数名：翻成 Chat 的 role=tool 要补上调用 id。
  const geminiRoundTrip = await relay(key, 'POST', '/v1/models/gpt-test:generateContent', JSON.stringify({
    tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
    contents: [
      { role: 'user', parts: [{ text: '上海几度？' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
    ],
  }));
  check('Gemini 带工具结果的第二轮 200', geminiRoundTrip.status === 200, geminiRoundTrip.json);
  const chatRoundTrip = lastTo('/chat/completions');
  const assistantTurn = chatRoundTrip?.body?.messages?.find((message) => message.role === 'assistant' && message.tool_calls?.length);
  const toolTurn = chatRoundTrip?.body?.messages?.find((message) => message.role === 'tool');
  check(
    '按函数名找回了调用 id：assistant.tool_calls 与 tool.tool_call_id 一致',
    assistantTurn?.tool_calls?.[0]?.id !== undefined && assistantTurn.tool_calls[0].id === toolTurn?.tool_call_id,
    { assistantTurn, toolTurn },
  );
}

console.log('N+2. 上游 200 + 流里的错误帧：不许记成「成功但零 token」');
{
  // 同格式（chat 入口 → chat 上游）：错误帧本来就原样转发，这里验的是账单说实话。
  const sameShape = await relayVia('openai-chat', aliceKey, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'silent-error-model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  check('同格式：HTTP 仍按上游说的 200 回', sameShape.status === 200, sameShape.status);
  check('同格式：流里没有内容增量', !sameShape.text.includes('"content":"'), sameShape.text.slice(0, 200));
  check('同格式：上游的原话在流里', sameShape.text.includes('quota exhausted for silent-error-model'), sameShape.text.slice(0, 300));

  // 跨方言（chat 入口 → responses 上游）：错误帧不该被适配器悄悄丢掉。
  const bridged = await relayVia('openai-responses', aliceKey, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'silent-error-model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  check('跨方言：客户端收到 error 帧', bridged.text.includes('"error"') && bridged.text.includes('quota exhausted for silent-error-model'), bridged.text.slice(0, 300));
  check('跨方言：仍然有结尾的 norm 与 DONE', bridged.text.includes('"norm"') && bridged.text.trimEnd().endsWith('data: [DONE]'), bridged.text.slice(-160));

  // 账单：一句话都没生成 → 只有 Gas，没有 token；状态记成 provider_error 而不是 ok。
  const usage = await call(alice, 'GET', '/api/v1/account/usage?limit=20');
  const rows = (usage.json.items ?? []).filter((row) => row.model === 'silent-error-model');
  check('两次空响应都被记下来了', rows.length >= 2, rows.length);
  check('状态是 provider_error（不是 ok）', rows.every((row) => row.status === 'provider_error'), rows.map((row) => row.status));
  check('token 为 0、只收 Gas', rows.every((row) => row.input_tokens === 0 && row.output_tokens === 0), rows.slice(0, 2));
}

console.log('N+3. 分片滴流 SSE：部分行/空帧/独立 [DONE] 不得提前断流或漏记账');
{
  const pass = await relayVia('openai-chat', aliceKey, 'POST', '/v1/chat/completions', JSON.stringify({
    model: 'fragmented-stream-model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  const passNormLine = pass.text.split('\n').filter((l) => l.startsWith('data: {') && l.includes('"norm"')).at(-1);
  const passNorm = passNormLine ? JSON.parse(passNormLine.slice(6)).norm : null;
  check('直通分片流 200 且完整收到「碎片」', pass.status === 200 && pass.text.includes('"content":"碎"') && pass.text.includes('"content":"片"'), pass.text.slice(0, 300));
  check('直通分片流带回 norm 与 [DONE]', passNorm !== null && pass.text.trimEnd().endsWith('data: [DONE]'), pass.text.slice(-200));
  check('直通分片流准确记下三项 token 与 2,480 Gas', passNorm?.input_tokens === 15 && passNorm?.cached_tokens === 5 && passNorm?.output_tokens === 4 && passNorm?.gas_fee_nanos === 2480, passNorm);
  check('直通分片流客户端未要用量时不透传用量帧', !pass.text.includes('"prompt_tokens_details"'), pass.text.slice(-300));

  const bridged = await relayVia('openai-chat', aliceKey, 'POST', '/v1/messages', JSON.stringify({
    model: 'fragmented-stream-model',
    max_tokens: 32,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  check('跨方言分片流 200 且带 message_start 与完整 text_delta', bridged.status === 200 && bridged.text.includes('message_start') && bridged.text.includes('content_block_start') && bridged.text.includes('碎') && bridged.text.includes('片'), bridged.text.slice(0, 300));
  check('跨方言分片流收尾带 message_stop', bridged.text.includes('message_stop'), bridged.text.slice(-200));
  const reqId = bridged.headers.get('x-norm-request-id');
  const rows = (await call(alice, 'GET', '/api/v1/account/usage?limit=20')).json.items ?? [];
  const row = rows.find((item) => item.id === reqId);
  check('跨方言分片流已落账且记下 token 与 2,580 Gas', row?.input_tokens === 15 && row?.output_tokens === 4 && row?.gas_fee_nanos === 2580, row);
}

provider.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
