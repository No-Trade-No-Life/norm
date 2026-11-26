import { describe, expect, it } from 'vitest';

import { idempotentId } from '../src/idempotent';

const base = {
  address: '7Yb5Y3fCk1nKk9QyYb1nH7dd4nQ2fZ9tM5F7o3Yb1nKk',
  method: 'POST',
  path: '/api/v1/providers',
  nonce: '3xJ7c2kQ9mZp1sVt4nRb6L',
};

describe('幂等键派生行 id', () => {
  it('同一个签名请求打两次 → 同一个 id（于是第二条 INSERT 落空）', () => {
    expect(idempotentId(base)).toBe(idempotentId({ ...base }));
  });

  it('22 位十六进制：够短、也够宽（88 位）', () => {
    expect(idempotentId(base)).toMatch(/^[0-9a-f]{22}$/);
  });

  it('四个字段各改一个，id 都跟着变', () => {
    const id = idempotentId(base);
    expect(idempotentId({ ...base, address: `${base.address}x` })).not.toBe(id);
    expect(idempotentId({ ...base, method: 'PUT' })).not.toBe(id);
    expect(idempotentId({ ...base, path: '/api/v1/consumers' })).not.toBe(id);
    expect(idempotentId({ ...base, nonce: `${base.nonce}x` })).not.toBe(id);
  });

  it('方法大小写归一：签名串里的 METHOD 本来就是大写的', () => {
    expect(idempotentId({ ...base, method: 'post' })).toBe(idempotentId(base));
  });

  it('query 不进派生：签名覆盖的 PATH 只有 pathname', () => {
    expect(idempotentId({ ...base, path: `${base.path}?limit=20` })).toBe(idempotentId(base));
  });
});
