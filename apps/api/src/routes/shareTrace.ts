import { Router } from 'express';
import { recipientLabelSchema, verifyWatermarkSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody, validateQuery, queryOf } from '../middleware/validation';
import { z } from 'zod';
import { badRequest } from '../http/errors';
import * as provenance from '../services/provenanceService';
import { uploadSingle } from '../middleware/upload';

export const shareTraceRouter = Router({ mergeParams: true });

const eventQuerySchema = z.object({
  recipientId: z.string().cuid().optional(),
  kind: z.enum(['page_view', 'image_view', 'image_download', 'media_download', 'denied']).optional(),
  limit: z.coerce.number().int().min(1).max(300).optional(),
});

shareTraceRouter.get(
  '/:linkId/overview',
  requireFamily('share:trace'),
  asyncHandler(async (req, res) => {
    res.json({ overview: await provenance.traceOverview(familyCtx(req), req.params.linkId!) });
  }),
);

shareTraceRouter.get(
  '/:linkId/recipients',
  requireFamily('share:trace'),
  asyncHandler(async (req, res) => {
    res.json({ recipients: await provenance.listRecipients(familyCtx(req), req.params.linkId!) });
  }),
);

shareTraceRouter.get(
  '/:linkId/events',
  requireFamily('share:trace'),
  validateQuery(eventQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<z.infer<typeof eventQuerySchema>>(req);
    res.json({
      events: await provenance.listEvents(familyCtx(req), req.params.linkId!, {
        recipientId: q.recipientId,
        kind: q.kind,
        limit: q.limit,
      }),
    });
  }),
);

shareTraceRouter.patch(
  '/:linkId/recipients/:recipientId',
  requireFamily('share:trace'),
  writeLimiter,
  validateBody(recipientLabelSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await provenance.updateRecipient(
      user.id,
      familyCtx(req),
      req.params.linkId!,
      req.params.recipientId!,
      { label: req.body.label ?? undefined, blocked: req.body.blocked },
      clientMeta(req),
    );
    res.status(204).end();
  }),
);

/** 凭可见短码验证出处（可限定在某条链接内查）。 */
shareTraceRouter.post(
  '/:linkId/verify',
  requireFamily('share:trace'),
  writeLimiter,
  validateBody(verifyWatermarkSchema),
  asyncHandler(async (req, res) => {
    if (!req.body.wmCode) throw badRequest('请提供水印码');
    const hit = await provenance.verifyByCode(familyCtx(req), req.params.linkId!, req.body.wmCode);
    res.json({ trace: hit });
  }),
);

/** 上传疑似外传的图片：提取盲水印（退路读 PNG tEXt），反查出处。 */
shareTraceRouter.post(
  '/:linkId/verify-image',
  requireFamily('share:trace'),
  writeLimiter,
  uploadSingle,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('请上传图片');
    if (!req.file.mimetype.startsWith('image/') && !/\.(png|jpe?g|webp)$/i.test(req.file.originalname)) {
      throw badRequest('只支持图片文件');
    }
    const buf = await import('node:fs/promises').then((fsp) => fsp.readFile(req.file!.path));
    await import('node:fs/promises').then((fsp) => fsp.rm(req.file!.path, { force: true }));
    const hit = await provenance.verifyByImage(familyCtx(req), req.params.linkId!, buf);
    res.json({ trace: hit });
  }),
);

/** 家庭级反查：不限定链接（owner/admin），用于「捡到一张图」的全局溯源。 */
export const familyTraceRouter = Router({ mergeParams: true });

familyTraceRouter.post(
  '/verify-image',
  requireFamily('share:trace'),
  writeLimiter,
  uploadSingle,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('请上传图片');
    const fsp = await import('node:fs/promises');
    const buf = await fsp.readFile(req.file.path);
    await fsp.rm(req.file.path, { force: true });
    const hit = await provenance.verifyByImage(familyCtx(req), null, buf);
    res.json({ trace: hit });
  }),
);

familyTraceRouter.post(
  '/verify-code',
  requireFamily('share:trace'),
  writeLimiter,
  validateBody(verifyWatermarkSchema),
  asyncHandler(async (req, res) => {
    if (!req.body.wmCode) throw badRequest('请提供水印码');
    const hit = await provenance.verifyByCode(familyCtx(req), null, req.body.wmCode);
    res.json({ trace: hit });
  }),
);
