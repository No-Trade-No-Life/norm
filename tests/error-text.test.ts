import { describe, expect, it } from 'vitest';
import { errorText } from '../web/src/lib/error-text';

describe('errorText', () => {
  it('取上游提供商 error.message（OpenAI / DeepSeek 兼容的形状）', () => {
    const body = {
      error: {
        message: 'Authentication Fails, Your api key: ****-key is invalid',
        type: 'authentication_error',
        code: 'invalid_request_error',
      },
    };
    expect(errorText(body)).toBe('Authentication Fails, Your api key: ****-key is invalid');
  });

  it('取顶层 message（Norm 自己的形状），优先于 error code', () => {
    expect(errorText({ error: 'consumer_key_invalid', message: '消费者密钥无效或已撤销' })).toBe('消费者密钥无效或已撤销');
  });

  it('error 是字符串时也认', () => {
    expect(errorText({ error: 'provider_unreachable' })).toBe('provider_unreachable');
  });

  it('永远不会把对象漏成 [object Object] 或对象本身', () => {
    const out = errorText({ unexpected: { nested: [1, 2] } });
    expect(typeof out).toBe('string');
    expect(out).toContain('unexpected');
  });

  it('空输入走 fallback', () => {
    expect(errorText(null, '请求失败')).toBe('请求失败');
    expect(errorText({}, '请求失败')).toBe('请求失败');
    expect(errorText('   ', '请求失败')).toBe('请求失败');
  });

  it('Error 实例取 message', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('纯文本原样返回（上游提供商偶而回 HTML / 散文）', () => {
    expect(errorText('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
  });

  it('超长 JSON 截断', () => {
    const out = errorText({ blob: 'x'.repeat(1000) });
    expect(out.length).toBeLessThanOrEqual(401);
    expect(out.endsWith('…')).toBe(true);
  });
});
