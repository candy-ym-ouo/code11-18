import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import { publicLimiter } from '../middleware/rateLimit';
import * as shareService from '../services/shareService';
import * as provenance from '../services/provenanceService';
import { resolveOrCreateRecipient, resolveRecipient } from '../middleware/visitor';
import { mediaFileTarget } from '../services/mediaService';
import { sendStoredFile } from '../http/sendFile';
import { notFound, forbidden } from '../http/errors';
import { statObject } from '../storage/local';

export const publicRouter = Router();

publicRouter.post(
  '/share/:token',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    const share = await shareService.viewShareLink(req.params.token!, password, req, res);
    res.json({ share });
  }),
);

/**
 * 访客媒体：
 * - 图片的 raw/thumb 一律改为「逐访客水印副本」（明水印 + 盲水印 + 出处 tEXt）；
 * - download 对图片同样给带水印的 PNG（下载留痕，撤销后凭副本反查）；
 * - 音频/PDF 走原始文件，但逐条记录访问与下载事件。
 */
publicRouter.get(
  '/share/:token/media/:mediaId/:variant',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const variant = req.params.variant!;
    if (!['raw', 'thumb', 'waveform', 'download'].includes(variant)) throw notFound('媒体不存在');

    const link = await shareService.loadPublicShare(req.params.token!);
    const media = await provenance.linkMedia(link, req.params.mediaId!);
    const meta = { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };

    const visitor =
      (await resolveRecipient(req, { id: link.id, familyId: link.familyId }, meta).catch(() => null)) ?? null;
    if (visitor?.blockedAt) {
      await provenance
        .recordAccessEvent({ link, recipientId: visitor.id, mediaId: media.id, kind: 'denied', meta })
        .catch(() => undefined);
      throw forbidden('该分享的访问已被主人停用');
    }

    // ---------- 图片 ----------
    if (media.kind === 'image' && (variant === 'raw' || variant === 'thumb' || variant === 'download')) {
      // 没带访客 Cookie（直接把图片链接发给别人、或 Cookie 被清）时，当场补建访客身份，
      // 保证每次外发都能追到一个具体接收者。
      const recipient =
        visitor ??
        (await resolveOrCreateRecipient(req, res, { id: link.id, familyId: link.familyId }, meta));

      // 显式关闭水印：下发原图/缩略图，但访问与下载逐条留痕（仍可追溯「谁在何时访问过」）
      if (link.watermarkMode === 'off') {
        const target = await mediaFileTarget(media, variant === 'raw' ? 'raw' : variant === 'thumb' ? 'thumb' : 'download');
        await provenance.recordAccessEvent({
          link,
          recipientId: recipient.id,
          mediaId: media.id,
          kind: variant === 'download' ? 'image_download' : 'image_view',
          byteSize: BigInt(target.size),
          meta,
        });
        sendStoredFile(req, res, {
          key: target.key,
          size: target.size,
          mimeType: variant === 'thumb' ? 'image/webp' : target.mimeType,
          filename: media.originalName,
          download: variant === 'download',
        });
        return;
      }

      // 默认：逐访客水印副本（明水印 + 盲水印 + 出处 tEXt）
      const { wm } = await provenance.watermarkedImage(link, recipient, media);
      const size = Number(wm.byteSize);
      await provenance.recordAccessEvent({
        link,
        recipientId: recipient.id,
        watermarkId: wm.id,
        mediaId: media.id,
        kind: variant === 'download' ? 'image_download' : 'image_view',
        byteSize: wm.byteSize,
        meta,
      });
      sendStoredFile(req, res, {
        key: wm.storageKey,
        size,
        mimeType: 'image/png',
        filename: downloadName(media.originalName),
        download: variant === 'download',
      });
      return;
    }

    // ---------- 波形：体积小、不携带原始内容，直接返回但留痕 ----------
    if (variant === 'waveform') {
      const target = await mediaFileTarget(media, 'waveform');
      await provenance
        .recordAccessEvent({
          link,
          recipientId: visitor?.id ?? null,
          mediaId: media.id,
          kind: 'media_download',
          byteSize: BigInt(target.size),
          meta,
        })
        .catch(() => undefined);
      res.setHeader('Content-Type', 'application/json');
      sendStoredFile(req, res, {
        key: target.key,
        size: target.size,
        mimeType: 'application/json',
        filename: `${media.id}.waveform.json`,
      });
      return;
    }

    // ---------- 音频 / 文档：原始文件 + 留痕（盲水印不适用，仅记录访问事实） ----------
    const target = await mediaFileTarget(media, variant === 'download' ? 'download' : 'raw');
    const stat = await statObject(target.key);
    await provenance
      .recordAccessEvent({
        link,
        recipientId: visitor?.id ?? null,
        mediaId: media.id,
        kind: 'media_download',
        byteSize: stat ? BigInt(stat.size) : null,
        meta,
      })
      .catch(() => undefined);
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: media.originalName,
      download: variant === 'download',
    });
  }),
);

function downloadName(original: string): string {
  const base = original.replace(/\.[^.]+$/, '');
  return `${base || 'image'}-出处水印.png`;
}
