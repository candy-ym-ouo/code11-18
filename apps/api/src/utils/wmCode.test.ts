import { describe, expect, it } from 'vitest';
import {
  assemblePayload,
  codeToPayload,
  parseVerifiedCode,
  payloadToCode,
  randomWatermarkPayload,
  verifyWatermarkPayload,
} from './wmCode';

describe('水印码编解码', () => {
  it('随机负载 → 短码 → 负载 往返一致，且短码 13 位', () => {
    for (let i = 0; i < 50; i += 1) {
      const payload = randomWatermarkPayload();
      const code = payloadToCode(payload);
      expect(code).toMatch(/^[0-9A-Z]{13}$/);
      expect(Buffer.compare(codeToPayload(code)!, payload)).toBe(0);
    }
  });

  it('随机负载能通过 HMAC 校验并取回 challenge', () => {
    const payload = randomWatermarkPayload();
    const challenge = verifyWatermarkPayload(payload);
    expect(challenge).not.toBeNull();
    expect(challenge!.length).toBe(5);
  });

  it('篡改任意字节后校验失败', () => {
    const payload = randomWatermarkPayload();
    for (const pos of [0, 4, 5, 7]) {
      const tampered = Buffer.from(payload);
      tampered[pos]! ^= 0x01;
      expect(verifyWatermarkPayload(tampered)).toBeNull();
      expect(parseVerifiedCode(payloadToCode(tampered))).toBeNull();
    }
  });

  it('手编的假短码无法通过校验', () => {
    expect(parseVerifiedCode('HELLOWORLD000')).toBeNull();
    expect(codeToPayload('短码')).toBeNull();
    expect(codeToPayload('ABC')).toBeNull();
  });

  it('assemblePayload 对同一 challenge 确定性输出', () => {
    const c = Buffer.from([1, 2, 3, 4, 5]);
    expect(Buffer.compare(assemblePayload(c), assemblePayload(c))).toBe(0);
    expect(parseVerifiedCode(payloadToCode(assemblePayload(c)))).toEqual(c);
  });
});
