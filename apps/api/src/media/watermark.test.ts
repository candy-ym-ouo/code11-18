import { describe, expect, it } from 'vitest';
import {
  CONTENT_BYTES,
  crc32,
  embedLsb,
  extractLsb,
  packPayload,
  redundancyFor,
  unpackPayload,
} from './watermark';

describe('LSB 盲水印', () => {
  it('CRC32 对已知向量正确', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('负载打包/解包往返一致', () => {
    const content = new Uint8Array([0, 1, 2, 3, 0xde, 0xad, 0xbe, 0xef]);
    const packed = packPayload(content);
    expect(packed.length).toBe(16);
    const back = unpackPayload(packed);
    expect(back ? Array.from(back) : null).toEqual(Array.from(content));
  });

  it('改动一个字节后 CRC 校验失败', () => {
    const packed = packPayload(new Uint8Array(CONTENT_BYTES).fill(7));
    packed[0] ^= 0xff;
    expect(unpackPayload(packed)).toBeNull();
  });

  const sizes: [number, number][] = [
    [120, 120],
    [640, 480],
    [1600, 1200],
  ];

  for (const [w, h] of sizes) {
    it(`${w}x${h} RGB 帧嵌入后可提取，且肉眼改动（每通道 ±1）不影响其余像素`, () => {
      const frame = Buffer.alloc(w * h * 3);
      for (let i = 0; i < frame.length; i += 1) frame[i] = (i * 37 + (i >> 8)) & 0xff;
      const content = new Uint8Array([0x48, 0x4c, 0x57, 0x4d, 0x01, 0xa5, 0x7e, 0x9c]);
      const { data, redundancy } = embedLsb(frame, 3, w, h, packPayload(content));
      expect(redundancy).toBeGreaterThanOrEqual(1);

      // 每个通道最多只改最低位（百万级像素不能逐个 expect，先统计再断言）
      let changed = 0;
      let maxDelta = 0;
      for (let i = 0; i < frame.length; i += 1) {
        const d = Math.abs(data[i]! - frame[i]!);
        if (d > maxDelta) maxDelta = d;
        if (d !== 0) changed += 1;
      }
      expect(maxDelta).toBeLessThanOrEqual(1);
      expect(changed).toBeGreaterThan(0);

      const back = extractLsb(data, 3, w, h);
      expect(back ? Array.from(back) : null).toEqual(Array.from(content));
    });
  }

  it('RGBA 帧跳过 alpha 通道', () => {
    const w = 200;
    const h = 200;
    const frame = Buffer.alloc(w * h * 4, 0b1010_1010);
    const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { data } = embedLsb(frame, 4, w, h, packPayload(content));
    let alphaChanged = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0b1010_1010) alphaChanged += 1;
    }
    expect(alphaChanged).toBe(0); // alpha 不动
    expect(Array.from(extractLsb(data, 4, w, h) ?? new Uint8Array())).toEqual(Array.from(content));
  });

  it('少量 LSB 被噪声翻转后仍能多数表决恢复', () => {
    const w = 800;
    const h = 800;
    const frame = Buffer.alloc(w * h * 3, 0x55);
    const content = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const { data } = embedLsb(frame, 3, w, h, packPayload(content));
    // 随机翻转约 2% 通道的最低位
    for (let i = 0; i < data.length; i += 1) {
      if ((i * 2654435761) % 100 < 2) data[i] = data[i]! ^ 1;
    }
    expect(redundancyFor(w * h)).toBeGreaterThan(1);
    expect(Array.from(extractLsb(data, 3, w, h) ?? new Uint8Array())).toEqual(Array.from(content));
  });

  it('未嵌入水印的随机图提取结果为 null', () => {
    const frame = Buffer.alloc(400 * 300 * 3);
    for (let i = 0; i < frame.length; i += 1) frame[i] = (i * 1103515245 + 12345) & 0xff;
    expect(extractLsb(frame, 3, 400, 300)).toBeNull();
  });
});
