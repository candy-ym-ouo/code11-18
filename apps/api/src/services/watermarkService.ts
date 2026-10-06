import { createHmac, randomBytes } from 'node:crypto';
import type { ItemMedia, ShareAccessEvent, ShareLink, WatermarkCopy } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { badRequest, notFound } from '../http/errors';
import { sha256Hex } from '../utils/crypto';
import {
  absOf,
  exists,
  putBuffer,
  readStream,
  remove,
  statObject,
} from '../storage/local';
import {
  CODE_BYTES,
  formatCode,
  renderWatermarkedPng,
} from '../media/watermark';
import type { FamilyContext } from './permissionService';

/**
 * 水印副本与访问留痕。
 *
 * 对外（公开分享链接）拿到的每张图片都是带水印的独立副本，副本按
 * 「分享链接 × 访客 × 媒体 × 尺寸」去重；撤销链接只置 revokedAt，
 * 副本与留痕不删，日后凭回流图片里的隐形短码就能追到分发对象。
 */

// ---- 签名：让短码无法被伪造，验图时必须能通过 HMAC 重算 --------------------

function signatureKey(): string {
  return config.WATERMARK_HMAC_KEY || config.JWT_SECRET;
}

export function signCode(shareLinkId: string, codeHex: string): string {
  return createHmac('sha256', signatureKey())
    .update(`watermark:${shareLinkId}:${codeHex}`)
    .digest('hex');
}

function generateCodeHex(): string {
  return randomBytes(CODE_BYTES).toString('hex');
}

function watermarkKey(familyId: string, shareLinkId: string, codeHex: string): string {
  return `families/${familyId}/watermarks/${shareLinkId.slice(-12)}/${codeHex}.png`;
}

export interface VisitorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function loadActiveLinkByToken(token: string): Promise<ShareLink & { family: { id: string; name: string } }> {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true } } },
  });
  if (!link || link.revokedAt || link.expiresAt.getTime() < Date.now()) {
    throw notFound('分享链接不存在、已过期或已被撤销');
  }
  return link;
}

/** 公开页校验：链接有效且该媒体属于链接覆盖的条目。 */
export async function loadPublicImage(
  token: string,
  mediaId: string,
): Promise<{
  link: ShareLink & { family: { id: string; name: string } };
  media: ItemMedia;
}> {
  const link = await loadActiveLinkByToken(token);
  const media = await prisma.itemMedia.findFirst({
    where: {
      id: mediaId,
      deletedAt: null,
      kind: 'image',
      item: { shareLinks: { some: { shareLinkId: link.id } } },
    },
  });
  if (!media) throw notFound('图片不存在');
  return { link, media };
}

function sharedDateOf(link: ShareLink): string {
  return link.createdAt.toISOString().slice(0, 10);
}

/**
 * 取（必要时现场渲染）这位访客专属的水印副本。
 * 副本全量渲染（含大文件 sharp 处理）在数据库行锁之外完成；行存在后直接复用。
 */
export async function getOrCreateCopy(input: {
  link: ShareLink & { family: { id: string; name: string } };
  media: ItemMedia;
  visitorId: string;
  variant: 'full' | 'thumb';
}): Promise<WatermarkCopy> {
  const { link, media, visitorId, variant } = input;

  const existing = await prisma.watermarkCopy.findUnique({
    where: {
      shareLinkId_visitorId_mediaId_variant: {
        shareLinkId: link.id,
        visitorId,
        mediaId: media.id,
        variant,
      },
    },
  });
  if (existing) {
    if (await exists(existing.storageKey)) {
      await prisma.watermarkCopy
        .update({ where: { id: existing.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => logger.warn({ err }, '副本 lastUsedAt 更新失败'));
      return existing;
    }
    // 记录还在、文件被存储 GC 误清了：删掉重建
    await prisma.watermarkCopy.delete({ where: { id: existing.id } }).catch(() => undefined);
  }

  // 大图优先基于在线展示用 largeKey（2400 上限），没有处理完就回落原图
  const sourceKey = variant === 'thumb' ? (media.largeKey ?? media.storageKey) : (media.largeKey ?? media.storageKey);
  if (!(await exists(sourceKey))) throw notFound('图片原文件不存在');

  const codeHex = generateCodeHex();
  const rendered = await renderWatermarkedPng({
    sourcePath: absOf(sourceKey),
    codeHex,
    familyName: link.family.name,
    sharedDate: sharedDateOf(link),
    variant,
  });
  const key = watermarkKey(link.familyId, link.id, codeHex);
  await putBuffer(key, rendered.data);

  const sig = signCode(link.id, codeHex);

  try {
    return await prisma.watermarkCopy.create({
      data: {
        shareLinkId: link.id,
        mediaId: media.id,
        visitorId,
        variant,
        code: codeHex,
        storageKey: key,
        byteSize: BigInt(rendered.data.length),
        width: rendered.width,
        height: rendered.height,
        sig,
      },
    });
  } catch (err) {
    // 并发首访：另一个请求已经建好同维度副本，直接复用
    const raced = await prisma.watermarkCopy.findUnique({
      where: {
        shareLinkId_visitorId_mediaId_variant: {
          shareLinkId: link.id,
          visitorId,
          mediaId: media.id,
          variant,
        },
      },
    });
    if (raced) {
      await remove(key).catch(() => undefined);
      return raced;
    }
    await remove(key).catch(() => undefined);
    throw err;
  }
}

export interface ServedCopy {
  copy: WatermarkCopy;
  key: string;
  size: number;
  mimeType: 'image/png';
  filename: string;
}

/** 对外图片出口：取/建副本 + 写一条访问留痕。 */
export async function servePublicImage(input: {
  link: ShareLink & { family: { id: string; name: string } };
  media: ItemMedia;
  visitorId: string;
  variant: 'full' | 'thumb';
  context: 'inline' | 'download';
  meta: VisitorMeta;
}): Promise<ServedCopy> {
  const { link, media, visitorId, variant, context, meta } = input;
  const copy = await getOrCreateCopy({ link, media, visitorId, variant });
  const stat = await statObject(copy.storageKey);
  if (!stat) throw notFound('水印副本文件丢失');

  await prisma.shareAccessEvent
    .create({
      data: {
        shareLinkId: link.id,
        visitorId,
        mediaId: media.id,
        copyId: copy.id,
        context,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    })
    .catch((err) => logger.warn({ err }, '访问留痕写入失败'));

  const baseName = media.originalName.replace(/\.[^.]+$/, '').slice(0, 120) || 'image';
  return {
    copy,
    key: copy.storageKey,
    size: stat.size,
    mimeType: 'image/png',
    filename: `${baseName}-${formatCode(copy.code)}.png`,
  };
}

// ---- 管理端：分发副本列表与留痕 --------------------------------------------

export async function listCopies(ctx: FamilyContext, linkId: string) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');

  const [copies, events] = await Promise.all([
    prisma.watermarkCopy.findMany({
      where: { shareLinkId: linkId },
      orderBy: { firstSeenAt: 'desc' },
      take: 500,
    }),
    prisma.shareAccessEvent.findMany({
      where: { shareLinkId: linkId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
  ]);

  const downloadsByCopy = new Map<string, number>();
  for (const e of events) {
    if (e.context === 'download' && e.copyId) {
      downloadsByCopy.set(e.copyId, (downloadsByCopy.get(e.copyId) ?? 0) + 1);
    }
  }

  return {
    linkId,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    copies: copies.map((c) => ({
      id: c.id,
      code: formatCode(c.code),
      mediaId: c.mediaId,
      variant: c.variant,
      visitorId: c.visitorId.slice(0, 8),
      byteSize: Number(c.byteSize),
      width: c.width,
      height: c.height,
      firstSeenAt: c.firstSeenAt.toISOString(),
      lastUsedAt: c.lastUsedAt.toISOString(),
      downloadCount: downloadsByCopy.get(c.id) ?? 0,
    })),
    eventCount: events.length,
  };
}

export interface TraceEvent {
  id: string;
  context: ShareAccessEvent['context'];
  mediaId: string | null;
  visitorId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  copyCode: string | null;
}

export async function listEvents(ctx: FamilyContext, linkId: string, opts: { limit?: number } = {}): Promise<{
  linkId: string;
  events: TraceEvent[];
}> {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');

  const take = Math.min(200, Math.max(1, opts.limit ?? 100));
  const events = await prisma.shareAccessEvent.findMany({
    where: { shareLinkId: linkId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { copy: { select: { code: true } } },
  });

  return {
    linkId,
    events: events.map((e) => ({
      id: e.id,
      context: e.context,
      mediaId: e.mediaId,
      visitorId: e.visitorId.slice(0, 8),
      ip: e.ip,
      userAgent: e.userAgent,
      createdAt: e.createdAt.toISOString(),
      copyCode: e.copy ? formatCode(e.copy.code) : null,
    })),
  };
}

// ---- 验图：从回流图片里提取水印并追溯 ---------------------------------------

export interface VerifyResult {
  watermarked: boolean;
  code?: string;
  validSignature?: boolean;
  shareLink?: {
    id: string;
    label: string | null;
    revoked: boolean;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  };
  media?: { id: string; itemId: string; originalName: string };
  copy?: { variant: string; firstSeenAt: string; lastUsedAt: string };
  visitorId?: string;
  eventCount?: number;
}

/**
 * 上传一张疑似外流的图片，提取隐形短码并返回出处档案。
 * 只接受本家庭的水印：跨家庭同密钥也只会命中自己的记录。
 */
export async function verifyUploadedImage(
  ctx: FamilyContext,
  filePath: string,
): Promise<VerifyResult> {
  // 延迟引入，避免测试环境以外的路径耦合
  const { extractCodeHexFromFile } = await import('../media/watermark');
  const codeHex = await extractCodeHexFromFile(filePath);
  if (!codeHex) {
    return { watermarked: false };
  }

  const copy = await prisma.watermarkCopy.findUnique({
    where: { code: codeHex },
    include: {
      shareLink: true,
      media: { select: { id: true, itemId: true, originalName: true } },
    },
  });

  if (!copy || copy.shareLink.familyId !== ctx.familyId) {
    return { watermarked: true, code: formatCode(codeHex), validSignature: false };
  }

  const validSignature = signCode(copy.shareLink.id, copy.code) === copy.sig;
  const eventCount = await prisma.shareAccessEvent.count({ where: { copyId: copy.id } });

  return {
    watermarked: true,
    code: formatCode(copy.code),
    validSignature,
    shareLink: {
      id: copy.shareLink.id,
      label: copy.shareLink.label,
      revoked: Boolean(copy.shareLink.revokedAt),
      createdAt: copy.shareLink.createdAt.toISOString(),
      expiresAt: copy.shareLink.expiresAt.toISOString(),
      revokedAt: copy.shareLink.revokedAt?.toISOString() ?? null,
    },
    media: copy.media,
    copy: {
      variant: copy.variant,
      firstSeenAt: copy.firstSeenAt.toISOString(),
      lastUsedAt: copy.lastUsedAt.toISOString(),
    },
    visitorId: copy.visitorId.slice(0, 8),
    eventCount,
  };
}

/** 流式读水印副本（管理端「查看副本」也走它）。 */
export function readCopy(copy: WatermarkCopy, range?: { start: number; end: number }) {
  return readStream(copy.storageKey, range);
}

export async function loadFamilyCopy(ctx: FamilyContext, copyId: string): Promise<WatermarkCopy> {
  const copy = await prisma.watermarkCopy.findFirst({
    where: { id: copyId, shareLink: { familyId: ctx.familyId } },
  });
  if (!copy) throw notFound('水印副本不存在');
  return copy;
}

export function assertImageUpload(mime: string | undefined, size: number): void {
  if (!mime || !/^image\/(png|jpe?g|webp|gif|bmp|tiff?)$/.test(mime)) {
    throw badRequest('请上传 PNG / JPEG / WebP 等图片文件');
  }
  if (size > 30 * 1024 * 1024) throw badRequest('验图图片不能超过 30MB');
}
