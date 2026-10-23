import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, useMe } from './api';
import { passkey } from './passkey';

export function AccountSecurity() {
  const me = useMe();
  const client = useQueryClient();
  const security = useQuery({
    queryKey: ['security'],
    queryFn: () =>
      api<{ totp_enabled: boolean; passkeys: { id: string; name: string }[] }>(
        '/me/security',
      ),
  });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    secret: string;
    uri: string;
  } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      'value',
    );
    const proof = {
      current_password: values.get('current_password'),
      code: values.get('code') || '',
    };
    setBusy(true);
    try {
      if (action === 'username') {
        await api('/me/username', 'POST', {
          ...proof,
          username: values.get('username'),
        });
      } else if (action === 'totp-start') {
        setPending(await api('/me/totp/start', 'POST', proof));
      } else if (action === 'totp-confirm') {
        await api('/me/totp/confirm', 'POST', proof);
        setPending(null);
      } else if (action === 'totp-remove') {
        if (
          !window.confirm(
            '关闭二步验证后，密码登录将不再需要动态验证码。确认关闭？',
          )
        )
          return;
        await api('/me/totp/remove', 'POST', proof);
      } else if (action === 'passkey') {
        await passkey(true, { ...proof, name: values.get('name') });
      } else if (action?.startsWith('remove:')) {
        if (
          !window.confirm(
            '确认删除此 Passkey？请确认仍能使用其他 Passkey 或密码和验证码登录。',
          )
        )
          return;
        await api('/me/passkeys/remove', 'POST', {
          ...proof,
          id: action.slice(7),
        });
      } else return;
      toast.success(
        action === 'totp-start'
          ? '请在验证器中添加密钥，然后输入验证码确认'
          : '账号安全设置已更新',
      );
      if (action !== 'totp-start') form.reset();
      await client.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  if (security.isPending) return <p role="status">正在读取安全设置…</p>;
  if (security.isError)
    return (
      <p role="alert">
        安全设置加载失败。
        <Button onClick={() => void security.refetch()}>重试</Button>
      </p>
    );
  return (
    <form className="cove-security cove-form" onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>身份确认</CardTitle>
        </CardHeader>
        <CardContent className="cove-form">
          <p className="cove-muted">
            修改下方设置前请输入当前密码；已开启二步验证时还需动态验证码。保存后其他设备需重新登录。
          </p>
          <label>
            当前密码
            <Input
              name="current_password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          {(security.data.totp_enabled || pending) && (
            <label>
              六位动态验证码
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </label>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>用户名</CardTitle>
        </CardHeader>
        <CardContent className="cove-form">
          <label>
            登录用户名
            <Input
              name="username"
              defaultValue={me.data?.user.username}
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_-]+"
              autoComplete="username"
            />
          </label>
          <p className="cove-muted">
            默认 admin 也可以修改。账号权限、图片和相册保持不变。
          </p>
          <Button type="submit" name="action" value="username" disabled={busy}>
            保存用户名
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>二步验证（验证器）</CardTitle>
        </CardHeader>
        <CardContent className="cove-form">
          <p>
            {security.data.totp_enabled
              ? '已开启：密码登录需要六位动态验证码。'
              : '尚未开启：绑定验证器后，密码登录需要额外输入动态验证码。'}
          </p>
          {pending && (
            <div className="cove-form">
              <p>
                在验证器中选择手动添加，类型选“基于时间”，输入以下密钥。请妥善保存在密码管理器中，以备恢复使用；10
                分钟内输入验证码确认。
              </p>
              <code className="break-all select-all">{pending.secret}</code>
              <a href={pending.uri}>在本机验证器中打开</a>
            </div>
          )}
          <Button
            type="submit"
            name="action"
            value={
              security.data.totp_enabled
                ? 'totp-remove'
                : pending
                  ? 'totp-confirm'
                  : 'totp-start'
            }
            variant={security.data.totp_enabled ? 'outline' : 'primary'}
            disabled={busy}
          >
            {security.data.totp_enabled
              ? '关闭二步验证'
              : pending
                ? '确认开启二步验证'
                : '绑定验证器'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Passkey 通行密钥</CardTitle>
        </CardHeader>
        <CardContent className="cove-form">
          <p className="cove-muted">
            绑定后优先使用设备指纹、面容或 PIN
            登录；仍可选择密码＋二步验证。建议保留可用的验证器或另一枚 Passkey。
          </p>
          {security.data.passkeys.map((key) => (
            <div className="cove-setting" key={key.id}>
              <span>{key.name}</span>
              <Button
                type="submit"
                name="action"
                value={`remove:${key.id}`}
                variant="outline"
                disabled={busy}
              >
                删除
              </Button>
            </div>
          ))}
          <label>
            新 Passkey 名称
            <Input name="name" placeholder="例如：我的手机" maxLength={100} />
          </label>
          <Button type="submit" name="action" value="passkey" disabled={busy}>
            添加 Passkey
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
