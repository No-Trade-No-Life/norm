/**
 * 明文密钥只在当前标签页的内存里：不进 localStorage、不进 console、不进请求体。
 * 刷新即失效——这正是设计意图，用户必须重新输入口令。
 */
const unlocked = new Map<string, string>();
const passphrases = new Map<string, string>();

export function rememberUnlocked(credentialId: string, key: string, passphrase?: string): void {
  unlocked.set(credentialId, key);
  if (passphrase && passphrase.length > 0) passphrases.set(credentialId, passphrase);
}

export function getUnlocked(credentialId: string): string | null {
  return unlocked.get(credentialId) ?? null;
}

export function getPassphrase(credentialId: string): string {
  return passphrases.get(credentialId) ?? '';
}

export function forgetAll(): void {
  unlocked.clear();
  passphrases.clear();
}
