import { Router } from 'express';
import fsp from 'node:fs/promises';
import { asyncHandler } from '../http/asyncHandler';
import { currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { uploadSingle } from '../middleware/upload';
import * as watermarkService from '../services/watermarkService';
import * as audit from '../services/auditService';
import { sendStoredFile } from '../http/sendFile';
import { clientMeta } from '../middleware/auth';

/**
 * 分享出处与水印（管理端）：
 *  - 查看某条已分发链接生成了哪些水印副本、各自的访问/下载情况
 *  - 查看访问留痕
 *  - 上传回流图片验出水印发源（哪条链接、哪位访客、哪张原图）
 */
export const watermarksRouter = Router({ mergeParams: true });

watermarksRouter.get(
  '/share-links/:linkId/copies',
  requireFamily('share:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await watermarkService.listCopies(ctx, req.params.linkId!));
  }),
);

watermarksRouter.get(
  '/share-links/:linkId/events',
  requireFamily('share:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await watermarkService.listEvents(ctx, req.params.linkId!, { limit }));
  }),
);

watermarksRouter.get(
  '/copies/:copyId',
  requireFamily('share:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const copy = await watermarkService.loadFamilyCopy(ctx, req.params.copyId!);
    sendStoredFile(req, res, {
      key: copy.storageKey,
      size: Number(copy.byteSize),
      mimeType: 'image/png',
      filename: `watermark-${copy.code}.png`,
    });
  }),
);

watermarksRouter.post(
  '/verify',
  requireFamily('share:manage'),
  writeLimiter,
  uploadSingle,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: '请选择要鉴别的图片' } });
      return;
    }
    watermarkService.assertImageUpload(file.mimetype, file.size);
    try {
      const result = await watermarkService.verifyUploadedImage(ctx, file.path);
      await audit.recordSoft({
        familyId: ctx.familyId,
        actorId: user.id,
        action: 'share.watermark_verify',
        targetType: 'share_link',
        targetId: result.shareLink?.id ?? null,
        diff: { code: result.code ?? null, matched: Boolean(result.shareLink) },
        ...clientMeta(req),
      });
      res.json({ result, verifiedBy: user.id });
    } finally {
      await fsp.rm(file.path, { force: true });
    }
  }),
);
