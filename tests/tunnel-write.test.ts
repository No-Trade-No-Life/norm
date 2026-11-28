import { describe, expect, it } from 'vitest';

import { writeInChunks } from '../src/tunnel';

/** 记下每一次 TLS 写的字节数，以及块间有没有等 socket。 */
function recorder() {
  const writes: number[] = [];
  let readyAwaits = 0;
  const tls = {
    write: (data: Uint8Array) => {
      writes.push(data.byteLength);
      return undefined;
    },
  };
  const upstream = {
    get ready() {
      readyAwaits += 1;
      return Promise.resolve();
    },
  };
  return { writes, done: () => ({ readyAwaits }), tls, upstream };
}

describe('隧道里的请求体写入', () => {
  it('按 16 KiB 分块写，顺序与小大都不变', () => {
    const r = recorder();
    const body = new Uint8Array(64 * 1024);
    for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
    return writeInChunks(r.tls, r.upstream, body).then(() => {
      expect(r.writes).toEqual([16 * 1024, 16 * 1024, 16 * 1024, 16 * 1024]);
    });
  });

  it('小请求体一次写完，不多切', async () => {
    const r = recorder();
    await writeInChunks(r.tls, r.upstream, new Uint8Array(100));
    expect(r.writes).toEqual([100]);
  });

  it('块间等 socket 消化：每块都对应一次背压等待', async () => {
    const r = recorder();
    await writeInChunks(r.tls, r.upstream, new Uint8Array(40 * 1024));
    expect(r.done().readyAwaits).toBe(3);
  });

  it('空请求体不写任何字节', async () => {
    const r = recorder();
    await writeInChunks(r.tls, r.upstream, new Uint8Array(0));
    expect(r.writes).toEqual([]);
  });
});
