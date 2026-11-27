/**
 * 参考图（图生图 / 编辑）：把用户挑的文件读成上游认的 data URL。
 *
 * `openai-oauth` 那条线缆收 `reference_images`：最多 4 张，每张必须是
 * `data:image/(png|jpeg|webp|gif);base64,…` 的字符串。服务端（`src/images.ts` 的
 * `readImageAsk` / `validReferenceImage`）已经按这个口径校验，回
 * `image_reference_invalid` / `image_reference_too_many`——这里镜像一份不是为了替代它，
 * 而是为了别让用户挑完 4 张、点了生成才发现要重来：类型、大小、张数在读文件时就挡住，
 * 并且**明说**哪一张没进来、为什么。
 */

/** 与 `src/images.ts` 的 `MAX_REFERENCE_IMAGES` 对齐：多一张服务端就整条请求 400。 */
export const MAX_REFERENCE_IMAGES = 4;

/**
 * 单张 8 MiB。参考图整段进 JSON 体，base64 还要再涨三分之一：4 张 8 MiB 已经是约 43 MiB
 * 的请求体，再往上就不是「选错文件」，而是把一段视频塞进了图片位。
 */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

/** 上游认的 MIME：与 `validReferenceImage` 同一份列表（`image/jpg` 是老相机/老软件的写法）。 */
const REFERENCE_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/** 已选的一张参考图：`dataUrl` 原样进请求体，其余字段只给缩略图与提示用。 */
export type ReferenceImage = {
  /** 列表里的身份：同一张文件可以选两次，靠它定位「移除的是哪一张」。 */
  id: string;
  name: string;
  size: number;
  dataUrl: string;
};

/** 读成了一张图、但还没有列表身份（`id` 由页面给）：文件读取那一层交出来的就是它。 */
export type ReferenceDraft = { name: string; size: number; dataUrl: string };

/** 被退回的文件：张数、类型、大小、空文件、读不出来——每一种都要有一句人话。 */
export type ReferenceRejection = {
  name: string;
  reason: 'type' | 'size' | 'empty' | 'count' | 'unreadable';
};

/** 挑进来的文件形状：`File` 与本函数在测试里的假文件都长这样。 */
export type ReferenceFile = { name: string; size: number; type: string };

/**
 * 一张参考图是不是上游认的 data URL——`src/images.ts` 的 `validReferenceImage` 的镜像。
 *
 * 只收 base64 的 data URL：http 地址等于让上游替我们去打一次任意地址（且无法审计）。
 */
export function validReferenceImage(url: string): boolean {
  const comma = url.indexOf(';base64,');
  if (comma < 0) return false;
  const meta = url.slice(0, comma);
  if (!meta.startsWith('data:')) return false;
  const mime = meta.slice('data:'.length);
  if (!REFERENCE_MIME.includes(mime)) return false;
  return url.length > comma + ';base64,'.length;
}

/**
 * 挑进来的文件 → 收下的与退回的。
 *
 * 一次选 6 张时既不整批收、也不整批退：前 4 张收下，多出来的逐张说清楚。顺序敏感——
 * 先挑的先占位，用户看到的就是自己挑的顺序。
 */
export function admitReferenceFiles<T extends ReferenceFile>(
  existingCount: number,
  incoming: T[],
): { accepted: T[]; rejected: ReferenceRejection[] } {
  const accepted: T[] = [];
  const rejected: ReferenceRejection[] = [];
  let room = Math.max(0, MAX_REFERENCE_IMAGES - existingCount);

  for (const file of incoming) {
    if (!REFERENCE_MIME.includes(file.type)) {
      rejected.push({ name: file.name, reason: 'type' });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: 'empty' });
      continue;
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      rejected.push({ name: file.name, reason: 'size' });
      continue;
    }
    if (room === 0) {
      rejected.push({ name: file.name, reason: 'count' });
      continue;
    }
    room -= 1;
    accepted.push(file);
  }

  return { accepted, rejected };
}

/**
 * 发请求前的最后一道：只交出格式真的合法的 data URL。
 *
 * 回 null = 有脏数据，别发。读文件那一步已经核过一次，这里再核一次是因为「已选」可能停在
 * 读了一半的状态；与其让服务端回 400（白付一次 Gas 与一次往返），不如在本地说清楚。
 */
export function referencePayload(images: ReferenceImage[]): string[] | null {
  if (images.length > MAX_REFERENCE_IMAGES) return null;
  const urls: string[] = [];
  for (const image of images) {
    if (!validReferenceImage(image.dataUrl)) return null;
    urls.push(image.dataUrl);
  }
  return urls;
}
