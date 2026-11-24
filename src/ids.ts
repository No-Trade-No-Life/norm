export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 22 字符左右的 base58 随机串：请求 id、流水 id、nonce 都用它。 */
export function randomToken(bytes = 16): string {
  return base58.encode(crypto.getRandomValues(new Uint8Array(bytes)));
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
