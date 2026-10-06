import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { ImageGallery } from '../media/ImageGallery';
import { AudioPlayer } from '../media/AudioPlayer';
import { CATEGORY_ICONS, CATEGORY_LABELS } from '../../lib/constants';
import type { Item, Media } from '../../api/types';

interface ShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  watermarkMode: 'visible+lsb' | 'lsb' | 'off';
  items: Item[];
}

/**
 * 公开页的媒体 DTO 里的地址是家庭内部接口，访客没有登录态，必须重写成
 * /public/share/<token>/media/... 走鉴权（图片会下发带水印的逐访客副本）。
 */
function publicMedia(token: string, m: Media): Media {
  const rewrite = (url: string | null): string | null =>
    url ? url.replace(/^\/api\/v1\/families\/[^/]+\/media\//, `/api/v1/public/share/${token}/media/`) : null;
  return {
    ...m,
    rawUrl: rewrite(m.rawUrl) ?? `/api/v1/public/share/${token}/media/${m.id}/raw`,
    thumbUrl: rewrite(m.thumbUrl),
    waveformUrl: rewrite(m.waveformUrl),
  };
}

export function ShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [view, setView] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (pwd?: string) =>
      api<{ share: ShareView }>(`/public/share/${token}`, {
        method: 'POST',
        body: pwd ? { password: pwd } : {},
        skipRetry: true,
      }),
    onSuccess: (data) => setView(data.share),
    onError: (err) => setError(err instanceof ApiError ? err.message : '打不开这个分享'),
  });

  // 首屏自动探测：这条分享是否需要密码
  const { mutate } = open;
  useEffect(() => {
    mutate(undefined);
    // 只在 token 变化时重新探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (open.isPending && !view) return <Spinner label="正在打开分享…" />;

  if (error && !view) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>打不开这个分享</h1>
          <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (view?.requiresPassword) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-card__head">
            <h1>{view.familyName}</h1>
            <p>这是家人分享给你的内容，需要输入访问密码。</p>
          </div>
          <Field label="访问密码" error={error} required>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setError(null);
                  open.mutate(password);
                }
              }}
              autoFocus
            />
          </Field>
          <Button
            variant="primary"
            loading={open.isPending}
            onClick={() => {
              setError(null);
              open.mutate(password);
            }}
            style={{ width: '100%' }}
          >
            查看
          </Button>
        </div>
      </div>
    );
  }

  if (!view) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              册
            </span>
            <span>{view.familyName}</span>
          </span>
          <div style={{ flex: 1 }} />
          <Tag>只读分享</Tag>
        </div>
      </header>
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1>{view.label || '家人分享给你的记录'}</h1>
            <p className="page-head__sub">共 {view.items.length} 条，链接有效期至 {new Date(view.expiresAt).toLocaleDateString('zh-CN')}</p>
          </div>
        </div>

        {view.watermarkMode !== 'off' ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            本页图片由「{view.familyName}」通过家庭档案系统分发，已自动添加
            {view.watermarkMode === 'visible+lsb' ? '可见出处水印与隐藏验证标记' : '隐藏出处验证标记'}
            ；访问与下载会被记录，请勿擅自二次转发。
          </p>
        ) : null}

        {view.items.length === 0 ? (
          <EmptyState title="没有可查看的内容" description="可能分享已经被撤销或内容已删除。" />
        ) : (
          <div className="stack">
            {view.items.map((item) => {
              const publicItem = { ...item, media: item.media.map((m) => publicMedia(token!, m)) };
              return (
                <article key={item.id} className="card">
                  <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 6 }}>
                    <Tag>
                      {CATEGORY_ICONS[item.category]} {CATEGORY_LABELS[item.category]}
                    </Tag>
                    <Tag tone="muted">{item.acquiredDisplay}</Tag>
                  </div>
                  <h2 style={{ marginBottom: 'var(--space-2)' }}>{item.title}</h2>
                  {item.placeText ? <p className="muted">{item.placeText}</p> : null}
                  {item.storyHtml ? (
                    <div className="story" dangerouslySetInnerHTML={{ __html: item.storyHtml }} />
                  ) : null}
                  <ImageGallery media={publicItem.media.filter((m) => m.kind === 'image')} />
                  {publicItem.media
                    .filter((m) => m.kind === 'audio')
                    .map((m) => (
                      <div key={m.id} style={{ marginTop: 'var(--space-3)' }}>
                        <AudioPlayer media={{ ...m, rawUrl: `/api/v1/public/share/${token}/media/${m.id}/download` }} />
                      </div>
                    ))}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
