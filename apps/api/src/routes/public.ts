import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import { publicLimiter } from '../middleware/rateLimit';
import { clientMeta } from '../middleware/auth';
import { attachVisitor } from '../middleware/visitor';
import * as shareService from '../services/shareService';
import * as watermarkService from '../services/watermarkService';
import { mediaFileTarget } from '../services/mediaService';
import { sendStoredFile } from '../http/sendFile';
import { notFound } from '../http/errors';

export const publicRouter = Router();

publicRouter.use(attachVisitor);

publicRouter.post(
  '/share/:token',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    const share = await shareService.viewShareLink(
      req.params.token!,
      password,
      req.visitorId ? { id: req.visitorId, meta: clientMeta(req) } : undefined,
    );
    res.json({ share });
  }),
);

publicRouter.get(
  '/share/:token/media/:mediaId/:variant',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const variant = req.params.variant!;
    if (!['raw', 'thumb', 'waveform', 'download'].includes(variant)) throw notFound('媒体不存在');
    const visitor = { id: req.visitorId!, meta: clientMeta(req) };

    // 图片对外一律发放带水印副本（大图 / 缩略图各自一份），访问与下载均留痕
    if (variant === 'raw' || variant === 'download' || variant === 'thumb') {
      const { link, media } = await watermarkService.loadPublicImage(req.params.token!, req.params.mediaId!);
      const served = await watermarkService.servePublicImage({
        link,
        media,
        visitorId: visitor.id,
        variant: variant === 'thumb' ? 'thumb' : 'full',
        context: variant === 'download' ? 'download' : 'inline',
        meta: visitor.meta,
      });
      sendStoredFile(req, res, {
        key: served.key,
        size: served.size,
        mimeType: served.mimeType,
        filename: served.filename,
        download: variant === 'download',
        noStore: true,
      });
      return;
    }

    // 音频波形 / 音频与文档下载：无法嵌像素水印，但同样留痕
    const media = await shareService.assertPublicMedia(req.params.token!, req.params.mediaId!);
    const target = await mediaFileTarget(media, variant as 'waveform' | 'download');
    await shareService.recordPublicFileAccess(
      req.params.token!,
      media.id,
      visitor,
      variant === 'download' ? 'download' : 'inline',
    );
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: media.originalName,
      download: variant === 'download',
      noStore: true,
    });
  }),
);
