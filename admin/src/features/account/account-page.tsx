import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserCircle2,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Toolbar, ToolbarHeading } from '@/components/layout/page-toolbar';
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
import { copyTextToClipboard } from '@/features/gallery/links-dialog';
import { useUploads } from '@/features/uploads/upload-manager';
import { api, errorMessage, size, useMe } from '@/lib/api';
import { passkey } from '@/lib/passkey';
import { quotaPercent } from '@/lib/utils';

type SecurityInfo = {
  totp_enabled: boolean;
  passkeys: { id: string; name: string }[];
};

type PendingTotp = { secret: string; uri: string } | null;

export function AccountPage() {
  const me = useMe();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { prepareLeave, resetLeave } = useUploads();

  const security = useQuery({
    queryKey: ['security'],
    queryFn: () => api<SecurityInfo>('/me/security'),
  });

  const [usernameOpen, setUsernameOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  const [pendingTotp, setPendingTotp] = useState<PendingTotp>(null);
  const [totpDisableOpen, setTotpDisableOpen] = useState(false);
  const [passkeyAddOpen, setPasskeyAddOpen] = useState(false);
  const [passkeyRemoveTarget, setPasskeyRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const account = me.data;
  const totpEnabled = !!security.data?.totp_enabled;
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
        await api('/me/totp/confirm', 'POST', proof);
        setPendingTotp(null);
        setTotpOpen(false);
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
                  <div className="flex items-center gap-2">
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
                  </div>
                  <p className="text-xs text-muted-foreground">
                    使用密码登录时额外验证 6 位动态口令（兼容 Google / Microsoft Authenticator、1Password 等）
                  </p>
                </div>
              </div>
              {totpEnabled ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTotpDisableOpen(true)}
                >
                  关闭二步验证
                </Button>
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

      {/* Dialog 1: Change Username */}
      <Dialog
        open={usernameOpen}
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
                pattern="^[A-Za-z0-9_-]{3,32}$"
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
                <Label htmlFor="username-totp">6 位动态验证码</Label>
                <Input
                  id="username-totp"
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
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
                <Label htmlFor="pwd-totp">6 位动态验证码</Label>
                <Input
                  id="pwd-totp"
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
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
              <Label htmlFor="disable-totp-code">6 位动态验证码</Label>
              <Input
                id="disable-totp-code"
                name="code"
                required
                inputMode="numeric"
                maxLength={6}
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
      <Dialog
        open={passkeyAddOpen}
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
                <Label htmlFor="pk-code">6 位动态验证码</Label>
                <Input
                  id="pk-code"
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
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
                <Label htmlFor="rm-pk-code">6 位动态验证码</Label>
                <Input
                  id="rm-pk-code"
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
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
    </div>
  );
}
