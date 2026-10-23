import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from './api';
import { StorageSettings } from './storage';

type System = {
  version: string;
  manager: { state: string; message?: string } | null;
  manager_error: string | null;
};
type Release = { latest: string; update_available: boolean; url: string };

export function SystemSettings() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [release, setRelease] = useState<Release | null>(null);
  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api<System>('/admin/system'),
    refetchInterval: 5000,
  });
  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: ['system'] });
    }
  }
  function operate(action: 'update' | 'restart') {
    const prompt =
      action === 'update'
        ? '升级到最新稳定版本并重启？期间网站会短暂不可用；不自动备份，升级失败不自动回退。请确认已按需备份。'
        : '重启网站服务？期间网站会短暂不可用。';
    if (!window.confirm(prompt)) return;
    void run(
      () => api(`/admin/system/${action}`, 'POST'),
      '任务已提交，请等待服务恢复',
    );
  }
  const running = system.data?.manager?.state === 'running';
  return (
    <div className="cove-system-settings">
      <StorageSettings />
      <Card>
        <CardContent>
          <h2>版本与升级</h2>
          <p>当前运行版本：{system.data?.version || '读取中…'}</p>
          {system.isError && (
            <p role="status">
              暂时无法连接服务，正在重试；若长时间未恢复，请检查宿主机管理日志。
            </p>
          )}
          {release && (
            <p>
              最新稳定版本：
              <a href={release.url} target="_blank" rel="noreferrer">
                {release.latest}
              </a>{' '}
              · {release.update_available ? '可升级' : '当前已是最新版本或更新'}
            </p>
          )}
          {system.data?.manager_error && (
            <p role="status">{system.data.manager_error}</p>
          )}
          {system.data?.manager?.message && (
            <p role="status">{system.data.manager.message}</p>
          )}
          <div className="cove-actions">
            <Button
              disabled={busy || running}
              variant="outline"
              onClick={() =>
                void run(
                  async () =>
                    setRelease(
                      await api<Release>('/admin/system/check', 'POST'),
                    ),
                  '版本检查完成',
                )
              }
            >
              检测最新版本
            </Button>
            <Button
              disabled={
                busy ||
                running ||
                !system.data?.manager ||
                !release?.update_available
              }
              onClick={() => operate('update')}
            >
              升级并重启
            </Button>
            <Button
              disabled={busy || running || !system.data?.manager}
              variant="outline"
              onClick={() => operate('restart')}
            >
              重启服务
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
