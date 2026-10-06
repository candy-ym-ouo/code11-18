import sharp from 'sharp';
import { packPayload, embedLsb } from './watermark';

/**
 * 对外水印图片渲染：
 * 1. 源图统一缩到最长边 1600，保持 EXIF 方向纠正；
 * 2. 叠加平铺可见水印（出处家庭 + 水印码 + 日期）；
 * 3. LSB 隐写同一水印码（盲水印，截图/裁剪/去字后仍可提取验证）；
 * 4. PNG tEXt 块写入出处声明（规范化二次保存仍可能保留，属第二道保险）。
 * 输出 PNG（无损），保证 LSB 不被有损编码抹掉。
 */

const WM_MAX_EDGE = 1600;

export interface RenderWatermarkInput {
  sourcePath: string;
  /** 隐写内容：恰好 8 字节（由水印码派生） */
  payloadContent: Uint8Array;
  visibleText: string;
  codeLine: string;
  /** false 时只嵌盲水印、不叠加可见文字（「lsb」模式） */
  visible?: boolean;
}

export interface RenderedWatermark {
  data: Buffer;
  width: number;
  height: number;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

function tileInner(lines: string[], fontSize: number, tileW: number, tileH: number): string {
  const lineHtml = lines
    .map((line, i) => `<text x="50%" y="${52 + i * (fontSize + 10)}" class="l">${escapeXml(line)}</text>`)
    .join('');
  return `<style>.l { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
       font-size: ${fontSize}px; fill: rgba(0,0,0,0.20); text-anchor: middle; font-weight: 600; }</style>
  <g transform="rotate(-22 ${tileW / 2} ${tileH / 2})">${lineHtml}</g>`;
}

/** 构造覆盖整图的平铺水印 SVG（嵌套 svg 定位每个水印块）。 */
function fullOverlaySvg(width: number, height: number, lines: string[], fontSize: number): Buffer {
  const tileW = Math.max(300, Math.round(width / 2.2));
  const tileH = Math.max(180, Math.round(height / 3.2));
  const cols = Math.ceil(width / tileW) + 2;
  const rows = Math.ceil(height / tileH) + 2;
  const tiles: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = c * tileW - tileW / 2;
      const y = r * tileH - tileH / 2;
      tiles.push(
        `<svg x="${x}" y="${y}" width="${tileW}" height="${tileH}" viewBox="0 0 ${tileW} ${tileH}">${tileInner(lines, fontSize, tileW, tileH)}</svg>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${tiles.join('\n  ')}
</svg>`;
  return Buffer.from(svg, 'utf8');
}

// PNG chunk 工具：在 IEND 前插入 tEXt 出处块
function crc32ForPng(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (c >>> 8) ^ PNG_CRC_TABLE[(c ^ b) & 0xff]!;
  return (c ^ 0xffffffff) >>> 0;
}
const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngTextChunk(keyword: string, text: string): Buffer {
  const body = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const type = Buffer.from('tEXt', 'latin1');
  const crcInput = Buffer.concat([type, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32ForPng(crcInput), 0);
  return Buffer.concat([len, type, body, crc]);
}

/** 在 PNG 的 IEND 之前插入 tEXt 块。 */
export function injectPngText(png: Buffer, entries: Record<string, string>): Buffer {
  const iendPos = png.length - 12; // IEND 固定 4 长度 + 4 类型 + 4 CRC
  if (png.subarray(iendPos + 4, iendPos + 8).toString('latin1') !== 'IEND') return png;
  const chunks = Object.entries(entries).map(([k, v]) => pngTextChunk(k, v));
  return Buffer.concat([png.subarray(0, iendPos), ...chunks, png.subarray(iendPos)]);
}

export async function renderWatermarkedImage(input: RenderWatermarkInput): Promise<RenderedWatermark> {
  const base = sharp(input.sourcePath, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const resized = base.resize({
    width: WM_MAX_EDGE,
    height: WM_MAX_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const sizedPng = await resized.png().toBuffer({ resolveWithObject: true });
  const width = sizedPng.info.width;
  const height = sizedPng.info.height;
  const fontSize = Math.max(14, Math.round(Math.min(width, height) / 42));

  const overlay =
    input.visible === false
      ? null
      : fullOverlaySvg(width, height, [input.visibleText, input.codeLine], fontSize);
  const composited = await sharp(sizedPng.data)
    .composite(overlay ? [{ input: overlay, top: 0, left: 0 }] : [])
    .png()
    .ensureAlpha(0) // 保证 4 通道帧；嵌入时只动 RGB，alpha 不参与
    .raw()
    .toBuffer({ resolveWithObject: true });

  const stride = (composited.info.channels ?? 4) as 3 | 4;
  const { data: embeddedFrame } = embedLsb(composited.data, stride, width, height, packPayload(input.payloadContent));

  let out = await sharp(embeddedFrame, { raw: { width, height, channels: stride } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  out = injectPngText(out, {
    Source: input.visibleText,
    Watermark: input.codeLine,
    Software: 'heirloom provenance watermark',
  });

  void meta;
  return { data: out, width, height };
}

/** 从任意图片文件解码出原始 RGB/RGBA 帧，供提取盲水印用（截图/转存后的文件均可尝试）。 */
export async function decodeFrameForExtract(
  pathOrBuf: string | Buffer,
): Promise<{ frame: Buffer; stride: 3 | 4; width: number; height: number }> {
  const img = sharp(pathOrBuf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const out = await img.ensureAlpha(0).raw().toBuffer({ resolveWithObject: true });
  return {
    frame: out.data,
    stride: (out.info.channels ?? 4) as 3 | 4,
    width: out.info.width ?? meta.width ?? 0,
    height: out.info.height ?? meta.height ?? 0,
  };
}

/** 读取 PNG tEXt 块（出处声明的第二道保险）。 */
export function readPngText(png: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  if (png.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') return result;
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('latin1');
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const body = png.subarray(pos + 8, pos + 8 + len);
      const zero = body.indexOf(0);
      if (zero > 0) result[body.subarray(0, zero).toString('latin1')] = body.subarray(zero + 1).toString('utf8');
    }
    pos += 12 + len;
  }
  return result;
}
