export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 22 字符左右的 base58 随机串：nonce、流水 id 用它。 */
export function randomToken(bytes = 16): string {
  return base58.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* ── UUID ───────────────────────────────────────────────────────────
 * 三种 id 各有各的排序需求，选型只由这一点决定：
 *
 *   request_id   UUID v7  账本按时间翻页，「最近 20 条」就是 id 序，主键即时间索引
 *   credential_id  UUID v4  一条上游提供者被引用而不是被按时间扫描，时间序没有意义
 *   consumer_id  UUID v4  同上
 *
 * 不用自增整数：id 会出现在 URL 里，自增等于把全站的量、增长速度与写入节奏公开。
 */
const HEX = '0123456789abcdef';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => (b >> 4).toString(16) + (b & 15).toString(16)).join('');
}

function withVersion(bytes: Uint8Array, version: number): void {
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 变体
}

function format(bytes: Uint8Array): string {
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 无时间含义，纯随机。 */
export function uuidv4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  withVersion(bytes, 4);
  return format(bytes);
}

/**
 * 时间有序：前 48 位是毫秒时间戳，之后 4 位版本、12 位随机、2 位变体、62 位随机。
 *
 * 同一毫秒内不保证严格递增（我们不为此维护计数器）：D1 的 `rowid` 仍然兜住同毫秒的
 * 写入顺序，而 v7 的目的是让「按时间翻页」能走主键，不是当序列号用。
 */
export function uuidv7(at: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  bytes.set(crypto.getRandomValues(bytes));
  // 48 位毫秒时间戳：越过 2^48 毫秒（公元 10889 年）之前都够用。
  bytes[0] = Math.floor(at / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(at / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(at / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(at / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(at / 2 ** 8) & 0xff;
  bytes[5] = at & 0xff;
  withVersion(bytes, 7);
  return format(bytes);
}

export const base58 = (() => {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

  function encode(bytes: Uint8Array): string {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

    const digits: number[] = [];
    for (let i = zeros; i < bytes.length; i += 1) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j += 1) {
        carry += digits[j] * 256;
        digits[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }

    return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
  }

  function decode(text: string): Uint8Array {
    let zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros += 1;

    const bytes: number[] = [];
    for (let i = zeros; i < text.length; i += 1) {
      const value = MAP.get(text[i]);
      if (value === undefined) throw new Error(`base58 字符非法：${text[i]}`);
      let carry = value;
      for (let j = 0; j < bytes.length; j += 1) {
        carry += bytes[j] * 58;
        bytes[j] = carry % 256;
        carry = Math.floor(carry / 256);
      }
      while (carry > 0) {
        bytes.push(carry % 256);
        carry = Math.floor(carry / 256);
      }
    }

    const head = new Array(zeros).fill(0);
    return new Uint8Array([...head, ...bytes.reverse()]);
  }

  return { encode, decode };
})();
