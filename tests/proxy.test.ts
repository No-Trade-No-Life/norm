import { describe, expect, it } from 'vitest';

import { createByteSource, chunkedBody, parseProxyUrl, proxyHintOf, untilEnd } from '../src/proxy';

const encoder = new TextEncoder();

/** 把几段字节喂成一条「读一次吐一段、吐完就结束」的流。 */
function readerOf(chunks: Uint8Array[]): () => Promise<Uint8Array | undefined> {
  let index = 0;
  return async () => (index < chunks.length ? chunks[index++] : undefined);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += new TextDecoder().decode(value);
  }
}

describe('parseProxyUrl', () => {
  it('收下 http://host:port', () => {
    expect(parseProxyUrl('http://10.0.0.1:8888')).toEqual({ host: '10.0.0.1', port: 8888, authorization: '' });
  });

  it('把 user:pass 折成一条 Basic 认证头', () => {
    const target = parseProxyUrl('http://norm:s3cret@proxy.example.com:3128');
    expect(target).toEqual({
      host: 'proxy.example.com',
      port: 3128,
      authorization: `Basic ${btoa('norm:s3cret')}`,
    });
  });

  it('没写端口就是 80', () => {
    expect(parseProxyUrl('http://proxy.example.com')?.port).toBe(80);
  });


  it('带路径的地址是把代理和转发器搞混了', () => {
    expect(parseProxyUrl('http://proxy.example.com:8888/v1')).toBeNull();
  });

  it('乱七八糟的输入一律不收', () => {
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('proxy.example.com:8888')).toBeNull();
    expect(parseProxyUrl('socks5://proxy.example.com:1080')).toBeNull();
  });
});

describe('proxyHintOf', () => {
  it('密码位置换成 ***', () => {
    expect(proxyHintOf('http://norm:s3cret@proxy.example.com:8888')).toBe('http://***@proxy.example.com:8888');
  });

  it('没有凭据就照原样显示', () => {
    expect(proxyHintOf('http://proxy.example.com:8888')).toBe('http://proxy.example.com:8888');
  });

  it('解析不了就什么都不显示', () => {
    expect(proxyHintOf('nonsense')).toBe('');
  });
});

describe('createByteSource', () => {
  it('跨块拼出一整行', async () => {
    const source = createByteSource(readerOf([encoder.encode('HTTP/1.1 2'), encoder.encode('00 OK\r\n')]));
    expect(await source.line()).toBe('HTTP/1.1 200 OK');
  });

  it('把行剩下的字节留给下一次读', async () => {
    const source = createByteSource(readerOf([encoder.encode('a\r\nrest')]));
    expect(await source.line()).toBe('a');
    expect(new TextDecoder().decode(await source.take(64))).toBe('rest');
  });
});

describe('chunkedBody', () => {
  it('解掉分块外壳', async () => {
    const source = createByteSource(readerOf([encoder.encode('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n')]));
    expect(await drain(chunkedBody(source))).toBe('Wikipedia');
  });

  it('分块写在半路也能拼起来', async () => {
    const source = createByteSource(
      readerOf([encoder.encode('8\r\ndata: o'), encoder.encode('k\r\n0\r\n\r\n')]),
    );
    expect(await drain(chunkedBody(source))).toBe('data: ok');
  });

  it('忽略分块扩展', async () => {
    const source = createByteSource(readerOf([encoder.encode('2;ext=1\r\nhi\r\n0\r\n\r\n')]));
    expect(await drain(chunkedBody(source))).toBe('hi');
  });
});

describe('untilEnd', () => {
  it('一直读到对端收尾', async () => {
    const source = createByteSource(readerOf([encoder.encode('abc'), encoder.encode('def')]));
    expect(await drain(untilEnd(source))).toBe('abcdef');
  });
});

describe('https 代理：到代理这一跳也加密', () => {
  it('scheme 决定 tls 与默认端口，其余形状不变', () => {
    expect(parseProxyUrl('http://h.example:8080')).toEqual({ host: 'h.example', port: 8080, authorization: '' });
    expect(parseProxyUrl('https://h.example')).toEqual({ host: 'h.example', port: 443, authorization: '', tls: true });
    expect(parseProxyUrl('https://u:p@h.example:8443')).toEqual({
      host: 'h.example',
      port: 8443,
      authorization: `Basic ${btoa('u:p')}`,
      tls: true,
    });
  });

  it('提示里保留 scheme：看到 https:// 就知道这一段是加密的', () => {
    expect(proxyHintOf('https://u:p@h.example:8443')).toBe('https://***@h.example:8443');
    expect(proxyHintOf('http://h.example:8080')).toBe('http://h.example:8080');
  });

  it('别的 scheme 仍然不认（隧道只实现 CONNECT）', () => {
    expect(parseProxyUrl('socks5://h.example:1080')).toBeNull();
  });
});
