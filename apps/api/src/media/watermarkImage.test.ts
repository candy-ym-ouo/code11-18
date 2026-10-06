import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderWatermarkedImage, readPngText, decodeFrameForExtract } from './watermarkImage';
import { extractLsb } from './watermark';
import { payloadToCode, codeToPayload, verifyWatermarkPayload } from '../utils/wmCode';
import { putBuffer, absOf } from '../storage/local';
import { randomHex } from '../utils/crypto';

describe('水印图片渲染管线（真实 sharp 编码）', () => {
  async function makeSource(): Promise<string> {
    // 画一张内容丰富的 1000x700 测试图
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700">
        <rect width="100%" height="100%" fill="#e8e0d2"/>
        ${Array.from({ length: 40 }, (_, i) => {
          const x = (i * 137) % 1000;
          const y = (i * 211) % 700;
          const r = 20 + (i % 5) * 18;
          const c = ['#2f4858', '#8a5a44', '#6b8f71', '#a47551'][i % 4];
          return `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="0.75"/>`;
        }).join('')}
      </svg>`,
      'utf8',
    );
    const png = await sharp(svg).png().toBuffer();
    const key = `tmp/wm-src-${randomHex(4)}.png`;
    await putBuffer(key, png);
    return absOf(key);
  }

  it('可见模式：输出 PNG 含明水印文字、tEXt 出处块，且盲水印可提取并通过 HMAC 校验', async () => {
    const src = await makeSource();
    const payload = (await import('../utils/wmCode')).randomWatermarkPayload();
    const code = payloadToCode(payload);

    const out = await renderWatermarkedImage({
      sourcePath: src,
      payloadContent: payload,
      visibleText: '老张家 · 家庭档案分享',
      codeLine: `出处验证码 ${code}`,
      visible: true,
    });

    expect(out.data.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect(out.width).toBeLessThanOrEqual(1600);

    const texts = readPngText(out.data);
    expect(texts.Source).toContain('老张家');
    expect(texts.Watermark).toContain(code);

    const decoded = await decodeFrameForExtract(out.data);
    const content = extractLsb(decoded.frame, decoded.stride, decoded.width, decoded.height);
    expect(content).not.toBeNull();
    const backCode = payloadToCode(Buffer.from(content!));
    expect(backCode).toBe(code);
    expect(verifyWatermarkPayload(Buffer.from(content!))).not.toBeNull();
    expect(Buffer.compare(codeToPayload(backCode)!, payload)).toBe(0);
  }, 30000);

  it('仅盲水印模式：画面与原图一致，盲水印同样可提取', async () => {
    const src = await makeSource();
    const payload = (await import('../utils/wmCode')).randomWatermarkPayload();
    const code = payloadToCode(payload);
    const out = await renderWatermarkedImage({
      sourcePath: src,
      payloadContent: payload,
      visibleText: 'x',
      codeLine: `出处验证码 ${code}`,
      visible: false,
    });

    const decoded = await decodeFrameForExtract(out.data);
    const content = extractLsb(decoded.frame, decoded.stride, decoded.width, decoded.height);
    expect(payloadToCode(Buffer.from(content!))).toBe(code);
    // tEXt 出处块仍在（第二道保险），但画面没有可见文字
    expect(readPngText(out.data).Watermark).toContain(code);
  }, 30000);
});
