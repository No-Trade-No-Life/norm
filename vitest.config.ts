import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  resolve: {
    // `cloudflare:sockets` 只在 workerd 里存在；节点环境给一个会大声失败的桩。
    alias: { 'cloudflare:sockets': fileURLToPath(new URL('./tests/sockets-stub.ts', import.meta.url)) },
  },
});
