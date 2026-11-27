/**
 * `POST /v1/images/generations` 的回包（OpenAI Images 的形状）。
 *
 * 与 Gemini 那条路的分工：那边是「一个 Gemini 请求里同时可能要文字和图」，图在
 * `inlineData` 里；这边是「一次调用只画一张」，图在 `data[].b64_json` 里，外加一句上游
 * 改写过的提示词。两个形状都在页面上变成同一件事——一张 base64 的图与一句说明。
 */
export type GeneratedImage = { mimeType: string; data: string };

export type ImageApiResult = {
  images: GeneratedImage[];
  /** 上游改写后的提示词（它记得帮你补全了什么）。没给就不编。 */
  revisedPrompt: string;
};

/** 把 Images 的回包读成「图 + 说明」。读不出图就回空数组，由页面自己说这次没画。 */
export function readImageApiResponse(payload: unknown): ImageApiResult {
  const body = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const images: GeneratedImage[] = [];
  let revisedPrompt = '';

  for (const item of Array.isArray(body.data) ? body.data : []) {
    const entry = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const data = typeof entry.b64_json === 'string' ? entry.b64_json : '';
    if (data === '') continue;
    // 入口只收 png / jpeg / webp，默认 png；这一句是给下载文件名与 MIME 用的。
    const format = typeof body.output_format === 'string' ? body.output_format : 'png';
    images.push({ mimeType: `image/${format === 'jpg' ? 'jpeg' : format}`, data });
    if (revisedPrompt === '' && typeof entry.revised_prompt === 'string') revisedPrompt = entry.revised_prompt;
  }

  return { images, revisedPrompt };
}
