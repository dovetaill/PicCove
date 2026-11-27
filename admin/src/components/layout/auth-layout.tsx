import { type ReactNode } from 'react';
import { FolderHeart, Images, Link2, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BrandLogo } from './brand-logo';

export function AuthLayout({ children }: { children: ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div className="grid min-h-dvh lg:grid-cols-2 bg-background">
      {/* Left: Form Column */}
      <div className="flex flex-col justify-between p-6 sm:p-10 order-2 lg:order-1">
        <div className="flex items-center justify-between">
          <BrandLogo to="/" />
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
        </div>

        <div className="flex items-center justify-center py-10">
          <Card className="w-full max-w-[420px] shadow-sm">
            <CardContent className="p-7 sm:p-8">{children}</CardContent>
          </Card>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground transition-colors">
            ← 返回首页
          </Link>
          <span>PicCove · 图湾</span>
        </div>
      </div>

      {/* Right: Metronic Branded Showcase Panel */}
      <div className="hidden lg:flex flex-col justify-between rounded-2xl border border-border m-4 p-12 order-1 lg:order-2 bg-gradient-to-br from-blue-600/8 via-zinc-100/70 to-emerald-500/8 dark:from-blue-500/12 dark:via-zinc-900 dark:to-emerald-500/10 relative overflow-hidden">
        <div className="space-y-4 max-w-md relative z-10">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <ShieldCheck className="size-3.5" />
            Passkey & 二步验证保护
          </span>
          <h2 className="text-3xl font-semibold tracking-tight text-mono leading-snug">
            让每一张图片，
            <br />
            都有安静可靠的归处。
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            原图无损托管、相册归档整理、AI 辅助创作，一键生成直链与 Markdown 外链。
          </p>
        </div>

        <div className="grid gap-3.5 max-w-md relative z-10">
          {[
            [Images, '原画质托管', '支持 JPEG、PNG、WebP、GIF 原图存储与高清预览'],
            [FolderHeart, '有序相册空间', '按项目或文章分类归档，公开与私有状态随时切换'],
            [Link2, '多格式稳定外链', '一键复制 URL、Markdown、HTML 与缩略图嵌套链接'],
          ].map(([Icon, title, desc]) => {
            const FeatureIcon = Icon as typeof Images;
            return (
              <div
                key={String(title)}
                className="flex items-start gap-3.5 rounded-xl border border-border/80 bg-card/85 backdrop-blur-xs p-4 shadow-2xs"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FeatureIcon className="size-4.5" />
                </span>
                <div className="space-y-0.5">
                  <h3 className="text-sm font-semibold text-mono">
                    {String(title)}
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {String(desc)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
