import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { randomToken, sha256Hex } from '../utils/crypto';
import { prisma } from '../db';
import type { ShareRecipient } from '@prisma/client';

/**
 * 对外访客标识：httpOnly Cookie hl_share_v=<recipientId>.<hmac>。
 * - 每条分享链接的访客各自独立（Cookie 内按 linkId 存键值），访客换链接无法关联，降低跨链接追踪；
 * - 这里用「单值 + 签名」的简单形态：一个浏览器在同一时刻只携带最近访问的一个链接的访客凭证。
 *   页面本身带 token，token→link 是确定的，因此服务端以 (link, 最近访客) 记账，
 *   并在媒体请求上用 token 找到 link、用签名找到该 link 下的同一访客即可。
 *
 * 为支持「同时打开多个分享」，Cookie 值实际是 base64url(JSON({[linkId]: {id, s}})) 的紧凑映射，
 * 大小控制在 4KB 以内（最多约 40 条链接）。
 */

export const VISITOR_COOKIE = 'hl_share_v';

function sign(recipientId: string): string {
  return createHmac('sha256', config.JWT_SECRET).update('heirloom-visitor/v1').update(recipientId).digest('base64url');
}

interface CookieEntry {
  id: string;
  s: string;
}
type CookieMap = Record<string, CookieEntry>;

export function readVisitorCookie(req: Request): CookieMap {
  const raw = req.cookies?.[VISITOR_COOKIE];
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CookieMap;
    const clean: CookieMap = {};
    for (const [linkId, entry] of Object.entries(parsed)) {
      if (
        typeof entry?.id === 'string' &&
        typeof entry.s === 'string' &&
        /^[a-zA-Z0-9_-]+$/.test(linkId) &&
        /^[a-zA-Z0-9_-]+$/.test(entry.id)
      ) {
        clean[linkId] = { id: entry.id, s: entry.s };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeVisitorCookie(res: Response, map: CookieMap): void {
  // 只保留最近的若干条，避免 Cookie 膨胀
  const entries = Object.entries(map).slice(-40);
  const value = Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64url');
  res.cookie(VISITOR_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    path: '/',
    maxAge: config.SHARE_VISITOR_TTL_DAYS * 86_400_000,
  });
}

function validSignature(entry: CookieEntry): boolean {
  try {
    return timingSafeEqual(Buffer.from(sign(entry.id)), Buffer.from(entry.s));
  } catch {
    return false;
  }
}

/**
 * 解析/创建「当前 token 对应链接」的访客。
 * 必须在 loadLink（token 有效、未撤销、未过期）通过之后调用。
 */
export async function resolveOrCreateRecipient(
  req: Request,
  res: Response,
  link: { id: string; familyId: string },
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<ShareRecipient> {
  const map = readVisitorCookie(req);
  const existing = map[link.id];
  if (existing && validSignature(existing)) {
    const recipient = await prisma.shareRecipient.findUnique({ where: { id: existing.id } });
    if (recipient && recipient.shareLinkId === link.id && recipient.familyId === link.familyId && !recipient.blockedAt) {
      await prisma.shareRecipient.update({
        where: { id: recipient.id },
        data: { lastSeenAt: new Date(), lastIp: meta.ip ?? recipient.lastIp, lastUserAgent: meta.userAgent ?? recipient.lastUserAgent },
      });
      return recipient;
    }
  }

  const rawId = cryptoRandomId();
  const recipient = await prisma.shareRecipient.create({
    data: {
      shareLinkId: link.id,
      familyId: link.familyId,
      cookieHash: sha256Hex(rawId),
      firstIp: meta.ip ?? null,
      lastIp: meta.ip ?? null,
      firstUserAgent: meta.userAgent ?? null,
      lastUserAgent: meta.userAgent ?? null,
    },
  });
  map[link.id] = { id: recipient.id, s: sign(recipient.id) };
  writeVisitorCookie(res, map);
  return recipient;
}

/**
 * 只解析（媒体 GET 等场景）：访客不存在时返回 null，调用方决定是否放行
 * （媒体接口在访客被封/缺失时仍允许请求，但按匿名事件留痕）。
 */
export async function resolveRecipient(
  req: Request,
  link: { id: string; familyId: string },
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<ShareRecipient | null> {
  const entry = readVisitorCookie(req)[link.id];
  if (!entry || !validSignature(entry)) return null;
  const recipient = await prisma.shareRecipient.findUnique({ where: { id: entry.id } });
  if (!recipient || recipient.shareLinkId !== link.id || recipient.familyId !== link.familyId) return null;
  if (recipient.blockedAt) return recipient; // 调用方可见 blockedAt 并拒绝
  await prisma.shareRecipient.update({
    where: { id: recipient.id },
    data: { lastSeenAt: new Date(), lastIp: meta.ip ?? recipient.lastIp, lastUserAgent: meta.userAgent ?? recipient.lastUserAgent },
  });
  return recipient;
}

function cryptoRandomId(): string {
  return randomToken(18);
}
