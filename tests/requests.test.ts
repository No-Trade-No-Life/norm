import { describe, expect, it } from 'vitest';

import { unifiedRequestId } from '../src/ids';
import { receiptOf } from '../src/routes/requests';
import type { RequestReceiptRow } from '../src/store';

/**
 * 对账契约：上层网关（NormAI）拿请求 ID 回来问「这一笔收了多少」，读的是
 * `{requests:[{request_id, cost_usd_nanos}]}`。字段名是跨服务的约定，改了要两边一起改，
 * 所以钉在这里。
 */
const row: RequestReceiptRow = {
  id: '01930000-0000-7000-8000-000000000001',
  model: 'qwen-audio-3.0-asr-flash',
  status: 'ok',
  status_code: 200,
  latency_ms: 820,
  first_token_ms: null,
  input_tokens: 0,
  cached_tokens: 0,
  output_tokens: 0,
  audio_ms: 2500,
  audio_characters: 0,
  gas_billed_nanos: 4_000,
  token_billed_nanos: 76_390,
  fee_nanos: 80_390,
  base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  created_at: 1_796_000_000,
};

describe('请求费用查询的对外形状', () => {
  it('cost_usd_nanos 恒等于实扣（gas + token），用量与主机一并回', () => {
    const receipt = receiptOf(row);
    expect(receipt.cost_usd_nanos).toBe(row.fee_nanos);
    expect(receipt.cost_usd_nanos).toBe(receipt.gas_billed_nanos + receipt.token_billed_nanos);
    expect(receipt.request_id).toBe(row.id);
    expect(receipt.audio_ms).toBe(2500);
    // 只回主机名：对账不需要看见上游路径。
    expect(receipt.host).toBe('dashscope.aliyuncs.com');
  });

  it('base_url 坏掉时原样回，不因为一行脏数据把对账打崩', () => {
    expect(receiptOf({ ...row, base_url: 'not a url' }).host).toBe('not a url');
  });
});

describe('统一请求 ID', () => {
  const withHeader = (value: string) => new Headers({ 'x-normai-request-id': value });

  it('网关自报的合法 UUID 直接采用（统一成小写），两边因此对得上', () => {
    expect(unifiedRequestId(withHeader('01930000-0000-7000-8000-0000000000AB'))).toBe(
      '01930000-0000-7000-8000-0000000000ab',
    );
  });

  it('不合法或没带就自己生成：主键不接受客户端随便塞的一段字符串', () => {
    expect(unifiedRequestId(withHeader('req_1'))).toBeNull();
    expect(unifiedRequestId(withHeader(''))).toBeNull();
    expect(unifiedRequestId(new Headers())).toBeNull();
  });
});
