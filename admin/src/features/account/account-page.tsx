import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  UserCircle2,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Toolbar, ToolbarHeading } from '@/components/layout/page-toolbar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { copyTextToClipboard } from '@/features/gallery/links-dialog';
import { useUploads } from '@/features/uploads/upload-manager';
import {
  api,
  errorMessage,
  size,
  useMe,
  type Album,
  type ApiTokenItem,
  type CreatedApiToken,
} from '@/lib/api';
import { passkey } from '@/lib/passkey';
import { formatShortDate, quotaPercent } from '@/lib/utils';

type SecurityInfo = {
  totp_enabled: boolean;
  recovery_remaining?: number;
  passkeys: { id: string; name: string }[];
  api_tokens?: ApiTokenItem[];
};

type PendingTotp = { secret: string; uri: string } | null;

export function AccountPage() {
  const me = useMe();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { prepareLeave, resetLeave } = useUploads();

  const account = me.data;
  const security = useQuery({
    queryKey: ['security', account?.user.id || ''],
    queryFn: () => api<SecurityInfo>('/me/security'),
  });

  const [usernameOpen, setUsernameOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  const [pendingTotp, setPendingTotp] = useState<PendingTotp>(null);
  const [totpDisableOpen, setTotpDisableOpen] = useState(false);
  const [regenRecoveryOpen, setRegenRecoveryOpen] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [passkeyAddOpen, setPasskeyAddOpen] = useState(false);
  const [passkeyRemoveTarget, setPasskeyRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [tokenCreateOpen, setTokenCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenAlbumId, setTokenAlbumId] = useState('none');
  const [tokenPublic, setTokenPublic] = useState(true);
  const [createdToken, setCreatedToken] = useState<CreatedApiToken | null>(null);
  const [revokeTokenTarget, setRevokeTokenTarget] =
    useState<ApiTokenItem | null>(null);
  const [busy, setBusy] = useState(false);

  const albums = useQuery({
    queryKey: ['albums', account?.user.id || ''],
    queryFn: () => api<Album[]>('/albums'),
    enabled: tokenCreateOpen,
  });

  const totpEnabled = !!security.data?.totp_enabled;
  const apiTokens = security.data?.api_tokens ?? [];
  const percent = account
    ? quotaPercent(account.used_bytes, account.user.quota_bytes)
    : 0;

  async function submitUsername(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api('/me/username', 'POST', {
        username: String(values.get('username') || '').trim(),
        current_password: values.get('current_password'),
        code: String(values.get('code') || '').trim(),
      });
      await client.invalidateQueries();
      toast.success('登录用户名已更新');
      setUsernameOpen(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    const nextPassword = String(values.get('password') || '');
    const confirmPassword = String(values.get('confirm') || '');
    if (nextPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    if (new TextEncoder().encode(nextPassword).length < 12) {
      toast.error('新密码长度至少需要 12 个字节');
      return;
    }
    if (!(await prepareLeave())) return;
    setBusy(true);
    try {
      await api('/me/password', 'POST', {
        current_password: values.get('current_password'),
        password: nextPassword,
        code: String(values.get('code') || '').trim(),
      });
      toast.success('密码已更新，请重新登录');
      setPasswordOpen(false);
      client.clear();
      navigate('/login');
    } catch (error) {
      resetLeave();
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateTotp(form: HTMLFormElement | null) {
    if (!form || busy) return;
    const pwdInput = form.elements.namedItem(
      'current_password',
    ) as HTMLInputElement | null;
    if (pwdInput && !pwdInput.reportValidity()) return;
    setBusy(true);
    try {
      const started = await api<{ secret: string; uri: string }>(
        '/me/totp/start',
        'POST',
        { current_password: pwdInput?.value || '' },
      );
      setPendingTotp(started);
      toast.success('已重新生成验证器密钥');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleTotpStep(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    const proof = {
      current_password: values.get('current_password'),
      code: String(values.get('code') || '').trim(),
    };
    setBusy(true);
    try {
      if (!pendingTotp) {
        const started = await api<{ secret: string; uri: string }>(
          '/me/totp/start',
          'POST',
          proof,
        );
        setPendingTotp(started);
        toast.success('请使用验证器扫码并输入 6 位验证码完成绑定');
      } else {
        const confirmed = await api<{ recovery_codes?: string[] }>(
          '/me/totp/confirm',
          'POST',
          proof,
        );
        setPendingTotp(null);
        setTotpOpen(false);
        if (confirmed?.recovery_codes?.length) {
          setRecoveryCodes(confirmed.recovery_codes);
        }
        await client.invalidateQueries({ queryKey: ['security'] });
        toast.success('二步验证已开启');
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitDisableTotp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api('/me/totp/remove', 'POST', {
        current_password: values.get('current_password'),
        code: String(values.get('code') || '').trim(),
      });
      setTotpDisableOpen(false);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('二步验证已关闭');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitAddPasskey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await passkey(true, {
        name: String(values.get('name') || '').trim(),
        current_password: values.get('current_password'),
        code: String(values.get('code') || '').trim(),
      });
      setPasskeyAddOpen(false);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('Passkey 已添加');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitRemovePasskey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!passkeyRemoveTarget || busy) return;
    const values = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api('/me/passkeys/remove', 'POST', {
        id: passkeyRemoveTarget.id,
        current_password: values.get('current_password'),
        code: String(values.get('code') || '').trim(),
      });
      setPasskeyRemoveTarget(null);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('Passkey 已移除');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegenRecovery(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const values = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const res = await api<{ recovery_codes: string[] }>(
        '/me/totp/recovery',
        'POST',
        {
          current_password: values.get('current_password'),
          code: String(values.get('code') || '').trim(),
        },
      );
      setRegenRecoveryOpen(false);
      setRecoveryCodes(res.recovery_codes);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('已生成新的二步验证恢复码');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitCreateToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const name = tokenName.trim();
    if (!name) {
      toast.error('请填写令牌名称');
      return;
    }
    setBusy(true);
    try {
      const created = await api<CreatedApiToken>('/me/tokens', 'POST', {
        name,
        default_album_id: tokenAlbumId === 'none' ? null : tokenAlbumId,
        default_public: tokenPublic,
      });
      setTokenCreateOpen(false);
      setTokenName('');
      setTokenAlbumId('none');
      setTokenPublic(true);
      setCreatedToken(created);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('上传令牌已生成，请立即复制保存');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRevokeToken() {
    if (!revokeTokenTarget || busy) return;
    setBusy(true);
    try {
      await api(`/me/tokens/${revokeTokenTarget.id}`, 'DELETE');
      setRevokeTokenTarget(null);
      await client.invalidateQueries({ queryKey: ['security'] });
      toast.success('令牌已吊销');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function downloadRecoveryTxt(codes: string[]) {
    const content = [
      `PicCove 二步验证应急恢复码 (${account?.user.username || 'user'})`,
      `生成时间: ${new Date().toISOString()}`,
      '每个恢复码仅可使用一次，请妥善保存在离线位置：',
      '',
      ...codes,
      '',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `piccove-recovery-codes-${account?.user.username || 'user'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container max-w-4xl space-y-6">
      <Toolbar>
        <ToolbarHeading
          title="账号与安全"
          description="管理个人身份信息、密码、二步验证与 Passkey 通行密钥"
        />
      </Toolbar>

      {/* Profile Overview Card */}
      {account && (
        <Card>
          <CardContent className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary text-xl font-semibold border border-primary/20">
                {account.user.username.slice(0, 1).toUpperCase()}
              </span>
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-mono break-all">
                    {account.user.username}
                  </h2>
                  <Badge
                    variant={account.user.is_admin ? 'primary' : 'secondary'}
                    appearance="light"
                    size="sm"
                  >
                    {account.user.is_admin ? '管理员' : '普通成员'}
                  </Badge>
                  {account.user.moderation_exempt && !account.user.is_admin && (
                    <Badge variant="info" appearance="light" size="sm">
                      免审白名单
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  已启用{' '}
                  {[
                    '密码',
                    totpEnabled ? '二步验证' : null,
                    security.data?.passkeys.length
                      ? `${security.data.passkeys.length} 枚 Passkey`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>

            <div className="w-full sm:w-64 space-y-2 rounded-xl bg-muted/50 border border-border p-3.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">存储空间占用</span>
                <span className="font-semibold text-mono tabular-nums">
                  {percent}%
                </span>
              </div>
              <Progress value={percent} />
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {size(account.used_bytes)} / {size(account.user.quota_bytes)}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Security Settings Rows (Metronic Account Security Pattern) */}
      <Card>
        <CardHeader>
          <CardTitle>登录凭证与安全保护</CardTitle>
          <CardDescription>
            执行敏感变更时需核验当前密码{totpEnabled ? '与动态验证码' : ''}
          </CardDescription>
        </CardHeader>

        {security.isPending ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground" role="status">
            正在读取安全配置…
          </CardContent>
        ) : security.isError ? (
          <CardContent className="py-10 text-center space-y-3" role="alert">
            <p className="text-sm text-destructive">
              {errorMessage(security.error)}
            </p>
            <Button variant="outline" onClick={() => void security.refetch()}>
              重试
            </Button>
          </CardContent>
        ) : (
          <CardContent className="p-0 divide-y divide-border">
            {/* Row 1: Username */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:px-6">
              <div className="flex items-start gap-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-secondary-foreground mt-0.5">
                  <UserCircle2 className="size-4.5" />
                </span>
                <div className="space-y-0.5">
                  <h3 className="text-sm font-semibold text-mono">登录用户名</h3>
                  <p className="text-xs text-muted-foreground">
                    当前用户名：<strong className="text-foreground">{account?.user.username}</strong>
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setUsernameOpen(true)}
              >
                修改用户名
              </Button>
            </div>

            {/* Row 2: Password */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:px-6">
              <div className="flex items-start gap-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-secondary-foreground mt-0.5">
                  <LockKeyhole className="size-4.5" />
                </span>
                <div className="space-y-0.5">
                  <h3 className="text-sm font-semibold text-mono">登录密码</h3>
                  <p className="text-xs text-muted-foreground">
                    更新密码后所有已登录设备将重新认证
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPasswordOpen(true)}
              >
                修改密码
              </Button>
            </div>

            {/* Row 3: TOTP 2FA */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:px-6">
              <div className="flex items-start gap-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-secondary-foreground mt-0.5">
                  <Smartphone className="size-4.5" />
                </span>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-mono">
                      二步验证（TOTP 验证器）
                    </h3>
                    <Badge
                      size="xs"
                      appearance="light"
                      variant={totpEnabled ? 'success' : 'secondary'}
                    >
                      {totpEnabled ? '已开启' : '未开启'}
                    </Badge>
                    {totpEnabled &&
                      security.data?.recovery_remaining !== undefined && (
                        <Badge size="xs" variant="info" appearance="light">
                          剩余 {security.data.recovery_remaining} 个恢复码
                        </Badge>
                      )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    使用密码登录时额外验证 6 位动态口令（兼容 Google / Microsoft Authenticator、1Password 等）
                  </p>
                </div>
              </div>
              {totpEnabled ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRegenRecoveryOpen(true)}
                  >
                    <RefreshCw />
                    重置恢复码
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTotpDisableOpen(true)}
                  >
                    关闭二步验证
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setPendingTotp(null);
                    setTotpOpen(true);
                  }}
                >
                  <ShieldCheck />
                  绑定验证器
                </Button>
              )}
            </div>

            {/* Row 4: Passkeys */}
            <div className="p-5 sm:px-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-secondary-foreground mt-0.5">
                    <Fingerprint className="size-4.5" />
                  </span>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-mono">
                        Passkey 通行密钥
                      </h3>
                      <Badge size="xs" variant="secondary" appearance="light">
                        {security.data.passkeys.length} 枚
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      使用指纹、面容 ID 或设备 PIN 免密快捷登录
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPasskeyAddOpen(true)}
                >
                  <Plus />
                  添加 Passkey
                </Button>
              </div>

              {security.data.passkeys.length > 0 && (
                <div className="sm:ps-12.5 grid gap-2">
                  {security.data.passkeys.map((pk) => (
                    <div
                      key={pk.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3.5 py-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <KeyRound className="size-4 text-primary shrink-0" />
                        <span className="text-sm font-medium text-mono truncate">
                          {pk.name}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`删除 Passkey ${pk.name}`}
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPasskeyRemoveTarget(pk)}
                      >
                        <Trash2 className="size-3.5" />
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Stage 4B: Upload API Tokens Card */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              上传 API 令牌
              <Badge size="xs" variant="secondary" appearance="light">
                {apiTokens.length} / 10
              </Badge>
            </CardTitle>
            <CardDescription>
              供 PicGo、ShareX、Typora 或命令行脚本免 Cookie 直传图片，随时可独立吊销
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={apiTokens.length >= 10}
            onClick={() => setTokenCreateOpen(true)}
          >
            <Plus />
            生成上传令牌
          </Button>
        </CardHeader>
        <CardContent>
          {apiTokens.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              暂未创建上传令牌，点击右上角即可为桌面图床工具生成专属密钥。
            </p>
          ) : (
            <div className="divide-y divide-border -my-2">
              {apiTokens.map((tok) => (
                <div
                  key={tok.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <Terminal className="size-3.5 text-primary shrink-0" />
                      <span className="text-sm font-medium text-mono truncate">
                        {tok.name}
                      </span>
                      <Badge
                        size="xs"
                        appearance="light"
                        variant={tok.default_public ? 'success' : 'secondary'}
                      >
                        {tok.default_public ? '默认公开' : '默认私有'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      创建于 {formatShortDate(tok.created_at)}
                      {tok.last_used_at
                        ? ` · 最近使用 ${formatShortDate(tok.last_used_at)}`
                        : ' · 尚未使用'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setRevokeTokenTarget(tok)}
                  >
                    <Trash2 className="size-3.5" />
                    吊销
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog 1: Change Username */}
      {usernameOpen && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!busy) setUsernameOpen(v);
          }}
        >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>修改登录用户名</DialogTitle>
            <DialogDescription>
              支持 3–32 位字母、数字、下划线或连字符
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submitUsername(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="change-username">新用户名</Label>
              <Input
                id="change-username"
                name="username"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_\-]{3,32}"
                title="3–32 位字母、数字、下划线或连字符"
                defaultValue={account?.user.username || ''}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username-current-pwd">当前密码</Label>
              <Input
                id="username-current-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            {totpEnabled && (
              <div className="space-y-2">
                <Label htmlFor="username-totp">6 位动态验证码或恢复码</Label>
                <Input
                  id="username-totp"
                  name="code"
                  required
                  maxLength={16}
                  autoComplete="one-time-code"
                  className="font-mono tracking-widest"
                />
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setUsernameOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '保存中…' : '保存用户名'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      )}

      {/* Dialog 2: Change Password */}
      <Dialog
        open={passwordOpen}
        onOpenChange={(v) => {
          if (!busy) setPasswordOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>修改登录密码</DialogTitle>
            <DialogDescription>
              密码至少 12 个字节，保存后需使用新密码重新登录
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submitPassword(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pwd-current">当前密码</Label>
              <Input
                id="pwd-current"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pwd-new">新密码</Label>
              <Input
                id="pwd-new"
                name="password"
                type="password"
                required
                maxLength={128}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pwd-confirm">确认新密码</Label>
              <Input
                id="pwd-confirm"
                name="confirm"
                type="password"
                required
                maxLength={128}
                autoComplete="new-password"
              />
            </div>
            {totpEnabled && (
              <div className="space-y-2">
                <Label htmlFor="pwd-totp">6 位动态验证码或恢复码</Label>
                <Input
                  id="pwd-totp"
                  name="code"
                  required
                  maxLength={16}
                  autoComplete="one-time-code"
                  className="font-mono tracking-widest"
                />
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPasswordOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '更新中…' : '确认更新密码'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 3: Bind TOTP (with QRCodeSVG!) */}
      <Dialog
        open={totpOpen}
        onOpenChange={(v) => {
          if (!busy) {
            setTotpOpen(v);
            if (!v) setPendingTotp(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>绑定二步验证器</DialogTitle>
            <DialogDescription>
              {pendingTotp
                ? '使用身份验证器 App 扫描下方二维码，并在 10 分钟内输入 6 位验证码'
                : '请先输入当前登录密码以生成专属绑定密钥'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleTotpStep(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="totp-setup-pwd">当前密码</Label>
              <Input
                id="totp-setup-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>

            {pendingTotp && (
              <>
                <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
                  <div className="rounded-lg bg-white p-3 border border-border">
                    <QRCodeSVG value={pendingTotp.uri} size={176} level="M" />
                  </div>
                  <div className="flex items-center gap-2 w-full">
                    <code className="flex-1 rounded-md bg-background border border-border px-2.5 py-1.5 text-xs font-mono truncate select-all">
                      {pendingTotp.secret}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void copyTextToClipboard(
                          pendingTotp.secret,
                          '密钥已复制',
                        )
                      }
                    >
                      <Copy />
                      复制密钥
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="totp-confirm-code">验证器 6 位数字口令</Label>
                  <Input
                    id="totp-confirm-code"
                    name="code"
                    required
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="输入 6 位验证码"
                    autoComplete="one-time-code"
                    className="font-mono tracking-widest"
                  />
                </div>
              </>
            )}

            <DialogFooter className="gap-2">
              {pendingTotp && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  className="sm:me-auto"
                  onClick={(e) => void regenerateTotp(e.currentTarget.form)}
                >
                  重新生成密钥
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setTotpOpen(false);
                  setPendingTotp(null);
                }}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy
                  ? '处理中…'
                  : pendingTotp
                    ? '确认开启二步验证'
                    : '下一步：生成密钥'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 4: Disable TOTP */}
      <Dialog
        open={totpDisableOpen}
        onOpenChange={(v) => {
          if (!busy) setTotpDisableOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>关闭二步验证？</DialogTitle>
            <DialogDescription>
              关闭后使用密码登录将不再校验动态验证码
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void submitDisableTotp(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="disable-totp-pwd">当前密码</Label>
              <Input
                id="disable-totp-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="disable-totp-code">6 位动态验证码或恢复码</Label>
              <Input
                id="disable-totp-code"
                name="code"
                required
                maxLength={16}
                autoComplete="one-time-code"
                className="font-mono tracking-widest"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setTotpDisableOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {busy ? '正在关闭…' : '确认关闭'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 5: Add Passkey */}
      {passkeyAddOpen && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!busy) setPasskeyAddOpen(v);
          }}
        >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>添加 Passkey 通行密钥</DialogTitle>
            <DialogDescription>
              绑定当前设备或密码管理器的生物识别密钥
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void submitAddPasskey(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="pk-name">设备备注名称</Label>
              <Input
                id="pk-name"
                name="name"
                required
                maxLength={100}
                placeholder="例如：MacBook 指纹、iCloud 钥匙串"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pk-pwd">当前密码</Label>
              <Input
                id="pk-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            {totpEnabled && (
              <div className="space-y-2">
                <Label htmlFor="pk-code">6 位动态验证码或恢复码</Label>
                <Input
                  id="pk-code"
                  name="code"
                  required
                  maxLength={16}
                  autoComplete="one-time-code"
                  className="font-mono tracking-widest"
                />
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPasskeyAddOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '等待浏览器验证…' : '开始绑定'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      )}

      {/* Dialog 6: Remove Passkey */}
      <Dialog
        open={!!passkeyRemoveTarget}
        onOpenChange={(v) => {
          if (!v && !busy) setPasskeyRemoveTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              移除 Passkey「{passkeyRemoveTarget?.name}」？
            </DialogTitle>
            <DialogDescription>
              移除后将无法再使用这枚通行密钥免密登录
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void submitRemovePasskey(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="rm-pk-pwd">当前密码</Label>
              <Input
                id="rm-pk-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            {totpEnabled && (
              <div className="space-y-2">
                <Label htmlFor="rm-pk-code">6 位动态验证码或恢复码</Label>
                <Input
                  id="rm-pk-code"
                  name="code"
                  required
                  maxLength={16}
                  autoComplete="one-time-code"
                  className="font-mono tracking-widest"
                />
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPasskeyRemoveTarget(null)}
              >
                取消
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {busy ? '移除中…' : '确认移除'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 7: Regenerate Recovery Codes */}
      <Dialog
        open={regenRecoveryOpen}
        onOpenChange={(v) => {
          if (!busy) setRegenRecoveryOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>重新生成二步验证恢复码</DialogTitle>
            <DialogDescription>
              生成新的 8 个一次性恢复码后，旧恢复码将立即作废
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void submitRegenRecovery(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="regen-rec-pwd">当前密码</Label>
              <Input
                id="regen-rec-pwd"
                name="current_password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="regen-rec-code">6 位动态验证码或旧恢复码</Label>
              <Input
                id="regen-rec-code"
                name="code"
                required
                maxLength={16}
                autoComplete="one-time-code"
                className="font-mono tracking-widest"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRegenRecoveryOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '生成中…' : '生成新恢复码'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 8: Display Generated Recovery Codes */}
      <Dialog
        open={!!recoveryCodes}
        onOpenChange={(open) => {
          if (!open) setRecoveryCodes(null);
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>请妥善保存二步验证恢复码</DialogTitle>
            <DialogDescription>
              当你更换或遗失手机时，可使用以下任一恢复码替代动态验证码登录（每个恢复码仅限使用一次，关闭窗口后不再明文展示）。
            </DialogDescription>
          </DialogHeader>
          {recoveryCodes && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/40 p-3.5 font-mono text-sm">
                {recoveryCodes.map((c) => (
                  <div
                    key={c}
                    className="rounded-md bg-background border border-border px-2.5 py-1.5 text-center tracking-wider select-all"
                  >
                    {c}
                  </div>
                ))}
              </div>
              <DialogFooter className="flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void copyTextToClipboard(
                      recoveryCodes.join('\n'),
                      '全部恢复码已复制',
                    )
                  }
                >
                  <Copy />
                  复制全部
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => downloadRecoveryTxt(recoveryCodes)}
                >
                  <Download />
                  下载 .txt
                </Button>
                <Button type="button" onClick={() => setRecoveryCodes(null)}>
                  我已保存
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog 9: Create Upload API Token */}
      <Dialog
        open={tokenCreateOpen}
        onOpenChange={(v) => {
          if (!busy) setTokenCreateOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-[430px]">
          <DialogHeader>
            <DialogTitle>生成上传 API 令牌</DialogTitle>
            <DialogDescription>
              该令牌仅具备上传新图片权限，无法删除已有图片或修改账号配置
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void submitCreateToken(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="api-token-name">令牌备注名称</Label>
              <Input
                id="api-token-name"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                required
                maxLength={80}
                placeholder="例如：MacBook PicGo、Typora 博客直传"
              />
            </div>
            <div className="space-y-2">
              <Label>默认放入相册</Label>
              <Select value={tokenAlbumId} onValueChange={setTokenAlbumId}>
                <SelectTrigger aria-label="默认相册">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不放入相册</SelectItem>
                  {albums.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-sm font-medium text-mono">默认公开外链</p>
                <p className="text-xs text-muted-foreground">
                  适合博客与文档直插图片；关闭则默认存为私有
                </p>
              </div>
              <Switch
                checked={tokenPublic}
                onCheckedChange={setTokenPublic}
                aria-label="默认公开外链"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setTokenCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '生成中…' : '创建令牌'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 10: Show One-Time Created API Token + PicGo / curl Snippets */}
      <Dialog
        open={!!createdToken}
        onOpenChange={(open) => {
          if (!open) setCreatedToken(null);
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>令牌「{createdToken?.name}」已创建</DialogTitle>
            <DialogDescription>
              出于安全考虑，完整令牌仅展示这一次，请立即复制并填入你的上传工具。
            </DialogDescription>
          </DialogHeader>
          {createdToken && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <code className="flex-1 font-mono text-xs break-all select-all">
                  {createdToken.token}
                </code>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    void copyTextToClipboard(createdToken.token, '令牌已复制')
                  }
                >
                  <Copy />
                  复制令牌
                </Button>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const origin = window.location.origin;
                    const picgoConfig = JSON.stringify(
                      {
                        url: `${origin}/api/v1/images`,
                        paramName: 'file',
                        jsonPath: 'url',
                        customHeader: JSON.stringify({
                          Authorization: `Bearer ${createdToken.token}`,
                        }),
                      },
                      null,
                      2,
                    );
                    void copyTextToClipboard(
                      picgoConfig,
                      'PicGo 自定义图床配置已复制',
                    );
                  }}
                >
                  <Copy />
                  复制 PicGo 配置 JSON
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const cmd = `curl -X POST "${window.location.origin}/api/v1/images" -H "Authorization: Bearer ${createdToken.token}" -F "file=@photo.png"`;
                    void copyTextToClipboard(cmd, 'curl 上传示例已复制');
                  }}
                >
                  <Terminal />
                  复制 curl 命令示例
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => setCreatedToken(null)}>
                  完成
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!revokeTokenTarget}
        onOpenChange={(open) => {
          if (!open && !busy) setRevokeTokenTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              吊销上传令牌「{revokeTokenTarget?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              吊销后使用该令牌的客户端将无法继续上传新图片，此前已上传的图片外链不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmRevokeToken();
              }}
            >
              {busy ? '吊销中…' : '确认吊销'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
