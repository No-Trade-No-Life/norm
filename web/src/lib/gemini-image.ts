/** 一张从 Gemini 回包里取出来的图。字节是 base64，只在这一次响应里存在。 */
export type GeminiImage = { mimeType: string; data: string };

export type GeminiImageResult = {
  images: GeminiImage[];
  /** 同一个候选里附带的文字（有的模型边画边说，有的什么都不说）。 */
  text: string;
};

/**
 * 从 `POST /v1/models/{model}:generateContent` 的响应里取图。
 *
 * 直通时这个体就是上游的原话，所以按 Gemini 的形状读：`candidates[].content.parts[]`
 * 里每个 part 要么是 `text`，要么是 `inlineData`（有的实现回 snake_case 的
 * `inline_data` / `mime_type`，一并认下）。取不出图不算错——把「上游这次没画」
 * 这个事实交回去，页面自己说。
 */
export function readGeminiImages(payload: unknown): GeminiImageResult {
  const body = asRecord(payload);
  const images: GeminiImage[] = [];
  const texts: string[] = [];

  for (const candidate of recordList(body.candidates)) {
    const content = asRecord(candidate.content);
    for (const part of recordList(content.parts)) {
      const text = stringField(part.text);
      if (text) texts.push(text);
      const inline = maybeRecord(part.inlineData) ?? maybeRecord(part.inline_data);
      if (!inline) continue;
      const data = stringField(inline.data);
      if (!data) continue;
      const mimeType = stringField(inline.mimeType) || stringField(inline.mime_type) || 'image/png';
      images.push({ mimeType, data });
    }
  }

  return { images, text: texts.join('\n').trim() };
}

/** 上游说「这次没画」的原话：被安全策略拦下时只有一个 blockReason，没有候选。 */
export function geminiBlockReason(payload: unknown): string | null {
  const feedback = asRecord(asRecord(payload).promptFeedback);
  const reason = stringField(feedback.blockReason) || stringField(feedback.block_reason);
  return reason || null;
}

/** 和 `asRecord` 一样，但「没有」时回 null——`?? fallback` 才真的能生效。 */
function maybeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
