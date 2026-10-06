import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import type { WatermarkVerifyResult } from '../../api/types';

/**
 * 水印鉴别：拿到一张疑似外流的图片时上传，服务端从像素 LSB 中提取隐形编号，
 * 验签后回链到「哪条分享、哪位访客、哪张原图、何时分发、访问过多少次」。
 */
export function WatermarkVerifyPanel({ fid }: { fid: string }) {
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<WatermarkVerifyResult | null>(null);

  const verify = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<{ result: WatermarkVerifyResult }>(`/families/${fid}/watermarks/verify`, form);
    },
    onSuccess: (data) => setResult(data.result),
    onError: (err) => push(err instanceof ApiError ? err.message : '鉴别失败', 'error'),
  });

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        如果带水印的图片在预期之外的地方出现，把它上传到这里：系统会读取图片里肉眼不可见的出处编号，
        定位它是通过哪条分享链接、分发给哪位访客的副本——即使链接早已撤销也能追溯。
      </p>
      <div className="row">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) verify.mutate(file);
            e.target.value = '';
          }}
        />
        <Button variant="primary" loading={verify.isPending} onClick={() => inputRef.current?.click()}>
          上传图片鉴别出处
        </Button>
      </div>

      {result ? (
        !result.watermarked ? (
          <div className="notice notice--muted">
            <strong>未检出本系统水印。</strong>
            这张图里没有可识别的隐形编号，可能来自其他渠道，或经过了裁剪、重压缩、截屏翻拍等破坏。
          </div>
        ) : !result.shareLink || result.validSignature === false ? (
          <div className="notice notice--warn">
            <strong>检出编号 {result.code}</strong>，但它不属于本家庭或签名校验未通过，可能是伪造或篡改过的图。
          </div>
        ) : (
          <div className="notice notice--success">
            <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 6 }}>
              <Tag tone="success">出处已确认</Tag>
              <code style={{ fontSize: 15 }}>{result.code}</code>
              {result.shareLink.revoked ? <Tag tone="warn">链接已撤销</Tag> : <Tag>链接仍有效</Tag>}
            </div>
            <ul className="trace-list">
              <li>
                来源分享：<strong>{result.shareLink.label || '未命名分享'}</strong>
              </li>
              <li>分发给访客：<code>{result.visitorId}…</code>（该设备首次打开时获得这份专属副本）</li>
              <li>对应原图：{result.media?.originalName}（{result.copy?.variant === 'full' ? '大图副本' : '缩略图副本'}）</li>
              <li>副本生成时间：{result.copy ? formatDateTime(result.copy.firstSeenAt) : '—'}</li>
              <li>分享创建：{formatDateTime(result.shareLink.createdAt)}，原有效期至 {formatDateTime(result.shareLink.expiresAt)}</li>
              {result.shareLink.revokedAt ? <li>链接撤销时间：{formatDateTime(result.shareLink.revokedAt)}</li> : null}
              <li>该副本累计被查看 / 下载 <strong>{result.eventCount ?? 0}</strong> 次</li>
            </ul>
          </div>
        )
      ) : null}
    </div>
  );
}
