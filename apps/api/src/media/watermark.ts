/**
 * LSB 盲水印：把一段定长二进制负载隐写进 RGB 像素的最低位。
 *
 * 设计要点：
 * - 负载固定 16 字节：8 字节内容 + CRC32 校验 + 4 字节内容重复（packPayload 内布局）。
 * - 每位写入 3 个通道（R/G/B 三票），并在整幅画面上重复 R 遍，提取时多数表决，
 *   能扛轻微噪点 / 局部裁剪（被裁掉的票丢失，但剩余票仍过半）。
 * - 嵌入顺序由固定种子的 PRNG 决定（不是逐行扫描），提高被肉眼分析的门槛。
 * - 本模块提供的是「可验证的出处标记」，不是对抗专业隐写分析的加密通道。
 */

export const WATERMARK_PAYLOAD_BYTES = 16;
export const CONTENT_BYTES = 8;
const BITS = WATERMARK_PAYLOAD_BYTES * 8; // 128
const PRNG_SEED = 0x484c_574d; // 'HLWM'

/** mulberry32：短小确定性的 PRNG，嵌入/提取两端必须得到同一条位置序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CRC32（IEEE 802.3），用于提取时确认「这确实是我们写入的水印」而非随机噪声。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 8 字节内容 → 16 字节负载：内容 || CRC32(内容,4B) || 内容前 4 字节重复。 */
export function packPayload(content: Uint8Array): Uint8Array {
  if (content.length !== CONTENT_BYTES) throw new Error('水印内容必须是 8 字节');
  const payload = new Uint8Array(WATERMARK_PAYLOAD_BYTES);
  payload.set(content, 0);
  const crc = crc32(content);
  payload[8] = crc & 0xff;
  payload[9] = (crc >>> 8) & 0xff;
  payload[10] = (crc >>> 16) & 0xff;
  payload[11] = (crc >>> 24) & 0xff;
  payload.set(content.subarray(0, 4), 12);
  return payload;
}

/** 校验 CRC，返回 8 字节内容；不匹配返回 null。 */
export function unpackPayload(payload: Uint8Array): Uint8Array | null {
  if (payload.length !== WATERMARK_PAYLOAD_BYTES) return null;
  const content = payload.subarray(0, CONTENT_BYTES);
  const crc = payload[8]! | (payload[9]! << 8) | (payload[10]! << 16) | (payload[11]! << 24);
  if ((crc >>> 0) !== crc32(content)) return null;
  // 末尾 4 字节是内容前 4 字节的冗余副本；损坏则忽略（CRC 已对主副本背书）
  return Uint8Array.from(content);
}

function toBits(payload: Uint8Array): Uint8Array {
  const bits = new Uint8Array(BITS);
  for (let i = 0; i < WATERMARK_PAYLOAD_BYTES; i += 1) {
    for (let j = 0; j < 8; j += 1) bits[i * 8 + j] = (payload[i]! >>> (7 - j)) & 1;
  }
  return bits;
}

function fromBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(WATERMARK_PAYLOAD_BYTES);
  for (let i = 0; i < WATERMARK_PAYLOAD_BYTES; i += 1) {
    for (let j = 0; j < 8; j += 1) out[i] = (out[i]! << 1) | bits[i * 8 + j]!;
  }
  return out;
}

/**
 * 可嵌入的重复次数：每位 3 票（RGB）× R 遍。
 * 上限 99 票/位（足够多数表决），且最多使用 90% 的通道——
 * 给 PRNG 落点的线性探测去重留出空隙，避免占用率接近 100% 时退化。
 */
export function redundancyFor(pixels: number): number {
  const total = pixels * 3;
  return Math.max(1, Math.min(99, Math.floor((total * 0.9) / (BITS * 3))));
}

/** 逻辑通道下标（每像素 3 个，不含 alpha）→ 帧内字节偏移。 */
function byteOffset(logical: number, stride: 3 | 4): number {
  const pixel = Math.floor(logical / 3);
  return pixel * stride + (logical % 3);
}

/**
 * 生成 n 个互不相同的逻辑通道下标（[0,total)）。
 * 不做整幅洗牌（1700 万元素太慢）：PRNG 直接落点 + 线性探测去重，
 * 嵌入与提取两端以相同序列访问即可，n/total 占比很低时碰撞成本可忽略。
 */
function shuffledChannels(total: number, n: number): Int32Array {
  const out = new Int32Array(n);
  const used = new Set<number>();
  const rnd = mulberry32(PRNG_SEED);
  for (let i = 0; i < n; i += 1) {
    let v = Math.floor(rnd() * total);
    while (used.has(v)) v = (v + 1) % total;
    used.add(v);
    out[i] = v;
  }
  return out;
}

export interface EmbedResult {
  data: Buffer;
  redundancy: number;
}

/**
 * 把负载嵌入原始 RGB/RGBA 帧。通道不足时抛错（调用方应先检查 redundancyFor）。
 */
export function embedLsb(frame: Buffer, stride: 3 | 4, width: number, height: number, payload: Uint8Array): EmbedResult {
  const pixels = width * height;
  const redundancy = redundancyFor(pixels);
  const needed = BITS * 3 * redundancy;
  if (pixels * 3 < needed) throw new Error('图片太小，无法容纳水印');

  const order = shuffledChannels(pixels * 3, needed);
  const bits = toBits(payload);
  const out = Buffer.from(frame);
  for (let i = 0; i < needed; i += 1) {
    const bit = bits[Math.floor(i / (3 * redundancy))]!;
    const offset = byteOffset(order[i]!, stride);
    out[offset] = (out[offset]! & 0xfe) | bit;
  }
  return { data: out, redundancy };
}

/**
 * 从原始 RGB/RGBA 帧提取水印；无法通过 CRC 时返回 null（不是我们的图或已被严重破坏）。
 */
export function extractLsb(frame: Buffer, stride: 3 | 4, width: number, height: number): Uint8Array | null {
  const pixels = width * height;
  const redundancy = redundancyFor(pixels);
  const needed = BITS * 3 * redundancy;
  if (pixels * 3 < needed) return null;

  const order = shuffledChannels(pixels * 3, needed);
  const ones = new Int32Array(BITS);
  for (let i = 0; i < needed; i += 1) {
    const bitIndex = Math.floor(i / (3 * redundancy));
    ones[bitIndex]! += frame[byteOffset(order[i]!, stride)]! & 1;
  }
  // 每位共 3×redundancy 票，严格过半才算 1
  const threshold = (3 * redundancy) / 2;
  const bits = new Uint8Array(BITS);
  for (let i = 0; i < BITS; i += 1) bits[i] = ones[i]! > threshold ? 1 : 0;
  return unpackPayload(fromBits(bits));
}
