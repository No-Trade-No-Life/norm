import { describe, expect, it } from 'vitest';

import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_IMAGES,
  admitReferenceFiles,
  referencePayload,
  validReferenceImage,
  type ReferenceImage,
} from '../web/src/lib/reference-images';

/**
 * 参考图的本地闸：类型、大小、张数、格式。
 *
 * 服务端（`src/images.ts` 的 `readImageAsk`）会再校验一遍，但那是「整条请求 400」的粒度；
 * 这里是「哪一张没进来、为什么」的粒度。两边口径不一样，用户就会看到一次白跑的请求。
 */

const png = (bytes = 8) => `data:image/png;base64,${'A'.repeat(bytes)}`;
const file = (name: string, type: string, size = 1024) => ({ name, type, size });
const image = (id: string, dataUrl: string): ReferenceImage => ({ id, name: `${id}.png`, size: 1024, dataUrl });

describe('validReferenceImage', () => {
  it('认上游那四种 data URL', () => {
    expect(validReferenceImage(png())).toBe(true);
    expect(validReferenceImage('data:image/jpeg;base64,AAAA')).toBe(true);
    expect(validReferenceImage('data:image/webp;base64,AAAA')).toBe(true);
    expect(validReferenceImage('data:image/gif;base64,AAAA')).toBe(true);
  });

  it('http 地址与别的类型都不认', () => {
    expect(validReferenceImage('https://example.com/a.png')).toBe(false);
    expect(validReferenceImage('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(validReferenceImage('data:image/png,AAAA')).toBe(false);
    expect(validReferenceImage('data:image/png;base64,')).toBe(false);
  });
});

describe('admitReferenceFiles', () => {
  it('收下的保持挑选顺序，超出的逐张退回', () => {
    const { accepted, rejected } = admitReferenceFiles(3, [
      file('a.png', 'image/png'),
      file('b.png', 'image/png'),
      file('c.jpg', 'image/jpeg'),
    ]);
    expect(accepted.map((item) => item.name)).toEqual(['a.png']);
    expect(rejected).toEqual([{ name: 'b.png', reason: 'count' }, { name: 'c.jpg', reason: 'count' }]);
  });

  it('已经满了就一张都不收', () => {
    const { accepted, rejected } = admitReferenceFiles(MAX_REFERENCE_IMAGES, [file('a.png', 'image/png')]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ name: 'a.png', reason: 'count' }]);
  });

  it('类型、大小、空文件各有各的理由，不静默丢', () => {
    const { accepted, rejected } = admitReferenceFiles(0, [
      file('vector.svg', 'image/svg+xml'),
      file('huge.png', 'image/png', MAX_REFERENCE_BYTES + 1),
      file('zero.png', 'image/png', 0),
      file('ok.png', 'image/png', MAX_REFERENCE_BYTES),
    ]);
    expect(accepted.map((item) => item.name)).toEqual(['ok.png']);
    expect(rejected).toEqual([
      { name: 'vector.svg', reason: 'type' },
      { name: 'huge.png', reason: 'size' },
      { name: 'zero.png', reason: 'empty' },
    ]);
  });
});

describe('referencePayload', () => {
  it('没有参考图就是空数组：调用方据此不带 reference_images 字段', () => {
    expect(referencePayload([])).toEqual([]);
  });

  it('原样交出 data URL，顺序不变', () => {
    expect(referencePayload([image('a', png(4)), image('b', png(6))])).toEqual([png(4), png(6)]);
  });

  it('有一张格式不对就整批不发', () => {
    expect(referencePayload([image('a', png()), image('b', 'https://example.com/x.png')])).toBeNull();
  });

  it('超过上限也不发（服务端会 image_reference_too_many）', () => {
    const tooMany = Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, index) => image(`r${index}`, png()));
    expect(referencePayload(tooMany)).toBeNull();
  });
});
