import sharp from 'sharp';

/**
 * 分享水印核心。
 *
 * 每张对外图片带两层水印：
 *  1. 可见层：斜向平铺的家庭名暗纹 + 底部出处条（家庭名 / 副本短码 / 分享日期）。
 *  2. 隐形层：在 8×8 分块 DCT 的中频系数上做扩频相关水印——
 *       · 每个图像块按其全局块坐标生成确定性的 chip（在哪个载荷位、是 +1 还是 -1）；
 *       · 同一位在全图数千个块里重复，解码时把中频系数能量按 chip 相关累加；
 *       · JPEG 本身工作在 8×8 DCT 域，中频系数在常用压缩档位下方向稳定，
 *         因此重压缩后相关符号大概率不翻转；
 *       · 回流图若被裁剪，解码器枚举 8×8 网格偏移取相关峰，仍可盲对齐。
 *     读出的短码经服务端 HMAC 验签后回溯「哪条链接、哪位访客、哪张图」。
 *
 * 正常分发输出无损 PNG；隐形层是为「图片被另存/转发后回流」兜底的。
 */

export const CODE_BYTES = 3; // 24 bit
const MAGIC_BITS = 8; // 固定 'H'，用于对齐评分与有无水印判定
export const PAYLOAD_BITS = MAGIC_BITS + CODE_BYTES * 8; // 32
const N = 8; // DCT 块边长
const STRENGTH = 16; // 中频系数的加性调制幅度（实验标定：q75 JPEG 仍稳）

// 中频系数位置（zigzag 中段），避开直流与高频
const MID: ReadonlyArray<readonly [number, number]> = [
  [4, 1],
  [1, 4],
  [3, 2],
  [2, 3],
  [5, 1],
  [1, 5],
  [4, 2],
  [2, 4],
];

/** 对外展示形式：HL + 6 位大写十六进制 */
export function formatCode(codeHex: string): string {
  return `HL${codeHex.toUpperCase()}`;
}

const MAGIC_BYTE = 0x48;

function payloadBits(codeHex: string): Int8Array {
  const bits = new Int8Array(PAYLOAD_BITS);
  for (let i = 0; i < MAGIC_BITS; i += 1) bits[i] = (MAGIC_BYTE >> (7 - i)) & 1;
  const code = Buffer.from(codeHex, 'hex');
  for (let b = 0; b < CODE_BYTES; b += 1) {
    for (let i = 0; i < 8; i += 1) bits[MAGIC_BITS + b * 8 + i] = (code[b]! >> (7 - i)) & 1;
  }
  return bits;
}

// ---- 8×8 DCT（II 型正交变换） ----------------------------------------------

const COS: number[][] = (() => {
  const m: number[][] = [];
  for (let u = 0; u < N; u += 1) {
    const row: number[] = [];
    for (let x = 0; x < N; x += 1) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) * (u === 0 ? Math.SQRT1_2 : 1) * Math.sqrt(2 / N));
    }
    m.push(row);
  }
  return m;
})();

function dctForward(block: ArrayLike<number>): Float64Array {
  // 先对行、再对列做一维 DCT
  const tmp = new Float64Array(N * N);
  for (let v = 0; v < N; v += 1) {
    for (let x = 0; x < N; x += 1) {
      let s = 0;
      for (let y = 0; y < N; y += 1) s += COS[v]![y]! * block[y * N + x]!;
      tmp[v * N + x] = s;
    }
  }
  const out = new Float64Array(N * N);
  for (let v = 0; v < N; v += 1) {
    for (let u = 0; u < N; u += 1) {
      let s = 0;
      for (let x = 0; x < N; x += 1) s += tmp[v * N + x]! * COS[u]![x]!;
      out[v * N + u] = s;
    }
  }
  return out;
}

function dctInverse(dct: Float64Array): Float64Array {
  const tmp = new Float64Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let u = 0; u < N; u += 1) {
      let s = 0;
      for (let v = 0; v < N; v += 1) s += COS[v]![y]! * dct[v * N + u]!;
      tmp[y * N + u] = s;
    }
  }
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      let s = 0;
      for (let u = 0; u < N; u += 1) s += tmp[y * N + u]! * COS[u]![x]!;
      out[y * N + x] = s;
    }
  }
  return out;
}

// ---- chip 图案：由块全局坐标确定性派生 --------------------------------------
// 同一坐标的块在编码与解码时必须得到同一 (载荷位序号, 符号)。
// 不依赖图像尺寸本身，因此裁剪后块坐标若保持不变可直接对上；缩放场景靠偏移搜索兜底。

function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function chipAt(blockCol: number, blockRow: number): { index: number; sign: number } {
  const h = hash2(blockCol, blockRow);
  return { index: h % PAYLOAD_BITS, sign: h & 0x8000 ? 1 : -1 };
}

/**
 * 隐形水印写入（在可见水印合成之后、PNG 编码之前）。
 * 只调制亮度通道：对 RGB 三通道同步叠加同一扰动量，等效于改亮度而几乎不改色度。
 */
export function embedDct(rgba: Buffer, width: number, height: number, codeHex: string): void {
  const bits = payloadBits(codeHex);
  const block = new Float64Array(N * N);

  for (let by = 0; by + N <= height; by += N) {
    for (let bx = 0; bx + N <= width; bx += N) {
      const chip = chipAt(bx / N, by / N);
      const s = chip.sign * (bits[chip.index] === 1 ? 1 : -1);

      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const p = ((by + y) * width + bx + x) * 4;
          block[y * N + x] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
        }
      }
      const dct = dctForward(block);
      for (const [u, v] of MID) dct[v * N + u] = dct[v * N + u]! + s * STRENGTH;
      const spatial = dctInverse(dct);

      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const p = ((by + y) * width + bx + x) * 4;
          const orig = block[y * N + x]!;
          const delta = spatial[y * N + x]! - orig;
          // 三通道同步加 delta（限幅），视觉上是轻微亮度纹理
          for (let c = 0; c < 3; c += 1) {
            const next = Math.round(rgba[p + c]! + delta);
            rgba[p + c] = next < 0 ? 0 : next > 255 ? 255 : next;
          }
        }
      }
    }
  }
}

export function canEmbed(width: number, height: number): boolean {
  return width >= 96 && height >= 96;
}

/** 按相关和符号判决全部载荷位；魔数不匹配则返回 null。 */
function decodeWithCorr(corr: Float64Array): { code: string | null; margin: number } {
  const bits = new Int8Array(PAYLOAD_BITS);
  let minAbs = Infinity;
  for (let k = 0; k < PAYLOAD_BITS; k += 1) {
    bits[k] = corr[k]! > 0 ? 1 : 0;
    const a = Math.abs(corr[k]!);
    if (a < minAbs) minAbs = a;
  }
  for (let i = 0; i < MAGIC_BITS; i += 1) {
    if (bits[i] !== ((MAGIC_BYTE >> (7 - i)) & 1)) return { code: null, margin: minAbs };
  }
  const code = Buffer.alloc(CODE_BYTES);
  for (let b = 0; b < CODE_BYTES; b += 1) {
    for (let i = 0; i < 8; i += 1) {
      if (bits[MAGIC_BITS + b * 8 + i]) code[b] = code[b]! | (1 << (7 - i));
    }
  }
  return { code: code.toString('hex'), margin: minAbs };
}

/**
 * 从像素提取短码。
 *
 * 回流图可能经过：无损另存（网格不变）、JPEG（网格基本不变）、裁剪（全局块坐标平移）、
 * 缩放（行列起点与编号都可能变）。为让搜索足够便宜，先把图像全部 8×8 块的中频
 * 能量（相对 (0,0) 网格）一次性算出；之后枚举网格原点偏移与块编号基只是对这张
 * 能量表做下标组合，代价极低。命中条件：8 位魔数全部通过 + 最弱数据位的相关边际最大。
 */
export function extractCode(rgba: Buffer, width: number, height: number): string | null {
  if (!canEmbed(width, height)) return null;

  // 1) 以 (0,0) 为网格原点的块能量表（含一圈越界块，偏移搜索时直接从相应位置取窗）
  const gridCols = Math.ceil(width / N);
  const gridRows = Math.ceil(height / N);
  const energy = new Float64Array(gridCols * gridRows);
  const valid = new Uint8Array(gridCols * gridRows);
  const block = new Float64Array(N * N);
  for (let gy = 0; gy < gridRows; gy += 1) {
    for (let gx = 0; gx < gridCols; gx += 1) {
      const x0 = gx * N;
      const y0 = gy * N;
      if (x0 + N > width || y0 + N > height) continue;
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const p = ((y0 + y) * width + x0 + x) * 4;
          block[y * N + x] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
        }
      }
      const dct = dctForward(block);
      let e = 0;
      for (const [u, v] of MID) e += dct[v * N + u]!;
      energy[gy * gridCols + gx] = e;
      valid[gy * gridCols + gx] = 1;
    }
  }

  // 偏移采样：枚举所有块的 chip，但只为落在 SHIFT_STEP 网格上的块付 DCT 成本。
  // 关键是 chip 仍按块在整图里的真实列/行号取，保证相关不错位。
  const SHIFT_STEP = 5;
  const shiftedCache = new Map<string, { corrAt: (baseCol: number, baseRow: number) => Float64Array }>();

  const shiftedCorrelator = (offX: number, offY: number) => {
    const key = `${offX},${offY}`;
    const hit = shiftedCache.get(key);
    if (hit) return hit;

    // 先把该偏移网格上需要采样的块（坐标 + 中频能量）算好
    const samples: Array<{ col: number; row: number; energy: number }> = [];
    for (let y0 = offY, row = 0; y0 + N <= height; y0 += N, row += 1) {
      for (let x0 = offX, col = 0; x0 + N <= width; x0 += N, col += 1) {
        if (col % SHIFT_STEP !== 0 || row % SHIFT_STEP !== 0) continue;
        for (let y = 0; y < N; y += 1) {
          for (let x = 0; x < N; x += 1) {
            const p = ((y0 + y) * width + x0 + x) * 4;
            block[y * N + x] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
          }
        }
        const dct = dctForward(block);
        let en = 0;
        for (const [u, v] of MID) en += dct[v * N + u]!;
        samples.push({ col, row, energy: en });
      }
    }

    const corrAt = (baseCol: number, baseRow: number): Float64Array => {
      const corr = new Float64Array(PAYLOAD_BITS);
      for (const s of samples) {
        const chip = chipAt(baseCol + s.col, baseRow + s.row);
        corr[chip.index] = corr[chip.index]! + chip.sign * s.energy;
      }
      return corr;
    };
    shiftedCache.set(key, { corrAt });
    return { corrAt };
  };

  /** (0,0) 网格全量块相关（直存/未裁剪场景，信号最完整）。 */
  const accumulateFull = (baseCol: number, baseRow: number) => {
    const corr = new Float64Array(PAYLOAD_BITS);
    let blocks = 0;
    for (let gy = 0; gy < gridRows; gy += 1) {
      for (let gx = 0; gx < gridCols; gx += 1) {
        if (!valid[gy * gridCols + gx]) continue;
        const chip = chipAt(baseCol + gx, baseRow + gy);
        corr[chip.index] = corr[chip.index]! + chip.sign * energy[gy * gridCols + gx]!;
        blocks += 1;
      }
    }
    return { corr, blocks };
  };

  const cols = Math.floor(width / N);
  const rows = Math.floor(height / N);
  const colShift = Math.min(160, Math.floor(cols / 2));
  const rowShift = Math.min(120, Math.floor(rows / 2));

  const scoreCorr = (corr: Float64Array, sampledBlocks?: number) => {
    // 采样相关的量级随样本数缩放，归一化到「每块平均绝对相关」再比较
    const divisor = sampledBlocks && sampledBlocks > 0 ? sampledBlocks : 1;
    let magic = 0;
    let dataSum = 0;
    let dataCount = 0;
    let minData = Infinity;
    for (let k = 0; k < PAYLOAD_BITS; k += 1) {
      const bit = corr[k]! > 0 ? 1 : 0;
      const mag = Math.abs(corr[k]!) / divisor;
      if (k < MAGIC_BITS) {
        if (bit === ((MAGIC_BYTE >> (7 - k)) & 1)) magic += 1;
      } else {
        dataSum += mag;
        dataCount += 1;
        if (mag < minData) minData = mag;
      }
    }
    // confidence：数据位的平均相关强度。真正对齐时所有位都被同向能量加强，
    // 误对齐只是偶然翻对魔数，数据位平均强度接近 0。用它把假阳性压下去。
    const confidence = dataCount ? dataSum / dataCount : 0;
    return { magic, margin: minData === Infinity ? 0 : minData, confidence };
  };

  // 2) 粗筛：(0,0) 网格全量相关，细步长扫编号基
  const totalGridBlocks = cols * rows;
  const rough: Array<{ baseCol: number; baseRow: number; magic: number; margin: number; confidence: number }> = [];
  // 步长 2 时有两种奇偶相位，起点偏移 1 各扫一遍，避免正确基恰好落在另一相位上
  for (let phaseRow = 0; phaseRow < 2; phaseRow += 1) {
    for (let phaseCol = 0; phaseCol < 2; phaseCol += 1) {
      for (let baseRow = -rowShift + phaseRow; baseRow <= rowShift; baseRow += 2) {
        for (let baseCol = -colShift + phaseCol; baseCol <= colShift; baseCol += 2) {
          const { corr } = accumulateFull(baseCol, baseRow);
          rough.push({ baseCol, baseRow, ...scoreCorr(corr, totalGridBlocks) });
        }
      }
    }
  }
  // 魔数优先；同为满命中时按数据位置信度排，真对齐的置信度远高于撞大运
  rough.sort((a, b) => b.magic - a.magic || b.confidence - a.confidence);

  // 3) 偏移对齐：对粗选高分基的邻域，枚举 64 种网格原点（采样相关），
  //    找「魔数满命中」的 (基, 偏移) 组合
  const seeds = rough.filter((r) => r.magic >= 7).slice(0, 8);
  const pool = seeds.length ? seeds : rough.slice(0, 2);
  const neighborhood = new Set<string>();
  for (const seed of pool) {
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) neighborhood.add(`${seed.baseCol + dc},${seed.baseRow + dr}`);
    }
  }

  // 采样块数（对任意偏移都一样，用于把采样相关归一化）
  const sampleCols = Math.floor(cols / SHIFT_STEP) + 1;
  const sampleRows = Math.floor(rows / SHIFT_STEP) + 1;
  const sampledBlocks = sampleCols * sampleRows;

  interface Combo {
    baseCol: number;
    baseRow: number;
    offX: number;
    offY: number;
    magic: number;
    margin: number;
    confidence: number;
  }
  const combos: Combo[] = [];
  for (const key of neighborhood) {
    const [baseCol, baseRow] = key.split(',').map(Number) as [number, number];
    for (let offY = 0; offY < N; offY += 1) {
      for (let offX = 0; offX < N; offX += 1) {
        const corr =
          offX === 0 && offY === 0
            ? accumulateFull(baseCol, baseRow).corr
            : shiftedCorrelator(offX, offY).corrAt(baseCol, baseRow);
        const score = scoreCorr(corr, offX === 0 && offY === 0 ? totalGridBlocks : sampledBlocks);
        combos.push({ baseCol, baseRow, offX, offY, ...score });
      }
    }
  }
  combos.sort((a, b) => b.magic - a.magic || b.confidence - a.confidence);

  // 4) 对魔数满命中的前几个组合做全量复验（非零偏移需即时全量 DCT）。
  //    判决分数用「最弱数据位相关 / 块数」归一化——不同组合参与块数不同，
  //    直接比相关绝对值会让误对齐的偶然大值胜出。
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of combos.filter((x) => x.magic >= MAGIC_BITS).slice(0, 8)) {
    let corr: Float64Array;
    let blockCount = 0;
    if (c.offX === 0 && c.offY === 0) {
      const full = accumulateFull(c.baseCol, c.baseRow);
      corr = full.corr;
      blockCount = full.blocks;
    } else {
      const full = new Float64Array(PAYLOAD_BITS);
      for (let y0 = c.offY; y0 + N <= height; y0 += N) {
        for (let x0 = c.offX; x0 + N <= width; x0 += N) {
          for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) {
              const p = ((y0 + y) * width + x0 + x) * 4;
              block[y * N + x] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
            }
          }
          const dct = dctForward(block);
          let en = 0;
          for (const [u, v] of MID) en += dct[v * N + u]!;
          const chip = chipAt(c.baseCol + (x0 - c.offX) / N, c.baseRow + (y0 - c.offY) / N);
          full[chip.index] = full[chip.index]! + chip.sign * en;
          blockCount += 1;
        }
      }
      corr = full;
    }
    const decoded = decodeWithCorr(corr);
    const score = decoded.margin / Math.max(1, blockCount);
    if (decoded.code && score > bestScore) {
      bestScore = score;
      best = decoded.code;
    }
  }
  return best;
}

// ---- 可见水印 --------------------------------------------------------------

export interface VisibleWatermarkInput {
  familyName: string;
  code: string;
  sharedDate: string;
  width: number;
  height: number;
  showProvenanceBar: boolean;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function watermarkSvg(input: VisibleWatermarkInput): Buffer {
  const { width, height, familyName, code, sharedDate, showProvenanceBar } = input;
  const name = escapeXml(familyName.slice(0, 24));
  const tile = Math.max(150, Math.round(Math.min(width, height) * 0.34));
  const fontSize = Math.max(13, Math.round(tile * 0.13));

  const bar = showProvenanceBar
    ? `
  <rect x="0" y="${height - Math.round(fontSize * 2.7)}" width="${width}" height="${Math.round(fontSize * 2.7)}" fill="rgba(0,0,0,0.42)"/>
  <text x="${Math.round(fontSize * 0.8)}" y="${height - Math.round(fontSize * 0.95)}"
        font-family="sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.92)">
    ${name} · 出处可验 ${escapeXml(code)} · ${sharedDate}
  </text>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <pattern id="wm" patternUnits="userSpaceOnUse" width="${tile}" height="${tile}"
             patternTransform="rotate(-28)">
      <text x="${tile / 2}" y="${tile / 2}" text-anchor="middle"
            font-family="sans-serif" font-size="${fontSize}" font-weight="600"
            fill="rgba(255,255,255,0.5)" stroke="rgba(0,0,0,0.28)" stroke-width="${Math.max(
              1,
              Math.round(fontSize * 0.06),
            )}" paint-order="stroke">${name}</text>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)" opacity="0.5"/>${bar}
</svg>`;
  return Buffer.from(svg, 'utf8');
}

export interface RenderInput {
  sourcePath: string;
  codeHex: string;
  familyName: string;
  sharedDate: string;
  variant: 'full' | 'thumb';
}

export interface RenderResult {
  data: Buffer;
  width: number;
  height: number;
  embedded: boolean;
}

const FULL_MAX = 2400;
const THUMB_MAX = 960;

/** 渲染一张带可见 + 隐形水印的 PNG。 */
export async function renderWatermarkedPng(input: RenderInput): Promise<RenderResult> {
  const { sourcePath, codeHex, familyName, sharedDate, variant } = input;
  const maxEdge = variant === 'full' ? FULL_MAX : THUMB_MAX;

  const composited = await sharp(sourcePath, { failOn: 'none' })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = composited.info;
  const overlay = await sharp(
    watermarkSvg({
      familyName,
      code: formatCode(codeHex),
      sharedDate,
      width,
      height,
      showProvenanceBar: variant === 'full',
    }),
  )
    .ensureAlpha()
    .toBuffer();

  const withVisible = await sharp(composited.data)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let embedded = true;
  if (canEmbed(withVisible.info.width, withVisible.info.height)) {
    embedDct(withVisible.data, withVisible.info.width, withVisible.info.height, codeHex);
  } else {
    embedded = false;
  }
  const png = await sharp(withVisible.data, {
    raw: { width: withVisible.info.width, height: withVisible.info.height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();

  return { data: png, width: withVisible.info.width, height: withVisible.info.height, embedded };
}

/** 从任意图片文件（回流的疑似外泄图）中尝试提取隐形短码。 */
export async function extractCodeHexFromFile(path: string): Promise<string | null> {
  let rgba: Buffer;
  let width = 0;
  let height = 0;
  try {
    const loaded = await sharp(path, { failOn: 'none' }).ensureAlpha();
    const meta = await loaded.metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    rgba = await loaded.raw().toBuffer();
  } catch {
    return null;
  }
  if (!width || !height) return null;
  return extractCode(rgba, width, height);
}
