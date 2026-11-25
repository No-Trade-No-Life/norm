import { describe, expect, it } from 'vitest';

import { COPY, LANGS, translate, type CopyKey } from '../web/src/copy';

/**
 * i18n 的构建期完整性：一份扁平常量字典，键不嵌套、双语不缺、占位符对得上。
 *
 * 类型只能保证「用到的键存在」，保证不了「两种语言都写了」「{page} 在英文里没漏」。
 * 这些在运行时才会变成空白或半句中文，所以放在 CI 里跑。
 */
const entries = Object.entries(COPY) as Array<[CopyKey, Record<string, unknown>]>;

/** 操作列表头故意留空（按钮自己会说是干什么的），但仍然两种语言都要有一条。 */
const BLANK_OK = new Set<CopyKey>(['pr.col_actions', 'co.col_actions']);

describe('COPY 字典', () => {
  it('每条都恰好有 zh 与 en，且都是非空字符串', () => {
    const problems: string[] = [];
    for (const [key, value] of entries) {
      const langs = Object.keys(value).sort();
      if (langs.join(',') !== [...LANGS].sort().join(',')) {
        problems.push(`${key}: 语言字段是 ${langs.join(',') || '空'}`);
      }
      for (const lang of LANGS) {
        const text = value[lang];
        if (typeof text !== 'string') problems.push(`${key}.${lang}: 不是字符串`);
        else if (!text.trim() && !BLANK_OK.has(key)) problems.push(`${key}.${lang}: 空文案`);
      }
    }
    expect(problems).toEqual([]);
  });

  // 「键拍平」：值只能是 { zh, en } 这层，不允许再嵌套一层子表。
  it('没有嵌套结构', () => {
    const nested = entries.filter(([, value]) =>
      Object.values(value).some((text) => text !== null && typeof text === 'object'),
    );
    expect(nested.map(([key]) => key)).toEqual([]);
  });

  it('中英两侧的占位符完全一致', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const problems: string[] = [];
    for (const [key, value] of entries) {
      const zh = placeholders(String(value.zh));
      const en = placeholders(String(value.en));
      if (zh.join(',') !== en.join(',')) {
        problems.push(`${key}: zh {${zh.join(',')}} vs en {${en.join(',')}}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('translate', () => {
  it('按语言取值', () => {
    expect(translate('zh', 'us.page', { page: 3 })).toBe('第 3 页');
    expect(translate('en', 'us.page', { page: 3 })).toBe('Page 3');
  });

  it('没有占位符的条目传了参数也不炸', () => {
    expect(translate('en', 'app.name', { unused: 1 })).toBe('Norm');
  });

  // 漏传参数时保留原文，比把 undefined 印到界面上更容易定位。
  it('漏传的参数原样留在文案里', () => {
    expect(translate('en', 'us.page', {})).toBe('Page {page}');
  });
});
