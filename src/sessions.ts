/**
 * 上游会话 id：只为一件事存在——让同一段对话在 OpenCode Go 那边落进同一个槽位，
 * 从而命中提示词缓存。它不是身份、不参与鉴权、也不进账本。
 *
 * 上游看到的值永远是 `ses_<64 hex>`，来源按下面的顺序取第一个可用的：
 *
 *   1. 调用方自报的 `x-opencode-session`；
 *   2. 路由层已经算过一遍的亲和键（`thread-id` / `session-id`）；
 *   3. 请求体里的 `prompt_cache_key`；
 *   4. 模型名 + 第一轮用户输入。
 *
 * 前三条都来自调用方，所以一律先哈希再说：上游既认不出调用方的 id，也没法拿别人的
 * id 来蹭一段会话。种子里还拼了**账户地址**——两个账户用同一个 `thread-1` 也不会
 * 撞到同一个上游会话上（与 `routing.ts` 的 `affinityHash` 同一口径）。
 *
 * 会话 id 只在协议声明了 `session_header` 时才派生（目前只有 `opencode-go`）：
 * 不要求它的上游，一个字节都不该多收。
 */
import { sha256Hex, utf8 } from './crypto';
import type { AffinityKey } from './routing';

/** OpenCode Go 要求的头名。 */
export const SESSION_HEADER = 'x-opencode-session';

/** 上游认的形状：`ses_` 加 64 位十六进制。 */
export const SESSION_PREFIX = 'ses_';

type Headers = { get(name: string): string | null };

export type SessionInput = {
  /** 账户地址：拼进种子，两个账户用同一个 `thread-id` 文本也不会撞进同一个上游会话。 */
  address: string;
  headers: Headers;
  /** 路由层已经取过的亲和键；没有就是 null。 */
  affinity: AffinityKey | null;
  /** 入口请求体：`prompt_cache_key` 与第一轮用户输入都从这里读。 */
  body: Record<string, unknown>;
  model: string;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** 一段 content 的文本：字符串原样，数组取每块的 `text`，其余给空串（不猜）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof recordOf(part).text === 'string' ? (recordOf(part).text as string) : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * 第一轮用户输入：Chat 的 `messages` 与 Responses 的 `input` 两种形状都认。
 * 一条都读不到时给空串——种子仍然稳定，只是细到「这台模型的所有空对话同一个会话」。
 */
function firstTurnText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userTurn = messages.find((message) => recordOf(message).role === 'user') ?? messages[0];
  if (userTurn !== undefined) return textOf(recordOf(userTurn).content);
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.input)) return textOf(body.input.map((item) => recordOf(item).content));
  return '';
}

function seedOf(input: SessionInput): string {
  const header = input.headers.get(SESSION_HEADER)?.trim();
  if (header) return `header\u0001${header}`;
  if (input.affinity) return `${input.affinity.source}\u0001${input.affinity.value}`;
  const cacheKey = typeof input.body.prompt_cache_key === 'string' ? input.body.prompt_cache_key.trim() : '';
  if (cacheKey) return `prompt_cache_key\u0001${cacheKey}`;
  return `turn\u0001${input.model}\u0001${firstTurnText(input.body)}`;
}

export function sessionIdFor(input: SessionInput): string {
  return `${SESSION_PREFIX}${sha256Hex(utf8(`${input.address}\u0001${seedOf(input)}`))}`;
}
