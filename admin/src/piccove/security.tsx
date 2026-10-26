import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, useMe } from './api';
import { passkey } from './passkey';

type SecurityInfo = {
  totp_enabled: boolean;
  passkeys: { id: string; name: string }[];
};

export type PendingTotp = { secret: string; uri: string } | null;

function useSecurityInfo() {
  return useQuery({
    queryKey: ['security'],
    queryFn: () => api<SecurityInfo>('/me/security'),
  });
}

function SecurityStatus({
  query,
}: {
  query: ReturnType<typeof useSecurityInfo>;
}) {
  if (query.isPending) return <p role="status">正在读取安全设置…</p>;
  if (query.isError)
    return (
      <p role="alert">
        安全设置加载失败。
        <Button onClick={() => void query.refetch()}>重试</Button>
      </p>
    );
  return null;
}

export function AccountProfile() {
  const me = useMe();
  const client = useQueryClient();
  const security = useSecurityInfo();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    setBusy(true);
    try {
      await api('/me/username', 'POST', {
        current_password: values.get('current_password'),
        code: values.get('code') || '',
        username: values.get('username'),
      });
      toast.success('用户名已更新');
      for (const name of ['current_password', 'code']) {
        const input = form.elements.namedItem(name) as HTMLInputElement | null;
        if (input) input.value = '';
      }
      await client.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (security.isPending || security.isError)
    return <SecurityStatus query={security} />;
  return (
    <form className="cove-security" noValidate onSubmit={submit}>
      <section className="cove-account-section">
        <h2>用户名</h2>
        <div className="cove-form">
          <label>
            登录用户名
            <Input
              name="username"
              required
              defaultValue={me.data?.user.username}
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_-]+"
              autoComplete="username"
            />
          </label>
          <p className="cove-muted">
            使用 3–32 位字母、数字、下划线或短横线。修改后用新用户名登录，图片、相册和账号权限都不受影响。
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
          {security.data.totp_enabled && (
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
          <Button type="submit" disabled={busy}>
            保存用户名
          </Button>
        </div>
      </section>
    </form>
  );
}

export function AccountSecurity({
  pending,
  setPending,
}: {
  pending: PendingTotp;
  setPending: (value: PendingTotp) => void;
}) {
  const client = useQueryClient();
  const security = useSecurityInfo();
  const [busy, setBusy] = useState(false);
  const totpConfirm = useRef<HTMLButtonElement>(null);
  const addPasskey = useRef<HTMLButtonElement>(null);

  function handleEnter(event: KeyboardEvent<HTMLFormElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement))
      return;
    if (event.target.name === 'name') {
      event.preventDefault();
      addPasskey.current?.click();
    } else if (event.target.name === 'code') {
      event.preventDefault();
      if (pending && !security.data?.totp_enabled)
        totpConfirm.current?.click();
    } else {
      event.preventDefault();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      'value',
    );
    if (!action) return;
    const fields = ['current_password'];
    if (security.data?.totp_enabled || action === 'totp-confirm')
      fields.push('code');
    if (action === 'passkey') fields.push('name');
    for (const name of fields) {
      const input = form.elements.namedItem(name) as HTMLInputElement | null;
      if (!input || !input.reportValidity()) return;
    }
    const values = new FormData(form);
    const proof = {
      current_password: values.get('current_password'),
      code: values.get('code') || '',
    };
    setBusy(true);
    try {
      if (action === 'totp-start') {
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
            `确认删除 Passkey“${security.data?.passkeys.find((key) => action === `remove:${key.id}`)?.name || '未知设备'}”？删除后将无法使用这枚通行密钥登录。请确认还可以使用其他通行密钥或密码；如果开启了二步验证，还需要验证码。`,
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
      if (action !== 'totp-start') {
        for (const name of fields) {
          const input = form.elements.namedItem(
            name,
          ) as HTMLInputElement | null;
          if (input) input.value = '';
        }
      }
      await client.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (security.isPending || security.isError)
    return <SecurityStatus query={security} />;
  return (
    <form
      className="cove-security"
      noValidate
      onSubmit={submit}
      onKeyDown={handleEnter}
    >
      <section className="cove-account-section">
        <h2>身份确认</h2>
        <div className="cove-form">
          <p className="cove-muted">
            修改验证方式前，请输入当前密码；开启二步验证后还需验证码。修改密码请使用下方表单。
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
        </div>
      </section>
      <section className="cove-account-section">
        <h2>二步验证（验证器）</h2>
        <div className="cove-form">
          <p>
            {security.data.totp_enabled
              ? '已开启。使用密码登录时，还需要输入验证器中的六位验证码。'
              : '尚未开启。绑定验证器后，登录时会在密码之外再核对一次验证码。'}
          </p>
          {pending && (
            <div className="cove-form">
              <p>
                在验证器中选择“手动添加”，类型选择“基于时间”，填入下方密钥。请在
                10
                分钟内输入验证码，完成绑定。建议将密钥保存在密码管理器中，换设备时可以恢复使用。
              </p>
              <code className="break-all select-all">{pending.secret}</code>
              <a href={pending.uri}>在本机验证器中打开</a>
            </div>
          )}
          <Button
            ref={
              pending && !security.data.totp_enabled ? totpConfirm : undefined
            }
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
          {pending && !security.data.totp_enabled && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                name="action"
                value="totp-start"
                variant="outline"
                disabled={busy}
              >
                重新绑定
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消绑定
              </Button>
            </div>
          )}
        </div>
      </section>
      <section className="cove-account-section">
        <h2>Passkey 通行密钥</h2>
        <div className="cove-form">
          <p className="cove-muted">
            用指纹、面容或设备 PIN
            登录，省去输入密码。仍可切换为密码登录；若开启了二步验证，还需验证码。建议保留另一种可用的登录方式。
          </p>
          {security.data.passkeys.map((key) => (
            <div className="cove-setting" key={key.id}>
              <span>{key.name}</span>
              <Button
                type="submit"
                name="action"
                value={`remove:${key.id}`}
                variant="outline"
                aria-label={`删除 Passkey ${key.name}`}
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
          <Button
            ref={addPasskey}
            type="submit"
            name="action"
            value="passkey"
            disabled={busy}
          >
            添加 Passkey
          </Button>
        </div>
      </section>
    </form>
  );
}
