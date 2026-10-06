import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Modal, Select, TextInput } from '../../components/ui';
import type { WatermarkMode } from '../../api/types';

const WATERMARK_OPTIONS: { value: WatermarkMode; label: string; hint: string }[] = [
  { value: 'visible+lsb', label: '明水印 + 盲水印（推荐）', hint: '图片上平铺出处与验证码，像素内另藏可验证盲水印' },
  { value: 'lsb', label: '仅盲水印（看不出来）', hint: '画面无改动，但仍可凭盲水印反查到接收者' },
  { value: 'off', label: '不加水印', hint: '只记录访问留痕，图片本身不带出处标记' },
];

export function ShareDialog({
  open,
  fid,
  itemIds,
  onClose,
}: {
  open: boolean;
  fid: string;
  itemIds: string[];
  onClose: () => void;
}) {
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [watermarkMode, setWatermarkMode] = useState<WatermarkMode>('visible+lsb');
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ shareLink: { url: string | null; token: string } }>(`/families/${fid}/share-links`, {
        itemIds,
        expiresInDays: days,
        password: password.trim() || null,
        label: label.trim() || null,
        watermarkMode,
      }),
    onSuccess: (data) => {
      setUrl(`${window.location.origin}${data.shareLink.url ?? `/share/${data.shareLink.token}`}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '创建失败'),
  });

  const close = () => {
    setUrl(null);
    setPassword('');
    setLabel('');
    setError(null);
    onClose();
  };

  const activeHint = WATERMARK_OPTIONS.find((o) => o.value === watermarkMode)?.hint;

  return (
    <Modal
      open={open}
      title="分享给家人或朋友"
      onClose={close}
      footer={
        url ? (
          <Button variant="primary" onClick={close}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={close}>取消</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() => {
                setError(null);
                create.mutate();
              }}
            >
              生成链接
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div>
          <p>把这个链接发给对方，任何人拿到链接{password ? '并输入密码后' : ''}就能查看（只能看，不能改）。</p>
          <TextInput readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="分享链接" />
          <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(url);
              }}
            >
              复制链接
            </Button>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 'var(--space-3)' }}>
            链接将在 {days} 天后自动失效，随时可以在设置里撤销。{watermarkMode !== 'off' ? '外发图片带出处水印，撤销后仍可凭水印追溯已分发副本。' : ''}
          </p>
        </div>
      ) : (
        <>
          <p className="muted">将分享选中的 {itemIds.length} 条记录。</p>
          <Field label="有效期">
            <TextInput
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value))))}
            />
          </Field>
          <Field label="访问密码" hint="选填；填了之后对方需要输入密码才能看">
            <TextInput value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} maxLength={64} />
          </Field>
          <Field label="图片出处水印" hint={activeHint}>
            <Select value={watermarkMode} onChange={(e) => setWatermarkMode(e.target.value as WatermarkMode)}>
              {WATERMARK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="备注" hint="选填，方便自己记账，例如「给二叔看看」">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </Field>
          {error ? (
            <p className="field__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
