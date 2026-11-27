import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '../src/ids';
import { sha256Hex, signingMessage, verifySignature } from '../src/crypto';

const encoder = new TextEncoder();

function newIdentity() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, address: base58.encode(publicKey) };
}

describe('base58', () => {
  it('往返编解码 32 字节公钥', () => {
    const { address } = newIdentity();
    const bytes = base58.decode(address);
    expect(bytes.length).toBe(32);
    expect(base58.encode(bytes)).toBe(address);
  });

  it('保留前导零字节', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    expect(base58.encode(bytes).startsWith('11')).toBe(true);
    expect([...base58.decode(base58.encode(bytes))]).toEqual([...bytes]);
  });

  it('拒绝非法字符', () => {
    expect(() => base58.decode('0OIl')).toThrow();
  });
});

describe('签名', () => {
  const fields = { method: 'post', path: '/v1/chat/completions', timestamp: '1700000000' };

  it('接受正确签名，且大小写不敏感', () => {
    const { seed, address } = newIdentity();
    const message = signingMessage({ ...fields, bodySha256Hex: sha256Hex(encoder.encode('{"a":1}')) });
    const signature = base58.encode(ed25519.sign(message, seed));
    expect(verifySignature({ address, signature, message })).toBe(true);
    expect(verifySignature({ address, signature, message: signingMessage({ ...fields, bodySha256Hex: sha256Hex(encoder.encode('{"a":2}')) }) })).toBe(false);
  });

  it('路径或时间戳变化都会让签名失效', () => {
    const { seed, address } = newIdentity();
    const body = sha256Hex(new Uint8Array());
    const signature = base58.encode(ed25519.sign(signingMessage({ ...fields, bodySha256Hex: body }), seed));
    expect(verifySignature({ address, signature, message: signingMessage({ ...fields, path: '/v1/models', bodySha256Hex: body }) })).toBe(false);
    expect(verifySignature({ address, signature, message: signingMessage({ ...fields, timestamp: '1700000001', bodySha256Hex: body }) })).toBe(false);
  });

  it('坏地址、坏签名、错长度都返回 false 而不是抛错', () => {
    const message = signingMessage({ ...fields, bodySha256Hex: sha256Hex(new Uint8Array()) });
    expect(verifySignature({ address: '0OIl', signature: '1111', message })).toBe(false);
    expect(verifySignature({ address: base58.encode(new Uint8Array(32)), signature: base58.encode(new Uint8Array(64)), message })).toBe(false);
    expect(verifySignature({ address: base58.encode(new Uint8Array(16)), signature: base58.encode(new Uint8Array(64)), message })).toBe(false);
  });
});

describe('待签名串', () => {
  it('空 body 的哈希是 e3b0c442…', () => {
    expect(sha256Hex(new Uint8Array()).slice(0, 8)).toBe('e3b0c442');
  });

  it('字段顺序固定', () => {
    const text = new TextDecoder().decode(signingMessage({ method: 'GET', path: '/x', timestamp: '1', bodySha256Hex: 'h' }));
    expect(text).toBe('norm-v1\nGET\n/x\n1\nh');
  });
});
