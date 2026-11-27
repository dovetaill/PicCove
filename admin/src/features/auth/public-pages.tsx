import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  FolderHeart,
  Images,
  KeyRound,
  Link2,
  LockKeyhole,
  Moon,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AuthLayout } from '@/components/layout/auth-layout';
import { BrandLogo } from '@/components/layout/brand-logo';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, useMe, useSettings } from '@/lib/api';
import { passkey } from '@/lib/passkey';

export function ContactLink() {
  const { data } = useSettings();
  return data?.contact_url ? (
    <a
      href={data.contact_url}
      rel="noreferrer"
      className="text-primary hover:underline font-medium"
    >
      联系管理员
    </a>
  ) : (
    <span className="text-muted-foreground">如需协助请联系管理员</span>
  );
}

export function HomePage() {
  const settings = useSettings();
  const me = useMe();
  const { resolvedTheme, setTheme } = useTheme();
  const loggedIn = !!me.data;

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <header className="border-b border-border/80 bg-background/90 backdrop-blur-md sticky top-0 z-20">
        <div className="container h-16 flex items-center justify-between gap-4">
          <BrandLogo to="/" />
          <div className="flex items-center gap-2.5">
            <Button
              variant="ghost"
              mode="icon"
              shape="circle"
              aria-label="切换主题"
              onClick={() =>
                setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
              }
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
            <Button asChild variant={loggedIn ? 'primary' : 'outline'}>
              <Link to={loggedIn ? '/app' : '/login'}>
                {loggedIn ? '进入工作台' : '登录工作台'}
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="grow">
        <section className="container py-16 lg:py-24 grid lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 space-y-6">
            <Badge variant="primary" appearance="light" size="lg">
              PicCove · 私有与公开兼备的现代图床空间
            </Badge>
            <h1 className="text-4xl sm:text-5xl lg:text-[54px] font-semibold tracking-tight text-mono leading-[1.18]">
              让每一张图片，
              <br />
              <span className="text-primary">都有它的归处。</span>
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground leading-relaxed max-w-xl">
              为你的博客、项目文档与日常灵感提供干净纯粹的图片托管体验。支持原图保存、相册归档、AI 连续创作与多格式稳定外链。
            </p>
            <div className="flex flex-wrap items-center gap-3.5 pt-2">
              <Button size="lg" asChild>
                <Link
                  to={
                    loggedIn
                      ? '/app'
                      : settings.data?.registration_open
                        ? '/register'
                        : '/login'
                  }
                >
                  {loggedIn
                    ? '打开我的图片库'
                    : settings.data?.registration_open
                      ? '立即创建图片空间'
                      : '进入我的图片空间'}
                  <ArrowRight />
                </Link>
              </Button>
              {!loggedIn && settings.data?.registration_open && (
                <Button size="lg" variant="outline" asChild>
                  <Link to="/login">已有账号登录</Link>
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {settings.data?.registration_open
                ? '当前已开放自助注册，注册即享专属存储配额'
                : '当前采用受邀开放模式，已有账号可直接登录'}
            </p>
          </div>

          <div className="lg:col-span-5">
            <div className="relative rounded-2xl border border-border bg-gradient-to-br from-blue-600/8 via-muted/60 to-emerald-500/8 p-6 sm:p-8 shadow-sm">
              <div className="grid grid-cols-2 gap-3.5">
                <div className="col-span-2 rounded-xl border border-border bg-card p-4 shadow-2xs flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Images className="size-4.5" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-mono">
                        无损原图直出
                      </p>
                      <p className="text-xs text-muted-foreground">
                        JPEG · PNG · WebP · GIF
                      </p>
                    </div>
                  </div>
                  <Badge variant="success" appearance="light" size="sm">
                    10 MiB / 张
                  </Badge>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 shadow-2xs space-y-2">
                  <FolderHeart className="size-5 text-primary" />
                  <p className="text-sm font-semibold text-mono">公开与私密</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    支持公开外链直连，也可随时切换为仅本人可见
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 shadow-2xs space-y-2">
                  <Sparkles className="size-5 text-primary" />
                  <p className="text-sm font-semibold text-mono">AI 创作台</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    对话式生成与参考图微调，作品自动存入个人图库
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="container pb-20">
          <div className="grid md:grid-cols-3 gap-5">
            {[
              [
                Images,
                '原图无损安放',
                '保留原始分辨率与色彩细节，自动生成高速列表缩略图，浏览与管理如丝般顺滑。',
              ],
              [
                FolderHeart,
                '井井有条的相册',
                '按文章、产品或灵感主题建立相册，支持拖拽/粘贴上传、批量归档与全局快速搜索。',
              ],
              [
                Link2,
                '一键多格式分享',
                '提供 URL 直链、Markdown、HTML、BBCode 与缩略图跳转代码，复制即可嵌入任意站点。',
              ],
            ].map(([Icon, title, desc]) => {
              const FeatureIcon = Icon as typeof Images;
              return (
                <Card key={String(title)}>
                  <CardContent className="p-6 space-y-3">
                    <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FeatureIcon className="size-5" />
                    </span>
                    <h2 className="text-base font-semibold text-mono">
                      {String(title)}
                    </h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {String(desc)}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-6">
        <div className="container flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>PicCove 图湾 · 让创作有处安放</span>
          <ContactLink />
        </div>
      </footer>
    </div>
  );
}

export function AuthPage({ register = false }: { register?: boolean }) {
  const settings = useSettings();
  const navigate = useNavigate();
  const client = useQueryClient();
  const isIpHost =
    typeof window !== 'undefined' &&
    /^(?:\d{1,3}\.){3}\d{1,3}$|^\[/.test(window.location.hostname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'passkey' | 'password'>(
    isIpHost ? 'password' : 'passkey',
  );
  const [agreed, setAgreed] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    const code = String(form.get('code') || '').trim();

    if (register && new TextEncoder().encode(password).length < 12) {
      setError('密码长度至少需要 12 个字节');
      return;
    }

    setBusy(true);
    setError('');
    try {
      if (!register && method === 'passkey') {
        await passkey(false, { username });
      } else {
        await api(`/auth/${register ? 'register' : 'login'}`, 'POST', {
          username,
          password,
          code,
        });
      }
      if (register) {
        toast.success('账号已创建，请登录');
        navigate('/login');
      } else {
        client.clear();
        navigate('/app');
      }
    } catch (err) {
      setError(errorMessage(err, '请求失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-mono">
            {register ? '创建你的图片空间' : '欢迎回到图湾'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {register ? '注册新账号，开始整理你的视觉素材' : '登录以访问你的图片库与相册'}
          </p>
        </div>

        {register && settings.isError ? (
          <div role="alert" className="space-y-3 text-center py-4">
            <p className="text-sm text-destructive">无法获取注册配置</p>
            <Button variant="outline" onClick={() => void settings.refetch()}>
              重试
            </Button>
          </div>
        ) : register && !settings.data?.registration_open ? (
          <div className="rounded-lg border border-border bg-muted/50 p-4 text-center text-sm text-muted-foreground">
            {settings.isPending
              ? '正在检查注册状态…'
              : '当前未开放自助注册，请联系管理员开通账号。'}
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {!register && (
              <Tabs
                value={method}
                onValueChange={(val) => {
                  setMethod(val as 'passkey' | 'password');
                  setError('');
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="passkey" className="gap-1.5">
                    <KeyRound className="size-3.5" />
                    Passkey 登录
                  </TabsTrigger>
                  <TabsTrigger value="password" className="gap-1.5">
                    <LockKeyhole className="size-3.5" />
                    密码登录
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            <div className="space-y-2">
              <Label htmlFor="auth-username">用户名</Label>
              <Input
                id="auth-username"
                name="username"
                required
                minLength={3}
                maxLength={32}
                pattern={register ? '[A-Za-z0-9_\\-]{3,32}' : undefined}
                title={register ? '3–32 位字母、数字、下划线或连字符' : undefined}
                autoComplete="username"
                placeholder="3–32 位字母、数字、下划线或连字符"
              />
            </div>

            {(register || method === 'password') && (
              <div className="space-y-2">
                <Label htmlFor="auth-password">密码</Label>
                <Input
                  id="auth-password"
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  placeholder={register ? '至少 12 位字符（或 12 字节）' : '输入登录密码'}
                />
              </div>
            )}

            {!register && method === 'password' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="auth-code">二步验证码 / 恢复码</Label>
                  <span className="text-xs text-muted-foreground">
                    开启二步验证时填写
                  </span>
                </div>
                <Input
                  id="auth-code"
                  name="code"
                  autoComplete="one-time-code"
                  maxLength={16}
                  placeholder="6 位动态码或 XXXX-XXXX 恢复码"
                  className="font-mono tracking-widest"
                />
              </div>
            )}

            {register && (
              <div className="flex items-start gap-2.5 pt-1">
                <Checkbox
                  id="register-agree"
                  checked={agreed}
                  onCheckedChange={(v) => setAgreed(v === true)}
                  required
                />
                <Label
                  htmlFor="register-agree"
                  className="text-xs text-muted-foreground font-normal leading-relaxed cursor-pointer"
                >
                  我已知晓公开图片可通过外链访问，请勿上传违法违规内容。
                </Label>
              </div>
            )}

            {error && (
              <Alert variant="destructive" appearance="light">
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={busy || (register && !agreed)}
            >
              {busy
                ? '正在验证…'
                : register
                  ? '创建账号'
                  : method === 'passkey'
                    ? '使用 Passkey 登录'
                    : '登录工作台'}
            </Button>
          </form>
        )}

        <div className="flex items-center justify-between border-t border-border pt-4 text-xs">
          {register ? (
            <Link
              to="/login"
              className="text-primary font-medium hover:underline"
            >
              已有账号？直接登录
            </Link>
          ) : settings.data?.registration_open ? (
            <Link
              to="/register"
              className="text-primary font-medium hover:underline"
            >
              没有账号？立即注册
            </Link>
          ) : (
            <span className="text-muted-foreground">忘记密码请联系管理员</span>
          )}
          <ContactLink />
        </div>
      </div>
    </AuthLayout>
  );
}
