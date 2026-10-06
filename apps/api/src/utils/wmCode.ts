import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { randomHex } from './crypto';

/**
 * 水印码体系（隐写 8 字节负载的布局）：
 *   [0..4] 5 字节随机挑战值（约 1.1×10^12 种，不可猜测/枚举）
 *   [5..7] 3 字节 HMAC-SHA256(JWT_SECRET, challenge) 截断指纹（防伪）
 *
 * 同一负载有两种对外形态：
 * - 13 位 Crockford Base32 短码 wmCode（画在明水印上，人工可读、可抄录检索）；
 * - LSB 隐写在像素里（截图/裁掉明水印后仍可提取）。
 *
 * 验证时先校验 HMAC 指纹（不需要数据库即可判断「是不是本系统签发的码」），
 * 再按 challenge 反查 share_watermarks 得到具体链接、访客与全部访问留痕。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（去掉易混 I/L/O/U）
export const CHALLENGE_BYTES = 5;
export const MAC_BYTES = 3;
export const PAYLOAD_BYTES = 8;
const CODE_LEN = 13; // ceil(64 / 5) = 13 位 base32

function hmac(challenge: Buffer): Buffer {
  return createHmac('sha256', config.JWT_SECRET).update('heirloom-watermark/v1').update(challenge).digest();
}

/** 生成一份随机水印负载（8 字节）。 */
export function randomWatermarkPayload(): Buffer {
  const challenge = Buffer.from(randomHex(CHALLENGE_BYTES), 'hex');
  return assemblePayload(challenge);
}

export function assemblePayload(challenge: Buffer): Buffer {
  if (challenge.length !== CHALLENGE_BYTES) throw new Error('challenge 必须是 5 字节');
  return Buffer.concat([challenge, hmac(challenge).subarray(0, MAC_BYTES)]);
}

/** 8 字节负载 → 13 位 Crockford Base32 短码。 */
export function payloadToCode(payload: Buffer): string {
  if (payload.length !== PAYLOAD_BYTES) throw new Error('水印负载必须是 8 字节');
  let bits = 0n;
  for (const b of payload) bits = (bits << 8n) | BigInt(b);
  let code = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    code = ALPHABET[Number(bits % 32n)] + code;
    bits /= 32n;
  }
  return code;
}

/** 13 位短码 → 8 字节负载；字符/长度非法返回 null。 */
export function codeToPayload(code: string): Buffer | null {
  if (code.length !== CODE_LEN || !/^[0-9A-Z]+$/.test(code)) return null;
  let bits = 0n;
  for (const ch of code) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    bits = bits * 32n + BigInt(v);
  }
  const out = Buffer.alloc(PAYLOAD_BYTES);
  for (let i = PAYLOAD_BYTES - 1; i >= 0; i -= 1) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

/** 校验负载里的 HMAC 指纹是否合法（防伪），合法返回 5 字节 challenge。 */
export function verifyWatermarkPayload(payload: Buffer): Buffer | null {
  if (payload.length !== PAYLOAD_BYTES) return null;
  const challenge = payload.subarray(0, CHALLENGE_BYTES);
  const mac = payload.subarray(CHALLENGE_BYTES);
  const expect = hmac(challenge).subarray(0, MAC_BYTES);
  try {
    if (!timingSafeEqual(mac, expect)) return null;
  } catch {
    return null;
  }
  return Buffer.from(challenge);
}

/** 短码 → challenge（先过 HMAC 校验）。 */
export function parseVerifiedCode(code: string): Buffer | null {
  const payload = codeToPayload(code);
  return payload ? verifyWatermarkPayload(payload) : null;
}

/** 对整条出处声明做 HMAC，作为副本记录里的防伪签名。 */
export function signProvenance(parts: string[]): string {
  return createHmac('sha256', config.JWT_SECRET)
    .update('heirloom-provenance/v1')
    .update(parts.join('|'))
    .digest('hex');
}
