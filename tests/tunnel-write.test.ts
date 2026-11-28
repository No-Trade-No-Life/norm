import { describe, expect, it } from 'vitest';

import { writeInChunks } from '../src/tunnel';

describe('隧道里的请求体写入', () => {
  const collect = async (size: number) => {
    const chunks: Uint8Array[] = [];
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) body[i] = i % 251;
    await writeInChunks(async (chunk) => {
      chunks.push(chunk.slice());
      return undefined;
    }, body);
    return { chunks, body };
  };

  it('按 16 KiB 分块，且拼回去与原文逐字节相同', async () => {
    const { chunks, body } = await collect(64 * 1024);
    expect(chunks.map((c) => c.byteLength)).toEqual([16384, 16384, 16384, 16384]);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.byteLength;
    }
    expect(joined).toEqual(body);
  });

  it('小请求体一次写完，不多切', async () => {
    const { chunks } = await collect(100);
    expect(chunks.map((c) => c.byteLength)).toEqual([100]);
  });

  it('空请求体不写任何字节', async () => {
    const { chunks } = await collect(0);
    expect(chunks).toEqual([]);
  });
});
