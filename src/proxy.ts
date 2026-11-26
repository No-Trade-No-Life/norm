/**
 * 代理这条路的「语义」那半：地址怎么解析、隧道里的字节怎么切成 HTTP 消息。
 *
 * 另一半在 `src/tunnel.ts`——真的去连代理、在隧道里握手。切在这里是因为这一半不碰 socket、
 * 也不碰 TLS，能在普通 Node 环境里被测试。
 *
 * 为什么需要代理：Worker 的 `fetch` 出站由 Cloudflare 自己发起，会给请求盖上 `cf-*` 那几枚
 * 保留头（`cf-worker` / `cf-connecting-ip`），用户代码删不掉也盖不住。有的上游见到它们就
 * 直接 403（ChatGPT 的 responses 端点），于是「能连通」和「能被接受」是两件事。隧道里的字节
 * 由代理重新发出，这些头自然不存在——它绕开的是**身份**判定，不是可达性。
 */

const decoder = new TextDecoder('latin1');

/** 解析好的代理坐标。`authorization` 为空串表示代理不要求认证。 */
export type ProxyTarget = {
  host: string;
  port: number;
  authorization: string;
};

/**
 * `http://host:port` 或 `http://user:pass@host:port`，其余一律不认。
 *
 * 返回 null 而不是抛错：调用方只有「能不能用」这一个决定要做，具体哪里不对由它自己说。
 */
export function parseProxyUrl(raw: string): ProxyTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  // 只收明文 HTTP 代理：`https://` 代理要在隧道外面再套一层 TLS，收益为零、路径多一条。
  if (url.protocol !== 'http:' || url.hostname === '') return null;
  // 带路径的地址一定把「代理」和「转发器」搞混了：代理只认一个主机加一个端口。
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  const authorization =
    url.username === '' ? '' : `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
  return { host: url.hostname, port: url.port === '' ? 80 : Number(url.port), authorization };
}

/** 展示用提示：密码位置换成 `***`。代理在哪不是秘密，凭据是。 */
export function proxyHintOf(raw: string): string {
  const target = parseProxyUrl(raw);
  if (target === null) return '';
  return target.authorization === '' ? `http://${target.host}:${target.port}` : `http://***@${target.host}:${target.port}`;
}

/** 隧道那一层的读写：只有这两个动词，够 HTTP/1.1 用了。 */
export type Tunnel = {
  read: () => Promise<Uint8Array | undefined>;
  write: (data: Uint8Array) => Promise<void>;
};

/** 能按「一行」和「若干字节」取数的字节源：HTTP/1.1 的切分只需要这两个动作。 */
type ByteSource = {
  line: () => Promise<string>;
  take: (limit: number) => Promise<Uint8Array>;
};

export function createByteSource(read: () => Promise<Uint8Array | undefined>): ByteSource {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let ended = false;

  const line = async (): Promise<string> => {
    for (;;) {
      const end = indexOfCrlf(buffer);
      if (end >= 0) {
        const text = decoder.decode(buffer.slice(0, end));
        buffer = buffer.subarray(end + 2);
        return text;
      }
      if (ended) throw new Error('连接在响应读完之前就断了');
      const value = await read();
      if (value === undefined) {
        ended = true;
        continue;
      }
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
    }
  };

  const take = async (limit: number): Promise<Uint8Array> => {
    while (buffer.length === 0 && !ended) {
      const value = await read();
      if (value === undefined) ended = true;
      else buffer = value;
    }
    const size = Math.min(limit, buffer.length);
    // 复制到自己的 ArrayBuffer 上：往流里塞视图会把上一块的缓冲一起带过去。
    const out = new Uint8Array(buffer.subarray(0, size));
    buffer = buffer.subarray(size);
    return out;
  };

  return { line, take };
}

/** 分块传输解码成一条纯数据流。 */
export function chunkedBody(source: ByteSource): ReadableStream<Uint8Array> {
  let remaining = 0;
  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        const size = Number.parseInt((await source.line()).split(';')[0], 16);
        if (!Number.isFinite(size)) throw new Error('分块长度读不出来');
        if (size === 0) {
          // trailer 读干净，socket 才不会吊在半路。
          while ((await source.line()) !== '') {}
          controller.close();
          return;
        }
        remaining = size;
      }
      const chunk = await source.take(remaining);
      remaining -= chunk.byteLength;
      if (remaining === 0) await source.line();
      if (chunk.byteLength === 0) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** 没有分块也没有长度时，一直读到对端收尾为止。 */
export function untilEnd(source: ByteSource): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const chunk = await source.take(64 * 1024);
      if (chunk.byteLength === 0) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** 把隧道里出来的字节读成一条 `Response`：状态行、头、然后按它的框架把 body 交出去。 */
export async function readResponse(tunnel: Tunnel): Promise<Response> {
  const source = createByteSource(tunnel.read);
  const statusLine = await source.line();
  const status = Number(statusLine.split(' ')[1]);
  if (!Number.isFinite(status)) throw new Error(`上游的响应行读不出来：${statusLine}`);

  const headers = new Headers();
  for (;;) {
    const line = await source.line();
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const chunked = (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
  // 逐跳头在这里就该退场：body 已经由我们自己重新分帧，再交给 Response 只会打架。
  for (const name of ['transfer-encoding', 'connection', 'content-length', 'keep-alive']) headers.delete(name);

  if (status === 204 || status === 304) return new Response(null, { status, headers });
  return new Response(chunked ? chunkedBody(source) : untilEnd(source), { status, headers });
}

function indexOfCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

/** 代理响应头（以及隧道建立后第一段数据）的分界。 */
export function indexOfHeadEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}
