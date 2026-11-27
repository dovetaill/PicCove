import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ExternalLink, RefreshCw, RotateCw, Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
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
  api,
  errorMessage,
  type ReleaseCheck,
  type SystemStatus,
} from '@/lib/api';

export function SystemServiceCard({
  className,
  activeJobsCount,
  refetchInterval = 10000,
}: {
  className?: string;
  activeJobsCount?: number;
  refetchInterval?: number;
}) {
  const client = useQueryClient();
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [release, setRelease] = useState<ReleaseCheck | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    'update' | 'restart' | null
  >(null);

  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemStatus>('/admin/system'),
    refetchInterval,
  });

  const running = system.data?.manager?.state === 'running';

  async function handleCheckRelease() {
    setCheckingRelease(true);
    try {
      const res = await api<ReleaseCheck>('/admin/system/check', 'POST');
      setRelease(res);
      toast.success(
        res.update_available
          ? `发现新版本 ${res.latest}`
          : '当前已是最新稳定版',
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCheckingRelease(false);
    }
  }

  async function executeAction() {
    if (!confirmAction || busyAction) return;
    setBusyAction(true);
    try {
      await api(`/admin/system/${confirmAction}`, 'POST');
      toast.success('任务已提交，请等待服务恢复');
      setConfirmAction(null);
      await client.invalidateQueries({ queryKey: ['system'] });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <>
      <Card className={className}>
        <CardHeader>
          <div>
            <CardTitle>系统服务与版本</CardTitle>
            <CardDescription>
              查询最新 GitHub 稳定发行版，执行宿主机在线升级或重启
            </CardDescription>
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
                {system.data?.version ? `v${system.data.version.replace(/^v/, '')}` : '读取中…'}
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
                    : running
                      ? 'warning'
                      : 'success'
                }
              >
                {system.isPending
                  ? '连接中'
                  : !system.data?.manager
                    ? '未连接'
                    : running
                      ? '正在执行任务'
                      : '已连接'}
              </Badge>
            </div>
          </div>

          {activeJobsCount !== undefined && activeJobsCount > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-xs">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Activity className="size-3.5 text-primary animate-pulse" />
                {activeJobsCount} 个存储迁移/导入任务正在后台运行
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
            <div className="rounded-xl border border-border p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">最新稳定版本：</span>
                <a
                  href={release.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-primary hover:underline inline-flex items-center gap-1 ms-1"
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
                {release.update_available ? '有新版本可用' : '已是最新'}
              </Badge>
            </div>
          )}

          {system.data?.manager_error && (
            <p
              className="text-xs text-muted-foreground rounded-lg bg-muted/60 p-3"
              role="status"
            >
              未检测到宿主机 piccovectl web-manager 服务连接，在线升级与重启按钮暂不可用。
            </p>
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
              disabled={checkingRelease || busyAction || running}
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
                busyAction ||
                running ||
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
              disabled={busyAction || running || !system.data?.manager}
              onClick={() => setConfirmAction('restart')}
            >
              <RotateCw />
              重启服务
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(open) => {
          if (!open && !busyAction) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'update'
                ? '确认升级并重启网站服务？'
                : '确认重启网站服务？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'update'
                ? '升级过程中服务将短暂中断。在线升级不会自动备份数据库与原图，建议提前执行 piccovectl backup。'
                : '重启期间网站将短暂不可访问，数秒后自动恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyAction}
              onClick={(e) => {
                e.preventDefault();
                void executeAction();
              }}
            >
              {busyAction ? '正在提交…' : '确认执行'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
