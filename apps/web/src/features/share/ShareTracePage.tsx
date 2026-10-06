import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import type { ShareRecipient, ShareTraceEvent, ShareTraceOverview, TraceHit } from '../../api/types';

const EVENT_LABELS: Record<ShareTraceEvent['kind'], string> = {
  page_view: '打开页面',
  image_view: '查看图片',
  image_download: '下载图片',
  media_download: '访问音频/文件',
  denied: '被拒绝（密码错误/已停用）',
};

export function ShareTracePage() {
  const { fid, linkId } = useParams<{ fid: string; linkId: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [selected, setSelected] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['share-overview', fid, linkId],
    queryFn: () => api.get<{ overview: ShareTraceOverview }>(`/families/${fid}/share-links/${linkId}/overview`),
    enabled: Boolean(fid && linkId),
  });

  const recipients = useQuery({
    queryKey: ['share-recipients', fid, linkId],
    queryFn: () => api.get<{ recipients: ShareRecipient[] }>(`/families/${fid}/share-links/${linkId}/recipients`),
    enabled: Boolean(fid && linkId),
  });

  const events = useQuery({
    queryKey: ['share-events', fid, linkId, selected],
    queryFn: () =>
      api.get<{ events: ShareTraceEvent[] }>(
        `/families/${fid}/share-links/${linkId}/events?limit=200${selected ? `&recipientId=${selected}` : ''}`,
      ),
    enabled: Boolean(fid && linkId),
  });

  const patchRecipient = useMutation({
    mutationFn: (input: { recipientId: string; label?: string | null; blocked?: boolean }) =>
      api.patch(`/families/${fid}/share-links/${linkId}/recipients/${input.recipientId}`, {
        label: input.label,
        blocked: input.blocked,
      }),
    onSuccess: async () => {
      push('已更新', 'success');
      await queryClient.invalidateQueries({ queryKey: ['share-recipients', fid, linkId] });
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '操作失败', 'error'),
  });

  if (overview.isLoading) return <Spinner />;
  const o = overview.data?.overview;
  if (!o) return <p className="muted">找不到这条分享。</p>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>分享溯源 · {o.label || '未命名分享'}</h1>
          <p className="page-head__sub">
            状态：
            {o.status === 'active' ? (
              <Tag tone="success">有效</Tag>
            ) : o.status === 'revoked' ? (
              <Tag>已撤销</Tag>
            ) : (
              <Tag tone="muted">已过期</Tag>
            )}
            {' · '}水印模式：{o.watermarkMode === 'off' ? '关闭' : o.watermarkMode === 'lsb' ? '仅盲水印' : '明水印 + 盲水印'}
            {o.revokedAt ? ` · 撤销于 ${formatDateTime(o.revokedAt)}` : ` · 有效期至 ${formatDateTime(o.expiresAt)}`}
          </p>
        </div>
      </div>

      <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Stat label="已识别访客" value={o.recipients} />
        <Stat label="分发水印副本" value={o.watermarkedCopies} />
        <Stat label="覆盖图片" value={o.trackedImages} />
        <Stat label="访问/下载事件" value={o.events} />
        <Stat label="下载次数" value={o.downloads} />
      </div>

      <p className="muted" style={{ marginBottom: 0 }}>
        即使{ o.status === 'active' ? '稍后' : ''}撤销或过期这条链接，下面的访客、水印码与访问记录仍然保留；
        如果在外部看到了外传的图片，用页面底部的「验证出处」上传图片即可反查到具体访客。
      </p>

      <VerifyPanel fid={fid!} linkId={linkId!} />

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>访客与已分发副本</h2>
        <div className="log-list">
          {(recipients.data?.recipients ?? []).map((r) => (
            <div key={r.id} className="log-item">
              <div className="log-item__body">
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setSelected((cur) => (cur === r.id ? null : r.id))}
                  >
                    {selected === r.id ? '全部访客' : '只看TA'}
                  </button>
                  <span>{r.label || '未命名访客'}</span>
                  {r.blocked ? <Tag>已停用</Tag> : null}
                </div>
                <div className="log-item__meta">
                  首次 {formatDateTime(r.firstSeenAt)}（{r.firstIp || '未知 IP'}） · 最近{' '}
                  {formatDateTime(r.lastSeenAt)}（{r.lastIp || '未知 IP'}） · 水印副本 {r.watermarkCount} 份 · 事件{' '}
                  {r.eventCount} 条
                  {r.lastUserAgent ? ` · ${r.lastUserAgent.slice(0, 80)}` : ''}
                </div>
                <div className="row" style={{ gap: 'var(--space-2)', marginTop: 6 }}>
                  <TextInput
                    placeholder="给这个访客起个备注，如「二叔的手机」"
                    defaultValue={r.label ?? ''}
                    style={{ maxWidth: 280 }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        patchRecipient.mutate({ recipientId: r.id, label: e.currentTarget.value.trim() || null });
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={(e) => {
                      const input = e.currentTarget.previousSibling as HTMLInputElement | null;
                      patchRecipient.mutate({
                        recipientId: r.id,
                        label: input?.value?.trim() || null,
                      });
                    }}
                  >
                    存备注
                  </Button>
                  <Button
                    size="sm"
                    variant={r.blocked ? 'primary' : 'danger'}
                    onClick={() => patchRecipient.mutate({ recipientId: r.id, blocked: !r.blocked })}
                  >
                    {r.blocked ? '恢复访问' : '停用该访客'}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {(recipients.data?.recipients ?? []).length === 0 ? <p className="muted">还没有人打开过这条分享。</p> : null}
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>访问留痕{selected ? '（已按访客筛选）' : ''}</h2>
        <div className="log-list">
          {(events.data?.events ?? []).map((e) => (
            <div key={e.id} className="log-item">
              <div className="log-item__body">
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <Tag tone={e.kind === 'denied' ? 'warn' : e.kind.includes('download') ? 'success' : 'muted'}>
                    {EVENT_LABELS[e.kind]}
                  </Tag>
                  {e.wmCode ? <code>{e.wmCode}</code> : null}
                </div>
                <div className="log-item__meta">
                  {formatDateTime(e.createdAt)} · {e.ip || '未知 IP'}
                  {e.userAgent ? ` · ${e.userAgent.slice(0, 80)}` : ''}
                  {e.byteSize ? ` · ${Math.round(e.byteSize / 1024)} KB` : ''}
                </div>
              </div>
            </div>
          ))}
          {(events.data?.events ?? []).length === 0 ? <p className="muted">暂无访问记录。</p> : null}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <section className="card" style={{ minWidth: 140, textAlign: 'center', flex: '0 0 auto' }}>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
    </section>
  );
}

function VerifyPanel({ fid, linkId }: { fid: string; linkId: string }) {
  const { push } = useToast();
  const [code, setCode] = useState('');
  const [hit, setHit] = useState<TraceHit | null>(null);

  const verifyCode = useMutation({
    mutationFn: () => api.post<{ trace: TraceHit }>(`/families/${fid}/share-links/${linkId}/verify`, { wmCode: code }),
    onSuccess: (d) => setHit(d.trace),
    onError: (err) => push(err instanceof ApiError ? err.message : '验证失败', 'error'),
  });

  const verifyImage = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<{ trace: TraceHit }>(`/families/${fid}/share-links/${linkId}/verify-image`, fd);
    },
    onSuccess: (d) => {
      setHit(d.trace);
      if (!d.trace.watermark) push('图片中没有提取到有效水印（可能经过重度裁剪或重新压缩）', 'error');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '验证失败', 'error'),
  });

  return (
    <section className="card" style={{ borderColor: 'var(--accent)' }}>
      <h2 style={{ marginBottom: 'var(--space-2)' }}>验证出处 / 追溯外传副本</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        拿到外传图片时：直接上传图片（自动提取像素中的盲水印），或抄录图片上的 13 位出处验证码。
      </p>
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <TextInput
          placeholder="出处验证码，如 7K2M9QXA4BZ0D"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          style={{ maxWidth: 260 }}
        />
        <Button
          variant="primary"
          loading={verifyCode.isPending}
          onClick={() => code.trim() && verifyCode.mutate()}
        >
          按验证码查询
        </Button>
        <label className="btn">
          上传疑似外传图片
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) verifyImage.mutate(f);
              e.currentTarget.value = '';
            }}
          />
        </label>
        {verifyImage.isPending ? <span className="muted">正在提取盲水印…</span> : null}
      </div>
      {hit ? <TraceResult hit={hit} /> : null}
    </section>
  );
}

function TraceResult({ hit }: { hit: TraceHit }) {
  if (!hit.watermark || !hit.link || !hit.recipient) {
    return (
      <p className="field__error" style={{ marginBottom: 0 }}>
        未找到匹配的分发副本{hit.valid ? '' : '，且水印码未通过防伪校验（可能是伪造或抄录有误）'}。
      </p>
    );
  }
  return (
    <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--surface-2)', borderRadius: 8 }}>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Tag tone="success">已命中（{hit.source === 'lsb' ? '盲水印' : hit.source === 'png-text' ? '图片元数据' : '验证码'}）</Tag>
        <code>{hit.wmCode}</code>
        {!hit.valid ? <Tag tone="warn">防伪校验未通过</Tag> : null}
      </div>
      <ul className="muted" style={{ margin: 'var(--space-2) 0', paddingLeft: 18, fontSize: 14 }}>
        <li>
          来源链接：{hit.link.label || '未命名'}（{hit.link.revokedAt ? `已于 ${formatDateTime(hit.link.revokedAt)} 撤销` : `有效期至 ${formatDateTime(hit.link.expiresAt)}`}）
        </li>
        <li>
          分发访客：{hit.recipient.label || '未命名访客'} · 首次访问 {formatDateTime(hit.recipient.firstSeenAt)} · 首次 IP{' '}
          {hit.recipient.firstIp || '未知'}
        </li>
        <li>副本生成于 {formatDateTime(hit.watermark.createdAt)}，被查看 {hit.watermark.viewCount} 次、下载 {hit.watermark.downloadCount} 次</li>
        <li>副本 sha256：<code>{hit.watermark.sha256.slice(0, 24)}…</code></li>
      </ul>
      <details>
        <summary className="muted">该副本的全部访问事件（{hit.events.length}）</summary>
        <div className="log-list" style={{ marginTop: 8 }}>
          {hit.events.map((e, i) => (
            <div key={i} className="log-item__meta">
              {formatDateTime(e.createdAt)} · {EVENT_LABELS[e.kind as ShareTraceEvent['kind']] ?? e.kind} · {e.ip || '未知 IP'}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
