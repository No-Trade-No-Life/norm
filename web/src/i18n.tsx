import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { translate, type CopyKey, type Lang } from './copy';

const LANG_KEY = 'norm.lang';

type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: CopyKey) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

function readLang(): Lang {
  const stored = localStorage.getItem(LANG_KEY);
  return stored === 'en' ? 'en' : 'zh';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);

  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, t: (key: CopyKey) => translate(lang, key) }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return value;
}
