import { createHash } from 'node:crypto';
import type { ItemMedia, ShareLink, ShareRecipient } from '@prisma/client';
import { prisma } from '../db';
import { notFound, AppError } from '../http/errors';
import { sha256Hex } from '../utils/crypto';
import {
  codeToPayload,
  parseVerifiedCode,
  payloadToCode,
  randomWatermarkPayload,
} from '../utils/wmCode';
import { absOf, putBuffer, statObject, watermarkKey, remove } from '../storage/local';
import { decodeFrameForExtract, readPngText, renderWatermarkedImage } from '../media/watermarkImage';
import { extractLsb } from '../media/watermark';
import { config } from '../config';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';

export interface VisitorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 已生效（未撤销、未过期）的对外链接；否则按 404 处理，避免泄露链接存在性。 */
export async function activeLinkByToken(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true } } },
  });
  if (!link || link.revokedAt || link.expiresAt.getTime() < Date.now()) {
    throw notFound('分享链接不存在、已撤销或已过期');
  }
  return link;
}

/** 访客读取的媒体必须属于本链接覆盖的条目。 */
export async function linkMedia(link: ShareLink, mediaId: string): Promise<ItemMedia> {
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, deletedAt: null, item: { shareLinks: { some: { shareLinkId: link.id } } } },
  });
  if (!media) throw notFound('媒体不存在');
  return media;
}

function sourceKeyOf(media: ItemMedia): string | null {
  // 水印以「在线大图」为底（已经过 EXIF 纠正与剥离）；没有大图时退回原图
  return media.largeKey ?? media.storageKey;
}

/**
 * 取（必要时现场生成）该访客专属的水印图片副本。
 * 同一「访客 × 媒体」只有一份；并发首次请求时败者复用胜者产物。
 */
export async function watermarkedImage(
  link: ShareLink & { family: { id: string; name: string } },
  recipient: ShareRecipient,
  media: ItemMedia,
): Promise<{ wm: { id: string; storageKey: string; sha256: string; byteSize: bigint; wmCode: string; filePurgedAt: Date | null } }> {
  const existing = await prisma.shareWatermark.findUnique({
    where: { recipientId_mediaId: { recipientId: recipient.id, mediaId: media.id } },
  });
  if (existing) {
    if (existing.filePurgedAt || !(await statObject(existing.storageKey))) {
      // 文件被清理过的极端情况：重建一份（沿用原 wmCode，隐写码不变，证据链不断）
      return { wm: await rebuild(link, recipient, media, existing) };
    }
    return { wm: existing };
  }

  const payload = randomWatermarkPayload();
  const wmCode = payloadToCode(payload);
  const srcKey = sourceKeyOf(media);
  if (!srcKey) throw notFound('原图不存在');

  const rendered = await renderWatermarkedImage({
    sourcePath: absOf(srcKey),
    payloadContent: payload,
    visibleText: `${link.family.name} · 家庭档案分享`,
    codeLine: `出处验证码 ${wmCode}`,
    visible: link.watermarkMode !== 'lsb',
  });
  const sha = sha256Buffer(rendered.data);
  const key = watermarkKey(link.familyId, wmCode);
  await putBuffer(key, rendered.data);

  try {
    const created = await prisma.shareWatermark.create({
      data: {
        shareLinkId: link.id,
        recipientId: recipient.id,
        familyId: link.familyId,
        mediaId: media.id,
        wmCode,
        storageKey: key,
        sha256: sha,
        byteSize: BigInt(rendered.data.length),
        width: rendered.width,
        height: rendered.height,
      },
    });
    return { wm: { id: created.id, storageKey: key, sha256: sha, byteSize: BigInt(rendered.data.length), wmCode, filePurgedAt: null } };
  } catch (err) {
    // 并发下唯一约束 (recipientId, mediaId) 冲突：败者复用已落库的那一份
    if (isUniqueViolation(err)) {
      const winner = await prisma.shareWatermark.findUniqueOrThrow({
        where: { recipientId_mediaId: { recipientId: recipient.id, mediaId: media.id } },
      });
      await remove(key);
      return { wm: winner };
    }
    throw err;
  }
}

async function rebuild(
  link: ShareLink & { family: { id: string; name: string } },
  recipient: ShareRecipient,
  media: ItemMedia,
  prev: { id: string; wmCode: string },
) {
  const payload = codeToPayload(prev.wmCode);
  if (!payload) throw notFound('水印副本已失效');
  const srcKey = sourceKeyOf(media);
  if (!srcKey) throw notFound('原图不存在');
  const rendered = await renderWatermarkedImage({
    sourcePath: absOf(srcKey),
    payloadContent: payload,
    visibleText: `${link.family.name} · 家庭档案分享`,
    codeLine: `出处验证码 ${prev.wmCode}`,
    visible: link.watermarkMode !== 'lsb',
  });
  const sha = sha256Buffer(rendered.data);
  const key = watermarkKey(link.familyId, prev.wmCode);
  await putBuffer(key, rendered.data);
  const updated = await prisma.shareWatermark.update({
    where: { id: prev.id },
    data: { storageKey: key, sha256: sha, byteSize: BigInt(rendered.data.length), width: rendered.width, height: rendered.height, filePurgedAt: null },
  });
  return {
    id: updated.id,
    storageKey: key,
    sha256: sha,
    byteSize: BigInt(rendered.data.length),
    wmCode: prev.wmCode,
    filePurgedAt: null as Date | null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/** 记一条对外访问事件。媒体事件同时累加副本计数。 */
export async function recordAccessEvent(input: {
  link: ShareLink;
  recipientId: string | null;
  watermarkId?: string | null;
  mediaId?: string | null;
  kind: 'page_view' | 'image_view' | 'image_download' | 'media_download' | 'denied';
  byteSize?: bigint | null;
  meta: VisitorMeta;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.shareAccessEvent.create({
      data: {
        shareLinkId: input.link.id,
        familyId: input.link.familyId,
        recipientId: input.recipientId,
        watermarkId: input.watermarkId ?? null,
        mediaId: input.mediaId ?? null,
        kind: input.kind,
        ip: input.meta.ip ?? null,
        userAgent: input.meta.userAgent ?? null,
        byteSize: input.byteSize ?? null,
      },
    });
    if (input.kind === 'image_view' && input.watermarkId) {
      await tx.shareWatermark.update({
        where: { id: input.watermarkId },
        data: { viewCount: { increment: 1 }, lastAccessAt: new Date() },
      });
    }
    if (input.kind === 'image_download' && input.watermarkId) {
      await tx.shareWatermark.update({
        where: { id: input.watermarkId },
        data: { downloadCount: { increment: 1 }, lastAccessAt: new Date() },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 管理端：链接溯源总览、访客明细、事件明细、停用/备注访客
// ---------------------------------------------------------------------------

async function requireLinkInFamily(ctx: FamilyContext, linkId: string) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  return link;
}

export async function traceOverview(ctx: FamilyContext, linkId: string) {
  const link = await requireLinkInFamily(ctx, linkId);
  const [recipients, watermarks, events, distinctImages, downloads] = await Promise.all([
    prisma.shareRecipient.count({ where: { shareLinkId: linkId } }),
    prisma.shareWatermark.count({ where: { shareLinkId: linkId } }),
    prisma.shareAccessEvent.count({ where: { shareLinkId: linkId, kind: { not: 'denied' } } }),
    prisma.shareWatermark.findMany({
      where: { shareLinkId: linkId },
      select: { mediaId: true },
      distinct: ['mediaId'],
    }),
    prisma.shareAccessEvent.count({ where: { shareLinkId: linkId, kind: { in: ['image_download', 'media_download'] } } }),
  ]);
  return {
    linkId,
    label: link.label,
    watermarkMode: link.watermarkMode,
    status: link.revokedAt ? 'revoked' : link.expiresAt.getTime() < Date.now() ? 'expired' : 'active',
    expiresAt: link.expiresAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    recipients,
    watermarkedCopies: watermarks,
    trackedImages: distinctImages.length,
    events,
    downloads,
  };
}

export async function listRecipients(ctx: FamilyContext, linkId: string) {
  await requireLinkInFamily(ctx, linkId);
  const rows = await prisma.shareRecipient.findMany({
    where: { shareLinkId: linkId },
    orderBy: { firstSeenAt: 'desc' },
    take: 200,
    include: {
      _count: { select: { watermarks: true, events: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    blocked: Boolean(r.blockedAt),
    firstIp: r.firstIp,
    lastIp: r.lastIp,
    firstUserAgent: r.firstUserAgent,
    lastUserAgent: r.lastUserAgent,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    watermarkCount: r._count.watermarks,
    eventCount: r._count.events,
  }));
}

export async function listEvents(
  ctx: FamilyContext,
  linkId: string,
  filter: { recipientId?: string; kind?: string; limit?: number },
) {
  await requireLinkInFamily(ctx, linkId);
  const rows = await prisma.shareAccessEvent.findMany({
    where: {
      shareLinkId: linkId,
      recipientId: filter.recipientId ?? undefined,
      kind: filter.kind ?? undefined,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 100, 300),
    include: { watermark: { select: { wmCode: true, mediaId: true } } },
  });
  return rows.map((e) => ({
    id: e.id,
    kind: e.kind,
    recipientId: e.recipientId,
    mediaId: e.mediaId,
    wmCode: e.watermark?.wmCode ?? null,
    ip: e.ip,
    userAgent: e.userAgent,
    byteSize: e.byteSize !== null ? Number(e.byteSize) : null,
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function updateRecipient(
  actorId: string,
  ctx: FamilyContext,
  linkId: string,
  recipientId: string,
  input: { label?: string | null; blocked?: boolean },
  meta: VisitorMeta,
) {
  const link = await requireLinkInFamily(ctx, linkId);
  const recipient = await prisma.shareRecipient.findFirst({ where: { id: recipientId, shareLinkId: linkId } });
  if (!recipient) throw notFound('访客不存在');

  const blockedAt = input.blocked === undefined ? recipient.blockedAt : input.blocked ? new Date() : null;
  await prisma.$transaction(async (tx) => {
    await tx.shareRecipient.update({ where: { id: recipientId }, data: { label: input.label === undefined ? undefined : input.label, blockedAt } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.recipient.update',
        targetType: 'share_recipient',
        targetId: recipientId,
        diff: { linkId, blocked: Boolean(blockedAt), label: input.label ?? null },
        ...meta,
      },
      tx,
    );
  });
  void link;
}

// ---------------------------------------------------------------------------
// 验证：抄录短码 / 上传疑似泄露图片，反查到出处
// ---------------------------------------------------------------------------

interface TraceHit {
  valid: boolean;
  wmCode: string | null;
  source: 'code' | 'lsb' | 'png-text';
  watermark: {
    id: string;
    linkId: string;
    mediaId: string;
    recipientId: string;
    createdAt: string;
    viewCount: number;
    downloadCount: number;
    lastAccessAt: string | null;
    sha256: string;
  } | null;
  link: { id: string; label: string | null; revokedAt: string | null; expiresAt: string } | null;
  recipient: { id: string; label: string | null; firstIp: string | null; lastIp: string | null; firstSeenAt: string } | null;
  events: { kind: string; ip: string | null; createdAt: string; byteSize: number | null }[];
}

function emptyHit(source: TraceHit['source'], wmCode: string | null, valid: boolean): TraceHit {
  return { valid, wmCode, source, watermark: null, link: null, recipient: null, events: [] };
}

async function traceByCode(linkId: string | null, code: string): Promise<TraceHit> {
  const codeNorm = code.trim().toUpperCase();
  const payload = codeToPayload(codeNorm);
  if (!payload) return emptyHit('code', codeNorm, false);

  const wm = await prisma.shareWatermark.findFirst({
    where: { wmCode: codeNorm, ...(linkId ? { shareLinkId: linkId } : {}) },
  });
  const challengeOk = parseVerifiedCode(codeNorm) !== null;
  if (!wm) {
    return { ...emptyHit('code', codeNorm, challengeOk), ...{} };
  }
  return hydrateHit('code', wm, challengeOk);
}

async function hydrateHit(
  source: TraceHit['source'],
  wm: { id: string; shareLinkId: string; recipientId: string; mediaId: string; wmCode: string; createdAt: Date; viewCount: number; downloadCount: number; lastAccessAt: Date | null; sha256: string },
  valid: boolean,
): Promise<TraceHit> {
  const [link, recipient, events] = await Promise.all([
    prisma.shareLink.findUnique({ where: { id: wm.shareLinkId } }),
    prisma.shareRecipient.findUnique({ where: { id: wm.recipientId } }),
    prisma.shareAccessEvent.findMany({
      where: { watermarkId: wm.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  return {
    valid,
    wmCode: wm.wmCode,
    source,
    watermark: {
      id: wm.id,
      linkId: wm.shareLinkId,
      mediaId: wm.mediaId,
      recipientId: wm.recipientId,
      createdAt: wm.createdAt.toISOString(),
      viewCount: wm.viewCount,
      downloadCount: wm.downloadCount,
      lastAccessAt: wm.lastAccessAt?.toISOString() ?? null,
      sha256: wm.sha256,
    },
    link: link
      ? { id: link.id, label: link.label, revokedAt: link.revokedAt?.toISOString() ?? null, expiresAt: link.expiresAt.toISOString() }
      : null,
    recipient: recipient
      ? {
          id: recipient.id,
          label: recipient.label,
          firstIp: recipient.firstIp,
          lastIp: recipient.lastIp,
          firstSeenAt: recipient.firstSeenAt.toISOString(),
        }
      : null,
    events: events.map((e) => ({
      kind: e.kind,
      ip: e.ip,
      createdAt: e.createdAt.toISOString(),
      byteSize: e.byteSize !== null ? Number(e.byteSize) : null,
    })),
  };
}

export async function verifyByCode(ctx: FamilyContext | null, linkId: string | null, code: string): Promise<TraceHit> {
  const hit = await traceByCode(linkId, code);
  // 家庭维度校验：家庭管理员只能追本家庭的副本
  if (ctx && hit.watermark && hit.link && !(await prisma.shareLink.count({ where: { id: hit.link.id, familyId: ctx.familyId } }))) {
    throw new AppError('FORBIDDEN', '该水印不属于当前家庭空间');
  }
  return hit;
}

/** 从一张疑似外传的图片提取水印：先盲水印，再退回 PNG tEXt 文本。 */
export async function verifyByImage(
  ctx: FamilyContext | null,
  linkId: string | null,
  imageBuffer: Buffer,
): Promise<TraceHit> {
  let decoded: { frame: Buffer; stride: 3 | 4; width: number; height: number };
  try {
    decoded = await decodeFrameForExtract(imageBuffer);
  } catch {
    return emptyHit('lsb', null, false);
  }

  const content = extractLsb(decoded.frame, decoded.stride, decoded.width, decoded.height);
  if (content) {
    const code = payloadToCode(Buffer.from(content));
    const wm = await prisma.shareWatermark.findFirst({
      where: { wmCode: code, ...(linkId ? { shareLinkId: linkId } : {}) },
    });
    if (wm) {
      const hit = await hydrateHit('lsb', wm, parseVerifiedCode(code) !== null);
      if (ctx && hit.link && !(await prisma.shareLink.count({ where: { id: hit.link.id, familyId: ctx.familyId } }))) {
        throw new AppError('FORBIDDEN', '该水印不属于当前家庭空间');
      }
      return hit;
    }
  }

  // 退路：PNG tEXt 里的出处文本
  const texts = readPngText(imageBuffer);
  const m = texts.Watermark?.match(/([0-9A-Z]{13})/);
  if (m) return verifyByCode(ctx, linkId, m[1]!).then((h) => ({ ...h, source: 'png-text' as const }));

  return emptyHit('lsb', null, false);
}

// ---------------------------------------------------------------------------
// 清理：撤销/过期链接的水印文件到期删除（记录保留）
// ---------------------------------------------------------------------------

export async function purgeStaleWatermarks(): Promise<{ purgedFiles: number; links: number }> {
  const cutoff = new Date(Date.now() - config.WATERMARK_RETENTION_DAYS * 86_400_000);
  const staleLinks = await prisma.shareLink.findMany({
    where: {
      OR: [{ revokedAt: { not: null, lt: cutoff } }, { expiresAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: 1000,
  });
  let purgedFiles = 0;
  for (const link of staleLinks) {
    const rows = await prisma.shareWatermark.findMany({
      where: { shareLinkId: link.id, filePurgedAt: null },
      take: 500,
    });
    for (const wm of rows) {
      await remove(wm.storageKey).catch(() => undefined);
      await prisma.shareWatermark.update({ where: { id: wm.id }, data: { filePurgedAt: new Date() } });
      purgedFiles += 1;
    }
  }
  return { purgedFiles, links: staleLinks.length };
}
