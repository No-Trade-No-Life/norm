import { describe, expect, it } from 'vitest';
import { uuidv4, uuidv7 } from '../src/ids';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * id 的形状是接口契约的一部分：request_id 靠 v7 的时间序当索引，
 * provider_id / consumer_id 靠 v4 的纯随机。
 */
describe('uuid v4：提供者与消费者', () => {
  it('形状合法且不带时间含义', () => {
    const id = uuidv4();
    expect(id).toMatch(V4);
    expect(uuidv4()).not.toBe(id);
  });
});

describe('uuid v7：请求 id', () => {
  it('形状合法', () => {
    expect(uuidv7()).toMatch(V7);
  });

  it('字典序即时间序（账本按 id 翻页的前提）', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_700_000_001_000);
    expect(late > early).toBe(true);
  });

  it('毫秒时间戳写在头 48 位里，可以解出来', () => {
    const at = 1_764_000_000_123;
    const id = uuidv7(at);
    const millis = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(millis).toBe(at);
  });

  it('同一毫秒内的多个 id 互不相同', () => {
    const at = 1_764_000_000_000;
    const ids = new Set(Array.from({ length: 50 }, () => uuidv7(at)));
    expect(ids.size).toBe(50);
  });
});
