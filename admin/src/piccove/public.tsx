import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Images,
  Link2,
  FolderHeart,
  ShieldCheck,
  Waves,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api, useSettings } from './api';
export function Brand() {
  return (
    <Link to="/" className="cove-brand">
      <span>
        <Waves size={24} />
      </span>
      <strong>
        PicCove <small>图湾</small>
      </strong>
    </Link>
  );
}
export function Contact() {
  const { data } = useSettings();
  return data?.contact_url ? (
    <a href={data.contact_url} rel="noreferrer">
      联系管理员
    </a>
  ) : (
    <span>邀请试用 · 请通过邀请渠道联系管理员</span>
  );
}
export function Home() {
  const settings = useSettings();
  return (
    <div className="cove-home">
      <header className="cove-public-header">
        <Brand />
        <nav>
          <a href="#features">功能</a>
          <Button asChild variant="outline">
            <Link to="/login">
              登录工作台 <ArrowRight />
            </Link>
          </Button>
        </nav>
      </header>
      <main>
        <section className="cove-hero">
          <div>
            <p className="cove-eyebrow">A HOME FOR EVERY IMAGE</p>
            <h1>
              让每一张图片，
              <br />
              <em>都有它的归处。</em>
            </h1>
            <p className="cove-intro">
              为你的博客、网站与创作，留一片安静的港湾。
              <br />
              上传原图，整理相册，用一个链接分享灵感。
            </p>
            <div className="cove-actions">
              <Button size="lg" asChild>
                <Link
                  to={settings.data?.registration_open ? '/register' : '/login'}
                >
                  {settings.data?.registration_open
                    ? '创建你的图片空间'
                    : '进入我的图片空间'}
                  <ArrowRight />
                </Link>
              </Button>
              <span>原图保存 · 稳定外链</span>
            </div>
            <p className="cove-muted">
              {settings.data?.registration_open
                ? '现已开放注册'
                : '当前采用邀请制，已有账号可直接登录'}
            </p>
          </div>
          <div className="cove-art" aria-hidden="true">
            <div className="cove-art-card cove-art-back">
              <div />
            </div>
            <div className="cove-art-card cove-art-front">
              <div />
              <span>Some moments deserve a home.</span>
            </div>
            <span className="cove-art-label">
              <FolderHeart size={17} /> 收藏每一份灵感
            </span>
          </div>
        </section>
        <section id="features" className="cove-features">
          {[
            [
              Images,
              '原图，在这里安放',
              '保留上传时的画质与格式，支持 JPEG、PNG、WebP 和 GIF。',
            ],
            [
              FolderHeart,
              '让图库井井有条',
              '用相册整理素材，批量管理图片，随时找到下一篇文章的配图。',
            ],
            [
              Link2,
              '分享，只需一个链接',
              '复制直链、Markdown 或 HTML，放进你的博客与网站。',
            ],
          ].map(([Icon, title, text]) => {
            const FeatureIcon = Icon as typeof Images;
            return (
              <Card key={String(title)}>
                <CardContent>
                  <FeatureIcon className="cove-feature-icon" />
                  <h2>{String(title)}</h2>
                  <p>{String(text)}</p>
                </CardContent>
              </Card>
            );
          })}
        </section>
        <div className="cove-public-note">
          <ShieldCheck />
          <p>
            适合公开发布的图片。持有链接即可访问；请勿上传隐私或敏感资料。管理员可查看并删除托管图片。
          </p>
        </div>
      </main>
      <footer>
        <span>PicCove 图湾 · 让创作有处安放</span>
        <Contact />
      </footer>
    </div>
  );
}
export function Auth({ register = false }: { register?: boolean }) {
  const settings = useSettings();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/auth/${register ? 'register' : 'login'}`, 'POST', {
        username: form.get('username'),
        password: form.get('password'),
      });
      if (register) {
        toast.success('注册成功，请登录');
        navigate('/login');
      } else {
        client.clear();
        navigate('/app');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cove-auth">
      <Brand />
      <Card>
        <CardContent>
          <p className="cove-eyebrow">YOUR IMAGE COVE</p>
          <h1>{register ? '创建你的图片空间' : '欢迎回到图湾'}</h1>
          <p className="cove-muted">
            {register
              ? '从第一张图片，开始整理你的灵感。'
              : '登录，继续你的创作。'}
          </p>
          {settings.isError ? (
            <p role="alert">无法读取注册状态，请刷新重试。</p>
          ) : register && !settings.data?.registration_open ? (
            <p>
              {settings.isPending
                ? '正在读取注册状态…'
                : '注册暂未开放，请联系管理员。'}
            </p>
          ) : (
            <form onSubmit={submit} className="cove-form">
              <label>
                用户名
                <Input
                  name="username"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]+"
                  autoComplete="username"
                  placeholder="3–32 位字母、数字、下划线或连字符"
                />
              </label>
              <label>
                密码
                <Input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  placeholder="至少 12 字节"
                />
              </label>
              {register && (
                <label className="cove-check">
                  <input type="checkbox" required />
                  我了解图片通过链接公开访问，管理员可查看和删除托管图片。
                </label>
              )}
              {error && (
                <p role="alert" className="cove-error">
                  {error}
                </p>
              )}
              <Button disabled={busy} type="submit">
                {busy ? '请稍候…' : register ? '创建账号' : '登录'}
              </Button>
            </form>
          )}
          <div className="cove-auth-links">
            {register ? (
              <Link to="/login">已有账号？登录</Link>
            ) : (
              settings.data?.registration_open && (
                <Link to="/register">还没有账号？注册</Link>
              )
            )}
            <Contact />
          </div>
          <p className="cove-muted">忘记密码？请联系管理员重置。</p>
        </CardContent>
      </Card>
      <Link to="/">← 返回首页</Link>
    </div>
  );
}
