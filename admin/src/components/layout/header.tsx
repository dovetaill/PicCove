import { Fragment, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  CloudUpload,
  LogOut,
  Menu,
  Moon,
  PanelLeft,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserCog,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { ProgressCircle } from '@/components/ui/progress';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { useUploads } from '@/features/uploads/upload-manager';
import { useMenu } from '@/hooks/use-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { useScrollPosition } from '@/hooks/use-scroll-position';
import { api, errorMessage, size, type Account } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BrandLogo } from './brand-logo';
import { useLayout } from './layout-context';
import { buildSidebarMenu } from './menu-config';
import { SidebarNavContent } from './sidebar';

export function Header({
  account,
  pendingReviews,
}: {
  account: Account;
  pendingReviews?: number;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const scrollPosition = useScrollPosition();
  const { resolvedTheme, setTheme } = useTheme();
  const {
    sidebarDark,
    setSidebarDark,
    setCommandOpen,
    setUploadSheetOpen,
  } = useLayout();
  const { queue, busy, prepareLeave, resetLeave } = useUploads();

  const menu = buildSidebarMenu(account.user.is_admin, pendingReviews);
  const { getBreadcrumb } = useMenu(pathname);
  const breadcrumbs = getBreadcrumb(menu).filter((item) => item.title);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  const activeUpload = queue.find((i) =>
    ['上传中', '服务器处理中', '核对结果'].includes(i.status),
  );
  const finishedUploads = queue.filter((i) => !!i.image).length;
  const failedUploads = queue.filter((i) => i.status === '失败').length;
  const overallProgress =
    queue.length > 0
      ? Math.round(
          ((finishedUploads + (activeUpload?.progress || 0) / 100) /
            queue.length) *
            100,
        )
      : 0;

  async function handleLogout() {
    if (!(await prepareLeave())) return;
    try {
      await api('/auth/logout', 'POST');
      queryClient.clear();
      navigate('/login');
    } catch (error) {
      resetLeave();
      toast.error(errorMessage(error));
    }
  }

  return (
    <header
      className={cn(
        'header fixed top-0 z-20 start-0 end-0 flex items-stretch shrink-0 bg-background/90 backdrop-blur-md border-b border-border/80 pe-[var(--removed-body-scroll-bar-size,0px)]',
        scrollPosition > 4 && 'shadow-xs',
      )}
    >
      <div className="container-fluid flex items-center justify-between gap-3">
        {/* Left: Mobile Drawer Trigger + Breadcrumbs */}
        <div className="flex items-center gap-2.5 min-w-0">
          {isMobile && (
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  mode="icon"
                  aria-label="打开导航"
                  className="shrink-0"
                >
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="p-0 gap-0 w-[272px] flex flex-col"
              >
                <SheetHeader className="px-5 h-14 border-b border-border flex flex-row items-center justify-between space-y-0">
                  <BrandLogo
                    to="/app"
                    onClick={() => setMobileMenuOpen(false)}
                  />
                  <SheetTitle className="sr-only">工作台导航</SheetTitle>
                </SheetHeader>
                <SheetBody className="p-0 flex flex-col grow min-h-0">
                  <SidebarNavContent
                    account={account}
                    pendingReviews={pendingReviews}
                    onNavigate={() => setMobileMenuOpen(false)}
                  />
                </SheetBody>
              </SheetContent>
            </Sheet>
          )}

          {isMobile ? (
            <BrandLogo to="/app" />
          ) : (
            <nav
              aria-label="面包屑导航"
              className="flex items-center gap-1.5 text-sm min-w-0"
            >
              <span className="text-muted-foreground font-medium">工作台</span>
              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <Fragment key={crumb.path || idx}>
                    <ChevronRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                    {crumb.path && !isLast ? (
                      <Link
                        to={crumb.path}
                        className="text-muted-foreground hover:text-foreground transition-colors truncate"
                      >
                        {crumb.title}
                      </Link>
                    ) : (
                      <span className="font-semibold text-mono truncate">
                        {crumb.title}
                      </span>
                    )}
                  </Fragment>
                );
              })}
            </nav>
          )}
        </div>

        {/* Right: Command Search, Upload Center, Theme Toggle, User Dropdown */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCommandOpen(true)}
            aria-label="打开全局快速跳转"
            className="hidden sm:inline-flex h-8.5 px-3 gap-2 text-muted-foreground hover:text-foreground bg-muted/40 border-border/80"
          >
            <Search className="size-3.5" />
            <span className="text-xs">搜索或跳转…</span>
            <Kbd size="xs" className="ms-2">
              ⌘K
            </Kbd>
          </Button>
          <Button
            variant="ghost"
            mode="icon"
            size="sm"
            onClick={() => setCommandOpen(true)}
            aria-label="快速跳转"
            className="sm:hidden size-8.5"
          >
            <Search className="size-4" />
          </Button>

          {queue.length > 0 && (
            <Button
              variant={failedUploads > 0 && !busy ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => setUploadSheetOpen(true)}
              className="h-8.5 gap-2 px-2.5"
              aria-label="打开上传任务中心"
            >
              {busy ? (
                <ProgressCircle
                  value={overallProgress}
                  size={18}
                  strokeWidth={2.5}
                />
              ) : (
                <CloudUpload className="size-4" />
              )}
              <span className="text-xs font-medium tabular-nums">
                {busy
                  ? `${finishedUploads}/${queue.length}`
                  : failedUploads > 0
                    ? `异常 ${failedUploads}`
                    : `已传 ${finishedUploads}`}
              </span>
            </Button>
          )}

          <Button
            variant="ghost"
            mode="icon"
            shape="circle"
            aria-label={resolvedTheme === 'dark' ? '切换浅色模式' : '切换深色模式'}
            onClick={() =>
              setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
            }
            className="size-8.5"
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="账号菜单"
                className="cursor-pointer inline-flex items-center gap-2 rounded-full p-0.5 pe-2 hover:bg-accent transition-colors focus-visible:outline-hidden"
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-primary/12 text-primary font-semibold text-sm border border-primary/20">
                  {account.user.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden md:inline text-sm font-medium text-mono max-w-[110px] truncate">
                  {account.user.username}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="end" sideOffset={8}>
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold text-sm">
                    {account.user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-mono truncate">
                      {account.user.username}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums truncate">
                      {size(account.used_bytes)} / {size(account.user.quota_bytes)}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={account.user.is_admin ? 'primary' : 'secondary'}
                  appearance="light"
                  size="sm"
                >
                  {account.user.is_admin ? '管理员' : '成员'}
                </Badge>
              </div>

              <DropdownMenuSeparator />

              <DropdownMenuItem asChild>
                <Link to="/app/account" className="flex items-center gap-2">
                  <UserCog />
                  账号与安全设置
                </Link>
              </DropdownMenuItem>

              {account.user.is_admin && (
                <>
                  <DropdownMenuItem asChild>
                    <Link to="/app/admin" className="flex items-center gap-2">
                      <ShieldCheck />
                      管理控制台概览
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      to="/app/admin/settings"
                      className="flex items-center gap-2"
                    >
                      <SlidersHorizontal />
                      系统全局设置
                    </Link>
                  </DropdownMenuItem>
                </>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2">
                  <Moon className="size-4 text-muted-foreground" />
                  深色界面
                </span>
                <Switch
                  size="sm"
                  checked={resolvedTheme === 'dark'}
                  onCheckedChange={(checked) =>
                    setTheme(checked ? 'dark' : 'light')
                  }
                />
              </DropdownMenuItem>

              {!isMobile && resolvedTheme !== 'dark' && (
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2">
                    <PanelLeft className="size-4 text-muted-foreground" />
                    深色侧边栏
                  </span>
                  <Switch
                    size="sm"
                    checked={sidebarDark}
                    onCheckedChange={setSidebarDark}
                  />
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />

              <div className="p-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => void handleLogout()}
                >
                  <LogOut />
                  退出登录
                </Button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
