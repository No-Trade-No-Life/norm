import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  exportSeed as encodeSeed,
  identityFromSeed,
  loadStoredSeed,
  parseSeed,
  randomSeed,
  storeSeed,
  type Identity,
} from './identity';

type IdentityValue = {
  identity: Identity;
  /** 导入后覆盖本机种子；返回新身份，调用方负责重新登录。 */
  importSeed: (text: string) => Identity;
  exportSeed: () => string;
};

const IdentityContext = createContext<IdentityValue | null>(null);

/** 首次进入就在浏览器里生成种子——不询问、不联网、不上传。 */
function ensureIdentity(): Identity {
  const stored = loadStoredSeed();
  if (stored) return identityFromSeed(stored);
  const seed = randomSeed();
  storeSeed(seed);
  return identityFromSeed(seed);
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity>(ensureIdentity);

  // 其它标签页换了身份时同步过来，避免两个标签页用不同地址记账。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'norm.identity.seed') return;
      const seed = loadStoredSeed();
      if (seed) setIdentity(identityFromSeed(seed));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const importSeed = useCallback((text: string) => {
    const seed = parseSeed(text);
    storeSeed(seed);
    const next = identityFromSeed(seed);
    setIdentity(next);
    return next;
  }, []);

  const exportSeed = useCallback(() => encodeSeed(identity.seed), [identity.seed]);

  const value = useMemo<IdentityValue>(() => ({ identity, importSeed, exportSeed }), [identity, importSeed, exportSeed]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error('useIdentity 必须在 IdentityProvider 内使用');
  return value;
}
