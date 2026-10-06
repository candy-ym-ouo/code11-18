import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../db';
import { notFound, unauthenticated } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import * as audit from './auditService';
import { activeLinkByToken, recordAccessEvent } from './provenanceService';
import { resolveOrCreateRecipient } from '../middleware/visitor';
import { toItemDto, toShareLinkDto } from '../serializers';
import { itemWithAccess, type FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const WATERMARK_MODES = ['visible+lsb', 'lsb', 'off'] as const;
export type WatermarkMode = (typeof WATERMARK_MODES)[number];

export async function createShareLink(
  userId: string,
  ctx: FamilyContext,
  input: {
    itemIds: string[];
    expiresInDays: number;
    password?: string | null;
    label?: string | null;
    watermarkMode?: WatermarkMode;
  },
  meta: ActorMeta,
) {
  // 只能分享自己有权看到的条目，避免借分享链接绕过可见性
  for (const itemId of input.itemIds) {
    await itemWithAccess(userId, ctx, itemId);
  }

  const token = randomToken(24);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const watermarkMode = input.watermarkMode ?? 'visible+lsb';

  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.shareLink.create({
      data: {
        familyId: ctx.familyId,
        tokenHash: sha256Hex(token),
        passwordHash,
        label: input.label ?? null,
        watermarkMode,
        expiresAt,
        createdBy: userId,
        items: { create: input.itemIds.map((itemId) => ({ itemId })) },
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'share.create',
        targetType: 'share_link',
        targetId: created.id,
        diff: {
          itemCount: input.itemIds.length,
          expiresAt: expiresAt.toISOString(),
          watermarkMode,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return { ...toShareLinkDto(link, token), token };
}

export async function listShareLinks(ctx: FamilyContext) {
  const links = await prisma.shareLink.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { recipients: true, watermarks: true } },
    },
  });
  return links.map((l) => ({
    ...toShareLinkDto(l),
    watermarkMode: l.watermarkMode,
    recipientCount: l._count.recipients,
    watermarkedCopyCount: l._count.watermarks,
  }));
}

export async function revokeShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  if (link.revokedAt) return; // 幂等：重复撤销不报错
  await prisma.$transaction(async (tx) => {
    await tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
    // 撤销时汇总已分发副本数，写进审计：撤销后凭这条记录知道曾经发出去多少份
    const copies = await tx.shareWatermark.count({ where: { shareLinkId: linkId } });
    const recipients = await tx.shareRecipient.count({ where: { shareLinkId: linkId } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.revoke',
        targetType: 'share_link',
        targetId: linkId,
        diff: { distributedCopies: copies, recipients },
        ...meta,
      },
      tx,
    );
  });
}

export interface PublicShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  watermarkMode: string;
  items: ReturnType<typeof toItemDto>[];
}

/**
 * 访客打开分享。
 * 注意 req/res 都要传：密码校验通过后会为该浏览器签发（或复用）访客凭证 Cookie。
 */
export async function viewShareLink(
  token: string,
  password: string | undefined,
  req: { ip?: string | null; header?: (name: string) => string | undefined },
  res: Response,
): Promise<PublicShareView> {
  const link = await activeLinkByToken(token);

  if (link.passwordHash) {
    if (!password) {
      return {
        familyName: link.family.name,
        label: link.label,
        expiresAt: link.expiresAt.toISOString(),
        requiresPassword: true,
        watermarkMode: link.watermarkMode,
        items: [],
      };
    }
    const ok = await verifyPassword(password, link.passwordHash);
    if (!ok) {
      // 留痕：失败的密码尝试也算对外访问痕迹
      await recordAccessEvent({
        link,
        recipientId: null,
        kind: 'denied',
        meta: { ip: req.ip ?? null, userAgent: req.header?.('user-agent') ?? null },
      }).catch(() => undefined);
      throw unauthenticated('访问密码不正确');
    }
  }

  // 密码通过（或无密码）：建立访客身份，后续图片副本都挂在它名下
  const meta = { ip: req.ip ?? null, userAgent: req.header?.('user-agent') ?? null };
  const recipient = await resolveOrCreateRecipient(
    req as Parameters<typeof resolveOrCreateRecipient>[0],
    res,
    { id: link.id, familyId: link.familyId },
    meta,
  );

  const rows = await prisma.item.findMany({
    where: { shareLinks: { some: { shareLinkId: link.id } }, deletedAt: null, status: { not: 'trashed' } },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
    orderBy: { sortAt: 'desc' },
  });

  await prisma.$transaction([
    prisma.shareLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
    }),
    prisma.shareAccessEvent.create({
      data: {
        shareLinkId: link.id,
        familyId: link.familyId,
        recipientId: recipient.id,
        kind: 'page_view',
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    }),
  ]);

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    watermarkMode: link.watermarkMode,
    items: rows.map((r) => toItemDto(r, link.familyId)),
  };
}

/**
 * 访客读媒体：必须证明该媒体属于本链接覆盖的条目。
 * 返回的 link 供 provenanceService 生成水印副本；访客身份在路由层解析。
 */
export async function loadPublicShare(token: string) {
  return activeLinkByToken(token);
}
