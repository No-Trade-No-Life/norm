import type { Bill } from '../components/call-bill';
import { errorText } from './error-text';
import type { ChatChunk } from '../types';

/**
 * 读 `/v1/chat/completions` 的 SSE。
 *
 * 一帧一帧地解，边解边交出去：`content` 与 `reasoning_content` 分开报——推理模型的
 * 「思考」也是上游真的产出的字，只认 `content` 会让这类模型看起来一片空白。
 * 记账那一条（`{"norm":…}`）在流末，单独交给 `onBill`。
 *
 * 200 的流里也可能报错（配额、模型下线、内容被拦）：那是上游说的话，原样交出去。
 */
export type ChatStreamHandlers = {
  onDelta: (delta: string, kind: 'content' | 'reasoning') => void;
  onBill: (bill: Bill) => void;
  onError: (message: string) => void;
};

export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (block: string) => {
    const payload = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!payload || payload === '[DONE]') return;

    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      return;
    }

    if (chunk.norm) handlers.onBill(chunk.norm as Bill);
    if (chunk.error) handlers.onError(errorText(chunk.error, ''));
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) handlers.onDelta(delta.content, 'content');
    if (delta?.reasoning_content) handlers.onDelta(delta.reasoning_content, 'reasoning');
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      handleEvent(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handleEvent(buffer);
}
