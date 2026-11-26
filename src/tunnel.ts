/**
 * 代理这条路的「传输」那半：连代理、开 CONNECT 隧道、在隧道里握手，然后把一次请求发出去。
 *
 * 为什么 TLS 必须自己做：运行时 `startTls()` 的 SNI 钉死在 `connect()` 的主机上，隧道里再
 * 握手就等于拿着代理的证书去验目标站。所以隧道内层换成 subtls 在用户态握手，代价是信任锚
 * 要自带一份（见 `src/ca-roots.ts`）——那是打包时的一份根证书快照。
 */
import { connect } from 'cloudflare:sockets';
import { LazyReadFunctionReadQueue, startTls } from 'subtls';
import { CA_ROOTS } from './ca-roots';
import type { Env } from './env';
import { unsealProviderKey } from './seal';
import { indexOfHeadEnd, parseProxyUrl, readResponse, type ProxyTarget, type Tunnel } from './proxy';

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

/**
 * 连代理、开隧道、在隧道里握手。
 *
 * INVARIANT: 代理回的那一行必须是 2xx。407 说明凭据不对，别的说明它不肯转——两种都要把原话
 * 交出去，不能让调用方以为「上游坏了」。
 */
async function openTunnel(proxy: ProxyTarget, host: string): Promise<Tunnel> {
  const socket = connect({ hostname: proxy.host, port: proxy.port });
  const writer = socket.writable.getWriter();
  await writer.write(
    encoder.encode(
      [
        `CONNECT ${host}:443 HTTP/1.1`,
        `Host: ${host}:443`,
        ...(proxy.authorization === '' ? [] : [`Proxy-Authorization: ${proxy.authorization}`]),
        '',
        '',
      ].join('\r\n'),
    ),
  );
  writer.releaseLock();

  const reader = socket.readable.getReader();
  let pending = new Uint8Array(0);
  let status = '';
  // 读到响应头为止。头之后的字节已经在隧道里了（可能正是服务端的 ServerHello），不能丢。
  while (status === '') {
    const { value, done } = await reader.read();
    if (done) throw new Error('代理在隧道建立之前就断开了');
    const merged = new Uint8Array(pending.length + value.length);
    merged.set(pending);
    merged.set(value, pending.length);
    const end = indexOfHeadEnd(merged);
    if (end < 0) {
      pending = merged;
      continue;
    }
    status = decoder.decode(merged.slice(0, end)).split('\r\n')[0];
    pending = merged.slice(end + 4);
  }
  if (!/^HTTP\/1\.[01] 2\d\d/.test(status)) throw new Error(`代理拒绝隧道：${status}`);

  const queue = new LazyReadFunctionReadQueue(async () => {
    if (pending.length > 0) {
      const out = pending;
      pending = new Uint8Array(0);
      return out;
    }
    const { value, done } = await reader.read();
    return done ? undefined : value;
  });
  const upstream = socket.writable.getWriter();
  // subtls 的写回调是同步的，错误没法抛回去；写失败时 socket 已经断了，下一次读会如实报错。
  const tls = await startTls(host, CA_ROOTS, queue.read.bind(queue), (data) => {
    upstream.write(data).catch(() => undefined);
  });
  return { read: () => tls.read(), write: (data) => tls.write(data) };
}

/**
 * 请求体归一成字节：转发面递进来的可能是字符串（JSON），也可能是二进制（音频上传）。
 * 流与表单不在支持之列——这条路上我们得自己算 Content-Length。
 */
async function bodyBytes(body: BodyInit | undefined): Promise<Uint8Array | undefined> {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error('代理这条路上只支持字符串或二进制请求体');
}

/**
 * 一次走上游代理的请求。
 *
 * 请求侧固定发 HTTP/1.1 + `Accept-Encoding: identity`：压缩过的响应体到不了 SSE 解析器手里，
 * 而省下的那点带宽在这里没有意义。
 *
 * ASSUMPTION: 这条路上不接 `AbortSignal`——隧道里的读没有可取消的原语，硬取消只会把半个响应
 * 留在 socket 里。挂在隧道上的请求由 Worker 自己的执行时限结束。
 */
export async function fetchViaProxy({
  proxy,
  url,
  init,
}: {
  proxy: ProxyTarget;
  url: string;
  init: { method: string; headers: Record<string, string>; body?: BodyInit };
}): Promise<Response> {
  const target = new URL(url);
  const tunnel = await openTunnel(proxy, target.hostname);

  const body = (await bodyBytes(init.body)) ?? null;
  const lines = [
    `${init.method} ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: close',
    'Accept-Encoding: identity',
  ];
  for (const [name, value] of Object.entries(init.headers)) lines.push(`${name}: ${value}`);
  if (body !== null) lines.push(`Content-Length: ${body.byteLength}`);
  await tunnel.write(encoder.encode(`${lines.join('\r\n')}\r\n\r\n`));
  if (body !== null) await tunnel.write(body);

  return readResponse(tunnel);
}

/**
 * 把一次上游请求发出去：这条上游配了代理就进隧道，没配就是普通 `fetch`。
 *
 * 两条路都交回一个 `Response`，调用方不必知道走的是哪条——记账、桥接、直通都照旧。
 */
export async function sendUpstream({
  env,
  address,
  provider,
  url,
  init,
}: {
  env: Env;
  /** 上游主人的地址（公共池那条属于站点），与解密钥用的是同一个。 */
  address: string;
  provider: { id: string; sealed_proxy: string };
  url: string;
  init: { method?: string; headers: Record<string, string>; body?: BodyInit };
}): Promise<Response> {
  if (provider.sealed_proxy === '') return fetch(url, init);
  const raw = await unsealProviderKey({ env, address, providerId: provider.id, sealed: provider.sealed_proxy });
  const proxy = parseProxyUrl(raw);
  // INVARIANT: 写入前已用同一个解析器校验过；解析不出来说明库被绕过路由改过。
  if (proxy === null) throw new Error('这条上游的代理地址读不出来');
  return fetchViaProxy({ proxy, url, init: { method: init.method ?? 'GET', headers: init.headers, body: init.body } });
}
