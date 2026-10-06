import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button, Modal, Spinner, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { getAccessToken } from '../../api/client';
import type { ShareTrace, ShareTraceEvent } from '../../api/types';

/**
 * 某条分享链接的「分发追溯」：
 *  - 每位访客首次打开时生成一批带隐形短码的水印副本（撤销后仍保留）
 *  - 所有查看 / 下载动作按时间留痕（IP、UA、场景、副本短码）
 */
export function ShareTraceDialog({
  open,
  fid,
  linkId,
  linkLabel,
  onClose,
}: {
  open: boolean;
  fid: string;
  linkId: string;
  linkLabel: string;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [showEvents, setShowEvents] = useState(false);

  const trace = useQuery({
    queryKey: ['watermark-copies', fid, linkId],
    queryFn: () => api<ShareTrace>(`/families/${fid}/watermarks/share-links/${linkId}/copies`),
    enabled: open,
  });

  const events = useQuery({
    queryKey: ['watermark-events', fid, linkId],
    queryFn: () =>
      api<{ linkId: string; events: ShareTraceEvent[] }>(
        `/families/${fid}/watermarks/share-links/${linkId}/events?limit=100`,
      ),
    enabled: open && showEvents,
  });

  const previewCopy = (copyId: string) => {
    // 管理端预览带登录 token，走新窗口直接看这份发出去的图
    const token = getAccessToken();
    const url = `/api/v1/families/${fid}/watermarks/copies/${copyId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    window.open(url, '_blank', 'noopener');
  };

  const copyCode = (code: string) => {
    void navigator.clipboard.writeText(code);
    push(`副本编号 ${code} 已复制`, 'success');
  };

  return (
    <Modal open={open} title={`分发追溯 · ${linkLabel}`} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {trace.isLoading ? (
        <Spinner label="正在统计已分发副本…" />
      ) : trace.isError ? (
        <p className="field__error">加载失败，请稍后重试。</p>
      ) : (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            对外图片都带可见出处条与隐形可验编号。共分发 <strong>{trace.data?.copies.length ?? 0}</strong> 份独立水印副本，
            记录访问 <strong>{trace.data?.eventCount ?? 0}</strong> 次。
            {trace.data?.revokedAt ? ' 该链接已撤销，副本与留痕仍保留用于追溯。' : ''}
          </p>

          <div className="log-list" style={{ maxHeight: 280, overflow: 'auto' }}>
            {(trace.data?.copies ?? []).map((c) => (
              <div key={c.id} className="log-item">
                <div className="log-item__body">
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => copyCode(c.code)}
                      title="复制副本编号"
                    >
                      <code>{c.code}</code>
                    </button>
                    <Tag tone="muted">{c.variant === 'full' ? '大图' : '缩略图'}</Tag>
                    {c.downloadCount > 0 ? <Tag tone="warn">下载 {c.downloadCount}</Tag> : null}
                  </div>
                  <div className="log-item__meta">
                    访客 {c.visitorId}… · 首见 {formatDateTime(c.firstSeenAt)} · 最近 {formatDateTime(c.lastUsedAt)} ·{' '}
                    {c.width}×{c.height}
                  </div>
                </div>
                <Button size="sm" onClick={() => previewCopy(c.id)}>
                  查看副本
                </Button>
              </div>
            ))}
            {(trace.data?.copies.length ?? 0) === 0 ? (
              <p className="muted">还没有人打开过这条链接，暂无分发副本。</p>
            ) : null}
          </div>

          <div className="row">
            <Button size="sm" onClick={() => setShowEvents((v) => !v)}>
              {showEvents ? '收起访问留痕' : '查看访问留痕'}
            </Button>
          </div>

          {showEvents ? (
            events.isLoading ? (
              <Spinner label="加载留痕…" />
            ) : (
              <div className="log-list" style={{ maxHeight: 260, overflow: 'auto' }}>
                {(events.data?.events ?? []).map((e) => (
                  <div key={e.id} className="log-item">
                    <div className="log-item__body">
                      <div className="row" style={{ gap: 'var(--space-2)' }}>
                        <Tag tone={e.context === 'download' ? 'warn' : 'default'}>
                          {e.context === 'download' ? '下载' : '查看'}
                        </Tag>
                        {e.copyCode ? <code>{e.copyCode}</code> : <span className="muted">非图片文件</span>}
                      </div>
                      <div className="log-item__meta">
                        {formatDateTime(e.createdAt)} · 访客 {e.visitorId}…{e.ip ? ` · ${e.ip}` : ''}
                        {e.userAgent ? ` · ${e.userAgent.slice(0, 80)}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
                {(events.data?.events.length ?? 0) === 0 ? <p className="muted">暂无访问记录。</p> : null}
              </div>
            )
          ) : null}
        </div>
      )}
    </Modal>
  );
}
