import type { NextFunction, Request, Response } from 'express';
import { randomToken } from '../utils/crypto';
import { config } from '../config';

export const VISITOR_COOKIE = 'hl_visitor';

/**
 * 公开分享没有登录身份，用长期 HttpOnly cookie 给每个访客分配一个随机 ID。
 * 同一位访客在同一条链接下拿到同一批水印副本——泄露后可以定位到「分发给了谁
 * 的设备」，而不是每次访问都生成新副本。
 */
export function visitorId(req: Request, res: Response): string {
  const existing = req.cookies?.[VISITOR_COOKIE];
  if (typeof existing === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;

  const id = randomToken(24);
  res.cookie(VISITOR_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: 365 * 86_400_000,
    path: '/',
  });
  return id;
}

export function attachVisitor(req: Request, res: Response, next: NextFunction): void {
  req.visitorId = visitorId(req, res);
  next();
}
