import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
        ? '确认升级到最新稳定版本并重启？网站会短暂不可用。升级不会自动备份，失败也不会自动回退，请先备份需要保留的数据。'
        : '重启网站服务？期间网站会短暂不可用。';
    if (!window.confirm(prompt)) return;
    void run(
      () => api(`/admin/system/${action}`, 'POST'),
      '任务已提交，请等待服务恢复',
    );
  }
  const running = system.data?.manager?.state === 'running';
  return (
    <>
      <StorageSettings />
      <Card id="settings-system" className="cove-settings-card">
        <CardContent>
          <div className="cove-settings-title">
            <h2>版本与服务</h2>
            <p>检查新版本，或重启网站服务。</p>
          </div>
          <dl className="cove-storage-metrics">
            <div>
              <dt>当前版本</dt>
              <dd>{system.data?.version || '读取中…'}</dd>
            </div>
            <div>
              <dt>管理服务</dt>
              <dd>
                <Badge variant="outline">
                  {system.isPending
                    ? '连接中'
                    : !system.data?.manager
                      ? '未连接'
                      : running
                        ? '正在处理任务'
                        : '已连接'}
                </Badge>
              </dd>
            </div>
          </dl>
          {system.isError && (
            <p role="status">
              暂时无法读取服务状态，正在重试。若刚执行了升级或重启，请稍后刷新。
            </p>
          )}
          {release && (
            <p>
              最新稳定版本：
              <a href={release.url} target="_blank" rel="noreferrer">
                {release.latest}
              </a>{' '}
              · {release.update_available ? '有新版本可用' : '无需升级'}
            </p>
          )}
          {system.data?.manager_error && (
            <p role="status" className="cove-settings-note">
              管理服务未连接，暂时无法升级或重启。请在服务器上检查 piccovectl
              web-manager 的运行状态；配置方法见运维文档。
            </p>
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
              检查更新
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
    </>
  );
}
