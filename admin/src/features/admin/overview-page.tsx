import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  ExternalLink,
  HardDrive,
  Images,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/components/layout/page-toolbar';
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
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  api,
  errorMessage,
  size,
  type AdminOverview,
  type ReleaseCheck,
  type StorageLocation,
  type SystemStatus,
} from '@/lib/api';

export function AdminOverviewPage() {
  const client = useQueryClient();
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [release, setRelease] = useState<ReleaseCheck | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    'update' | 'restart' | null
  >(null);
  const [busySystem, setBusySystem] = useState(false);

  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<AdminOverview>('/admin/overview'),
    refetchInterval: 15000,
  });

  const locations = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () =>
      api<{ items: StorageLocation[]; allowed_roots: string[] }>(
        '/storage-locations',
      ),
  });

  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemStatus>('/admin/system'),
    refetchInterval: 10000,
  });

  const defaultLoc = locations.data?.items.find((l) => l.default);
  const managerRunning = system.data?.manager?.state === 'running';

  async function handleCheckRelease() {
    setCheckingRelease(true);
    try {
      const res = await api<ReleaseCheck>('/admin/system/check', 'POST');
      setRelease(res);
      toast.success(res.update_available ? `发现新版本 ${res.latest}` : '当前已是最新稳定版');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCheckingRelease(false);
    }
  }

  async function executeSystemAction() {
    if (!confirmAction || busySystem) return;
    setBusySystem(true);
    try {
      await api(`/admin/system/${confirmAction}`, 'POST');
      toast.success('运维指令已下发，请等待服务恢复');
      setConfirmAction(null);
      await client.invalidateQueries({ queryKey: ['system'] });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusySystem(false);
    }
  }

  const data = overview.data;

  return (
    <div className="container space-y-6">
      <Toolbar>
        <ToolbarHeading
          title="管理控制台概览"
          description="查看全站用户规模、存储负载、内容审核队列与服务运行健康度"
        />
        <ToolbarActions>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void overview.refetch();
              void locations.refetch();
              void system.refetch();
            }}
          >
            <RefreshCw className="size-3.5" />
            刷新状态
          </Button>
        </ToolbarActions>
      </Toolbar>

      {/* Top 4 KPI Cards */}
      {overview.isPending ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5 space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3.5 w-36" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : overview.isError ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3" role="alert">
            <p className="text-sm text-destructive">
              {errorMessage(overview.error)}
            </p>
            <Button variant="outline" onClick={() => void overview.refetch()}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : (
        data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
            {/* KPI 1: Users */}
            <Card>
              <CardContent className="p-5 flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    平台用户数
                  </span>
                  <span className="flex size-8.5 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Users className="size-4" />
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="text-2xl font-semibold tracking-tight text-mono tabular-nums">
                    {data.users_total}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>
                      {data.registration_open ? '开放注册中' : '邀请/手动开通'}
                    </span>
                    {data.users_disabled > 0 && (
                      <Badge size="xs" variant="secondary">
                        禁用 {data.users_disabled}
                      </Badge>
                    )}
                    {data.users_banned > 0 && (
                      <Badge size="xs" variant="destructive" appearance="light">
                        封禁 {data.users_banned}
                      </Badge>
                    )}
                  </div>
                </div>
                <Link
                  to="/app/admin/users"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  管理用户与配额
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>

            {/* KPI 2: Images */}
            <Card>
              <CardContent className="p-5 flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    有效托管图片
                  </span>
                  <span className="flex size-8.5 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <Images className="size-4" />
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="text-2xl font-semibold tracking-tight text-mono tabular-nums">
                    {data.images_total}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    公开 {data.images_public} 张 · 私有{' '}
                    {Math.max(0, data.images_total - data.images_public)} 张
                  </p>
                </div>
                <Link
                  to="/app/admin/images"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  查看全部图片
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>

            {/* KPI 3: Storage */}
            <Card>
              <CardContent className="p-5 flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    累计图片占用
                  </span>
                  <span className="flex size-8.5 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                    <HardDrive className="size-4" />
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="text-2xl font-semibold tracking-tight text-mono tabular-nums">
                    {size(data.used_bytes)}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {defaultLoc?.available_bytes != null
                      ? `默认盘剩余可用 ${size(defaultLoc.available_bytes)}`
                      : '可在存储设置查看挂载详情'}
                  </p>
                </div>
                <Link
                  to="/app/admin/settings#settings-storage"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  存储目录与迁移
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>

            {/* KPI 4: Pending Moderation */}
            <Card
              className={
                data.reviews_pending > 0 ? 'border-amber-500/40' : undefined
              }
            >
              <CardContent className="p-5 flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    待人工复核
                  </span>
                  <span className="flex size-8.5 items-center justify-center rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="size-4" />
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="text-2xl font-semibold tracking-tight text-mono tabular-nums">
                    {data.reviews_pending}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {data.reviews_pending > 0
                      ? '存在疑似违规图片等待人工裁决'
                      : '当前没有积压的待复核图片'}
                  </p>
                </div>
                <Link
                  to="/app/admin/reviews"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  进入审核工作台
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>
          </div>
        )
      )}

      {/* Lower Two-Column Ops Section */}
      <div className="grid lg:grid-cols-12 gap-5">
        {/* Storage Mounts Health */}
        <Card className="lg:col-span-7">
          <CardHeader>
            <div>
              <CardTitle>存储位置状态</CardTitle>
              <CardDescription>各挂载目录的图片分布与磁盘空间</CardDescription>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/app/admin/settings#settings-storage">管理存储</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3.5">
            {locations.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : locations.isError ? (
              <div role="alert" className="py-6 text-center space-y-2.5">
                <p className="text-xs text-destructive">
                  {errorMessage(locations.error)}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void locations.refetch()}
                >
                  重试
                </Button>
              </div>
            ) : !locations.data?.items.length ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                暂无存储位置记录
              </p>
            ) : (
              locations.data.items.map((loc) => {
                const totalKnown =
                  loc.available_bytes != null
                    ? loc.used_bytes + loc.available_bytes
                    : 0;
                const usedRatio =
                  totalKnown > 0
                    ? Math.min(100, Math.round((loc.used_bytes / totalKnown) * 100))
                    : 0;
                return (
                  <div
                    key={loc.id}
                    className="rounded-xl border border-border p-4 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs font-semibold text-mono break-all">
                        {loc.path}
                      </code>
                      <div className="flex items-center gap-1.5">
                        {loc.default && (
                          <Badge variant="primary" appearance="light" size="sm">
                            默认写入
                          </Badge>
                        )}
                        {loc.error && (
                          <Badge variant="destructive" appearance="light" size="sm">
                            异常
                          </Badge>
                        )}
                      </div>
                    </div>

                    {loc.available_bytes != null && <Progress value={usedRatio} />}

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
                      <span>
                        {loc.count} 张图片 · 已占 {size(loc.used_bytes)}
                      </span>
                      <span>
                        {loc.available_bytes != null
                          ? `可用 ${size(loc.available_bytes)}`
                          : '可用空间未知'}
                      </span>
                    </div>

                    {loc.error && (
                      <p className="text-xs text-destructive">{loc.error}</p>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* System Version & Service Control */}
        <Card className="lg:col-span-5">
          <CardHeader>
            <div>
              <CardTitle>系统服务与版本</CardTitle>
              <CardDescription>宿主机守护进程状态与在线升级</CardDescription>
            </div>
            <Server className="size-4.5 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 border border-border p-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground block">
                  当前运行版本
                </span>
                <span className="text-base font-semibold text-mono font-mono">
                  v{system.data?.version || '—'}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground block">
                  宿主机管理服务
                </span>
                <Badge
                  size="sm"
                  appearance="light"
                  variant={
                    !system.data?.manager
                      ? 'secondary'
                      : managerRunning
                        ? 'warning'
                        : 'success'
                  }
                >
                  {system.isPending
                    ? '检测中'
                    : !system.data?.manager
                      ? '未连接'
                      : managerRunning
                        ? '任务执行中'
                        : '在线就绪'}
                </Badge>
              </div>
            </div>

            {data && data.jobs_active > 0 && (
              <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-xs">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <Activity className="size-3.5 text-primary animate-pulse" />
                  {data.jobs_active} 个存储迁移/导入任务正在后台运行
                </span>
                <Link
                  to="/app/admin/settings#settings-jobs"
                  className="font-semibold text-primary hover:underline"
                >
                  查看进度
                </Link>
              </div>
            )}

            {release && (
              <div className="rounded-xl border border-border p-3.5 flex items-center justify-between gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">最新稳定版：</span>
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {release.latest}
                    <ExternalLink className="size-3" />
                  </a>
                </div>
                <Badge
                  size="xs"
                  appearance="light"
                  variant={release.update_available ? 'warning' : 'success'}
                >
                  {release.update_available ? '可升级' : '已是最新'}
                </Badge>
              </div>
            )}

            {system.data?.manager?.message && (
              <p className="text-xs text-muted-foreground" role="status">
                {system.data.manager.message}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={checkingRelease || managerRunning}
                onClick={() => void handleCheckRelease()}
              >
                <RefreshCw
                  className={checkingRelease ? 'animate-spin' : undefined}
                />
                检查更新
              </Button>
              <Button
                size="sm"
                disabled={
                  busySystem ||
                  managerRunning ||
                  !system.data?.manager ||
                  !release?.update_available
                }
                onClick={() => setConfirmAction('update')}
              >
                升级并重启
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busySystem || managerRunning || !system.data?.manager}
                onClick={() => setConfirmAction('restart')}
              >
                <RotateCw />
                重启服务
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(open) => {
          if (!open && !busySystem) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'update'
                ? '升级到最新稳定版并重启？'
                : '重启 PicCove 服务？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'update'
                ? '升级期间网站将短暂中断连接。升级操作不会自动创建数据备份，建议提前执行 piccovectl backup。'
                : '重启过程中网站会短暂不可访问，数秒后自动恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busySystem}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busySystem}
              onClick={(e) => {
                e.preventDefault();
                void executeSystemAction();
              }}
            >
              {busySystem ? '正在提交…' : '确认执行'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
