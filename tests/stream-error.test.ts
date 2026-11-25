import { describe, expect, it } from 'vitest';

import { streamError } from '../src/dialects';

/**
 * 上游在 200 的流里报错是常态：配额、模型下线、内容被拦。
 * 认不出这些帧的代价不是「少一条日志」——客户端会拿到一个 200、一片空白和一笔 Gas，
 * 用户看到的就是「点了发送，什么都没发生」。所以这一层的契约是：
 * 四种方言各认各的，认出来就交出一句人话，认不出就老实交 null。
 */
describe('streamError', () => {
  it('openai-chat：{"error":{…}} 交出一句人话', () => {
    const message = streamError('openai-chat', JSON.stringify({ error: { message: 'Insufficient quota', type: 'invalid_request_error' } }));
    expect(message).toBe('Insufficient quota');
  });

  it('openai-responses：type:"error" 与裸 {"error":…} 都认', () => {
    expect(streamError('openai-responses', JSON.stringify({ type: 'error', error: { message: 'model offline' } }))).toBe('model offline');
    expect(streamError('openai-responses', JSON.stringify({ error: { message: 'quota' } }))).toBe('quota');
    expect(streamError('openai-responses', JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error' } } }))).toBe('server_error');
  });

  it('anthropic：type:"error" 的形状', () => {
    expect(streamError('anthropic-messages', JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))).toBe('Overloaded');
  });

  it('google-gemini：裸帧里的 error', () => {
    expect(streamError('google-gemini', JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }))).toBe('Resource exhausted');
  });

  it('正常的内容帧不是错误', () => {
    expect(streamError('openai-chat', JSON.stringify({ choices: [{ delta: { content: '你' } }] }))).toBeNull();
    expect(streamError('openai-chat', '[DONE]')).toBeNull();
    expect(streamError('openai-chat', 'not json')).toBeNull();
  });

  it('只有 code 时也交得出话，不是空字符串', () => {
    const message = streamError('openai-chat', JSON.stringify({ error: { code: 'quota_exceeded' } }));
    expect(message).toBe('quota_exceeded');
  });
});
