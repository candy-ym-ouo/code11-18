import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  canEmbed,
  extractCode,
  formatCode,
  renderWatermarkedPng,
} from './watermark';
import { putBuffer, absOf } from '../storage/local';

async function rawPng(buf: Buffer) {
  const img = sharp(buf).ensureAlpha();
  const meta = await img.metadata();
  const rgba = await img.raw().toBuffer();
  return { rgba, width: meta.width!, height: meta.height! };
}

describe('可见水印格式', () => {
  it('短码展示格式为 HL + 6 位大写十六进制', () => {
    expect(formatCode('a1b2c3')).toBe('HLA1B2C3');
  });

  it('图小于 96px 时报告不可嵌入', () => {
    expect(canEmbed(80, 200)).toBe(false);
    expect(canEmbed(96, 96)).toBe(true);
  });
});

describe('renderWatermarkedPng + 隐形 DCT 水印', () => {
  it('渲染出的无损 PNG 能被重新解码并验出短码', async () => {
    const src = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#7a5230' },
    })
      .jpeg()
      .toBuffer();
    const key = 'tmp/wm-test-src.jpg';
    await putBuffer(key, src);

    const code = 'dead01';
    const result = await renderWatermarkedPng({
      sourcePath: absOf(key),
      codeHex: code,
      familyName: '张家',
      sharedDate: '2026-10-06',
      variant: 'full',
    });

    expect(result.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.embedded).toBe(true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);

    const { rgba, width, height } = await rawPng(result.data);
    expect(extractCode(rgba, width, height)).toBe(code);
  });

  it('thumb 版本同样携带隐形短码', async () => {
    const src = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: '#334455' },
    })
      .png()
      .toBuffer();
    const key = 'tmp/wm-test-src-thumb.png';
    await putBuffer(key, src);

    const code = '112233';
    const result = await renderWatermarkedPng({
      sourcePath: absOf(key),
      codeHex: code,
      familyName: '李家',
      sharedDate: '2026-10-06',
      variant: 'thumb',
    });
    expect(result.width).toBeLessThanOrEqual(960);
    const { rgba, width, height } = await rawPng(result.data);
    expect(extractCode(rgba, width, height)).toBe(code);
  });

  it('JPEG 重压缩（q75）后仍可验出短码', async () => {
    const src = await sharp({
      create: { width: 1000, height: 900, channels: 3, background: '#5a6b7a' },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const key = 'tmp/wm-test-jpeg.jpg';
    await putBuffer(key, src);

    const code = 'aabbcc';
    const result = await renderWatermarkedPng({
      sourcePath: absOf(key),
      codeHex: code,
      familyName: '赵家',
      sharedDate: '2026-10-06',
      variant: 'full',
    });
    const recompressed = await sharp(result.data).jpeg({ quality: 75 }).toBuffer();
    const { rgba, width, height } = await rawPng(recompressed);
    expect(extractCode(rgba, width, height)).toBe(code);
  }, 30000);

  it('未加水印的图验码返回 null（魔数不匹配）', async () => {
    const src = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#202020' },
    })
      .png()
      .toBuffer();
    const { rgba, width, height } = await rawPng(src);
    expect(extractCode(rgba, width, height)).toBeNull();
  });
});
