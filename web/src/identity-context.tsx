import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  exportIdentity as encodeIdentity,
  identityFromKeypair,
  loadStoredIdentity,
  parseIdentity,
  persistIdentity,
  randomIdentity,
  type Identity,
} from './identity';
import { KEYPAIR_STORAGE_KEY, LEGACY_SEED_STORAGE_KEY } from './seed';

type IdentityValue = {
  identity: Identity;
  /** 这次进入页面时把旧版 32 字节种子升级成了 64 字节：密钥没变，格式变了。 */
  migratedFromLegacy: boolean;
  /** 导入后覆盖本机密钥；返回新身份，调用方负责重新登录。 */
  importIdentity: (text: string) => Identity;
  exportSeed: () => string;
};

const IdentityContext = createContext<IdentityValue | null>(null);

type Bootstrapped = { identity: Identity; migratedFromLegacy: boolean };

/** 首次进入就在浏览器里生成密钥——不询问、不联网、不上传。旧格式在这里升级。 */
function ensureIdentity(): Bootstrapped {
  const stored = loadStoredIdentity(localStorage);
  if (stored) {
    return { identity: identityFromKeypair(stored.keypair), migratedFromLegacy: stored.migratedFromLegacy };
  }
  const fresh = randomIdentity();
  persistIdentity(localStorage, fresh.keypair);
  return { identity: fresh, migratedFromLegacy: false };
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(ensureIdentity);
  const [identity, setIdentity] = useState<Identity>(boot.identity);
  const [migratedFromLegacy] = useState(boot.migratedFromLegacy);

  // 其它标签页换了密钥时同步过来，避免两个标签页用不同地址记账。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEYPAIR_STORAGE_KEY && event.key !== LEGACY_SEED_STORAGE_KEY) return;
      const stored = loadStoredIdentity(localStorage);
      if (stored) setIdentity(identityFromKeypair(stored.keypair));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const importIdentity = useCallback((text: string) => {
    const keypair = parseIdentity(text);
    persistIdentity(localStorage, keypair);
    const next = identityFromKeypair(keypair);
    setIdentity(next);
    return next;
  }, []);

  const exportSeed = useCallback(() => encodeIdentity(identity.keypair), [identity.keypair]);

  const value = useMemo<IdentityValue>(
    () => ({ identity, migratedFromLegacy, importIdentity, exportSeed }),
    [identity, migratedFromLegacy, importIdentity, exportSeed],
  );
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error('useIdentity 必须在 IdentityProvider 内使用');
  return value;
}
