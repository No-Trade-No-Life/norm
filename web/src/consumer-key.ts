import { consumerFetch, requestJson, type ConsumerRequest } from './api';

/**
 * 浏览器自己那把下游 Token。
 *
 * 推理接口只认 Token（`sk-norm-…`），不认签名——签名管资源，Token 管消费。
 * 所以「工具」里的这几页与模型清单「在页面上打推理接口」的地方，必须先有一条
 * 属于自己的 Token。它由管理面（签名）现铸一把，明文只落在本机 localStorage，
 * 与身份密钥同一个待遇：从不发往任何服务端之外的地方。
 *
 * 名字固定叫 `playground`：在「消费者」页能看见它、轮换它、撤销它。撤销之后这里
 * 下一次调用会拿到 401，于是就地作废重铸一把——用户不需要知道中间发生过什么。
 */

const KEY_NAME = 'playground';
const storageKey = (address: string) => `norm.consumer.${address}`;

export type StoredConsumerKey = {
  id: string;
  key: string;
  keyHint: string;
};

function read(address: string): StoredConsumerKey | null {
  const raw = localStorage.getItem(storageKey(address));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConsumerKey>;
    if (typeof parsed.id === 'string' && typeof parsed.key === 'string' && typeof parsed.keyHint === 'string') {
      return { id: parsed.id, key: parsed.key, keyHint: parsed.keyHint };
    }
  } catch {
    // 坏掉的存储不值得修：当作没有，下面重铸一把。
  }
  return null;
}

function write(address: string, stored: StoredConsumerKey): void {
  localStorage.setItem(storageKey(address), JSON.stringify(stored));
}

/** 本机这把钥匙用不上了（被撤销、或服务端说不认识它）：删掉，下次重铸。 */
export function forgetConsumerKey(address: string): void {
  localStorage.removeItem(storageKey(address));
}

/** 同一个地址可能被两个组件同时问：只铸一把，两个调用等同一个 Promise。 */
const minting = new Map<string, Promise<StoredConsumerKey>>();

async function mint(address: string): Promise<StoredConsumerKey> {
  // 建钥是管理面的事，所以这一次仍走签名；铸出来的那把钥匙才是转发面的凭据。
  const created = await requestJson<{ id: string; key: string; key_hint: string }>({
    path: '/api/v1/consumers',
    method: 'POST',
    body: JSON.stringify({ name: KEY_NAME }),
  });
  const stored: StoredConsumerKey = { id: created.id, key: created.key, keyHint: created.key_hint };
  write(address, stored);
  return stored;
}

export async function ensureConsumerKey(address: string): Promise<StoredConsumerKey> {
  const existing = read(address);
  if (existing) return existing;

  const running = minting.get(address);
  if (running) return running;

  const task = mint(address).finally(() => minting.delete(address));
  minting.set(address, task);
  return task;
}

/**
 * 打一次转发面，钥匙失效就换一把再试一次。
 *
 * 只认「没有 `X-Norm-Request-Id` 的 401」：那是转发面自己的鉴权拒绝（钥匙不存在/已撤销）。
 * 带上这个头的是已经打到上游、被上游拒了的 401（例如上游密钥失效），那种与我们的钥匙无关，
 * 重铸一把只会把上游的错怪到我们头上。
 */
export async function consumerResponse(request: Omit<ConsumerRequest, 'consumerKey'> & { address: string }): Promise<Response> {
  const { address, ...rest } = request;
  const first = await consumerFetch({ ...rest, consumerKey: (await ensureConsumerKey(address)).key });
  if (first.status !== 401 || first.headers.has('X-Norm-Request-Id')) return first;

  forgetConsumerKey(address);
  return consumerFetch({ ...rest, consumerKey: (await ensureConsumerKey(address)).key });
}
