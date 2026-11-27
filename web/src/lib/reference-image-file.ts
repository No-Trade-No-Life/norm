import { validReferenceImage, type ReferenceDraft } from './reference-images';

/**
 * 浏览器侧的一步：文件 → data URL。
 *
 * 单开一个模块，是因为纯规则（`reference-images.ts`）要在没有 DOM 的测试里跑，而 `FileReader`
 * 只该出现在这里。`FileReader` 给的正是 `data:<mime>;base64,<…>`；读不出来（文件中途被移走、
 * 读到的不是 data URL）回 null，由页面说「这张没进来」，不打断同一批里的其余几张。
 */
export function readReferenceFile(file: File): Promise<ReferenceDraft | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!validReferenceImage(dataUrl)) {
        resolve(null);
        return;
      }
      resolve({ name: file.name, size: file.size, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}
