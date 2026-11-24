/**
 * 可信发布的数字来源：把将要上线的字节算成一个 sha256，交给 Worker 变量公开。
 * 任何人 `pnpm build` 之后跑同一个脚本，就能比出线上跑的是不是这份代码。
 *
 * 两处哈希：
 *   source_sha256 —— src/ 下全部源文件按「相对路径 + 内容」排序后拼接的 sha256
 *   assets_sha256 —— dist/ 下全部产物按同样的方式拼接的 sha256
 * 目录清单自身也计入，所以删文件或加文件都会改变结果，不只是改内容。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry);
      if (statSync(absolute).isDirectory()) stack.push(absolute);
      else out.push(absolute);
    }
  }
  return out.sort();
}

function hashTree(dir) {
  const hash = createHash('sha256');
  for (const file of walk(dir)) {
    hash.update(relative(dir, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const root = process.cwd();
console.log(JSON.stringify({ source_sha256: hashTree(join(root, 'src')), assets_sha256: hashTree(join(root, 'dist')) }));
