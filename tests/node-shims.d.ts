// 测试专用：tsconfig 只加载 Workers 类型，测试里用到的 Node 内置模块在这里补最小声明。
// 运行时用的是 Node 自己的实现，这里只描述测试真正调用的那几个函数。

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
  }
}

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

// ESM 标准字段；Workers 类型里没有带，但 Node 运行时一定有。
interface ImportMeta {
  readonly url: string;
}
