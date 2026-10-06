#!/usr/bin/env node
/**
 * 水印出处验证器（运维侧，无数据库依赖）：
 *   node scripts/watermark-verify.mjs <image.png>
 *
 * - 提取像素中的 LSB 盲水印 → 13 位出处验证码 → 校验 HMAC 防伪指纹；
 * - 读取 PNG tEXt 出处块作为退路；
 * 输出 JSON：{ source: 'lsb'|'png-text'|null, wmCode, authentic }。
 * 拿到 wmCode 后，在应用的「分享溯源」页按验证码反查具体链接与访客。
 */
import { readFile } from 'node:fs/promises';
// config.ts（被 wmCode.js 间接引入）启动时会自动加载仓库根目录的 .env，提供 JWT_SECRET
import sharp from '../apps/api/node_modules/sharp/lib/index.js';
import { readPngText } from '../apps/api/dist/media/watermarkImage.js';
import { extractLsb } from '../apps/api/dist/media/watermark.js';
import { payloadToCode, parseVerifiedCode } from '../apps/api/dist/utils/wmCode.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/watermark-verify.mjs <图片路径>');
    process.exit(2);
  }
  const buf = await readFile(file);

  const img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const raw = await sharp(buf, { failOn: 'none' })
    .rotate()
    .ensureAlpha(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let result = { source: null, wmCode: null, authentic: false, width: meta.width, height: meta.height };

  const content = extractLsb(raw.data, raw.info.channels, raw.info.width, raw.info.height);
  if (content) {
    const code = payloadToCode(Buffer.from(content));
    result = { ...result, source: 'lsb', wmCode: code, authentic: parseVerifiedCode(code) !== null };
  } else {
    const texts = readPngText(buf);
    const m = texts.Watermark?.match(/([0-9A-Z]{13})/);
    if (m) result = { ...result, source: 'png-text', wmCode: m[1], authentic: parseVerifiedCode(m[1]) !== null };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.wmCode && result.authentic ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败：', err.message);
  process.exit(2);
});
