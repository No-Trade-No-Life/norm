import type { Env } from './env';
import { signatureWindowSeconds } from './env';
import { fail } from './http';
import { nowSeconds } from './ids';
import { sha256Hex, signingMessage, verifySignature } from './crypto';
import { ensurePrincipal, principalExists } from './store';
import { principalFromConsumerKey } from './consumers';

/**
 * 管理面的身份：地址，加上这次请求自带的幂等键。
 *
 * 签名回答「谁在说话」，它管的是资源——账户、上游提供商、下游 Token。
 * 它**不参与消费**：推理接口只认下游消费者 Token，见 authenticateConsumer。
 */
export type Identity = {
  address: string;
  /**
   * 这次请求的幂等键：`X-Norm-Nonce` 的原值。
   *
   * 它不再是一张「一次性票据」，而是「这次改动叫什么名字」——状态变更类的端点把它
   * 写进被改的那一行的 `last_nonce`（`applyOnce`），或拿它派生新行的 id
   * （`idempotentId`）。读端点一眼都不看它。
   *
   * 名字没换（头还是 `X-Norm-Nonce`）：换的是语义，不是姿势。
   */
  nonce: string;
  /**
   * 这次调用顺手开的户：第一次见到这个公钥。
   *
   * 开户本来就是行内幂等的（`principals` 的主键是地址，授信那一条用
   * `WHERE voucher_nanos = 0` 兜住），所以它不需要幂等键——重放既不会开出第二个
   * 账户，也不会再发一张券。`/auth/login` 用这个布尔诚实地回答「这次是不是新开户」。
   */
  opened: boolean;
};

/**
 * 转发面的身份：地址 + 这次调用用的是哪把下游 Token。
 *
 * `consumerId` 在转发面上是必填的：账本要能回答「这条钱是哪把钥匙花的」，
 * 而人不是一把钥匙。没有一把具体的 Token，就没有这笔消费。
 *
 * 它刻意**不是** `Identity` 的超集：转发面没有 nonce——一把 Token 就是一次调用，
 * 既没有待签的串，也没有「同一次意图」可言；重复花钱本来就是下游自己要的事。
 */
export type Principal = {
  address: string;
  consumerId: string;
};

/**
 * 下游密钥可能出现在三个不同的头里，因为那是各家 SDK 的硬编码习惯，不是我们选的：
 *
 *   Authorization: Bearer sk-norm-…    OpenAI SDK / Codex CLI / curl
 *   x-api-key: sk-norm-…               Anthropic SDK / Claude Code
 *   x-goog-api-key: sk-norm-…          Google SDK
 *
 * 只认带 `sk-norm-` 前缀的值——没有前缀的 api key 不是我们的身份，它会在
 * authenticateConsumer 里得到一句「这里只接受消费者 Token」。
 */
function bearerOf(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;
  const [scheme, value] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !value) fail(401, 'authorization_invalid', 'Authorization 只支持 Bearer 消费者密钥');
  return value;
}

/**
 * 转发面（`/v1/*`）的唯一入口：只认 `sk-norm-…` 消费者 Token。
 *
 * 这里**没有**「签名直连」这条路径，而且是刻意的：签名能管资源，不能花钱。
 * 一旦推理接口也接受签名，每一笔消费就可以不挂在任何一把钥匙上——账本回答不了
 * 「这段代码是谁在跑」，撤销、限流、按程序分账也都失去了抓手。所以三个 api key 头里
 * 一个 `sk-norm-` 值都没有时，直接回一句明确的 401，而不是退回去验签。
 */
export async function authenticateConsumer(request: Request, env: Env): Promise<Principal> {
  const candidates = [
    bearerOf(request),
    request.headers.get('x-api-key'),
    request.headers.get('x-goog-api-key'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const key = candidates.find((value) => value.startsWith('sk-norm-'));
  if (!key) {
    fail(
      401,
      'consumer_key_required',
      '推理接口只接受下游消费者 Token（sk-norm-…），在 Authorization: Bearer / x-api-key / x-goog-api-key 三者中任选其一；身份签名只能用于管理面 /api/v1/*',
    );
  }
  return principalFromConsumerKey(env, key);
}

/**
 * 管理面（`/api/v1/*`）的唯一入口：Ed25519 请求签名。
 *
 * 校验顺序是刻意的，而且很短：头部齐全 → 时间戳在窗口内（便宜）→ 验签（一条椭圆曲线
 * 运算）。**没有 D1 写**：重放这件事不在这里拦，它由每个状态变更端点把幂等键落在
 * 被改的那一行上来保证（见 src/idempotent.ts）。
 *
 * 读（GET / HEAD）到此为止，一行都不写：重放一次读没有副作用，时间窗放行就够了。
 * 这也是省掉写入的大头——浏览器每轮询一次账户页，旧做法就是两行。
 */
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const address = request.headers.get('X-Norm-Address');
  const timestamp = request.headers.get('X-Norm-Timestamp');
  const nonce = request.headers.get('X-Norm-Nonce');
  const signature = request.headers.get('X-Norm-Signature');
  if (!address || !timestamp || !nonce || !signature) {
    fail(401, 'signature_required', '缺少 X-Norm-Address / Timestamp / Nonce / Signature');
  }

  const window = signatureWindowSeconds(env);
  const skew = Math.abs(nowSeconds() - Number(timestamp));
  if (!Number.isInteger(Number(timestamp)) || skew > window) {
    fail(
      401,
      'timestamp_out_of_window',
      `时间戳超出 ${window}s 窗口。这个窗口只管签名新不新鲜；「一次性」由请求自带的幂等键保证，所以重发同一个签名的读请求是允许的`,
    );
  }

  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const message = signingMessage({
    method: request.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodySha256Hex: sha256Hex(body),
  });

  if (!verifySignature({ address, signature, message })) {
    fail(401, 'signature_invalid', '签名不匹配');
  }

  // 老地址不为每次请求付一次写入：只有第一次见到这个公钥时才落库开户。
  const seenAt = nowSeconds();
  const opened = !(await principalExists(env, address)) && (await ensurePrincipal(env, address, seenAt));

  return { address, nonce, opened };
}
