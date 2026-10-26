import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, size, type Account, type Album, type Page } from './api';

type Location = {
  id: string;
  path: string;
  default: boolean;
  count: number;
  used_bytes: number;
  available_bytes: number | null;
  error: string | null;
};
type Job = {
  id: string;
  kind: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
};
type Candidate = { key: string; size: number; signature: string };
const states: Record<string, string> = {
  queued: '等待',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  migration: '迁移',
  cleanup: '清理旧副本',
  import: '导入',
};

export function StorageSettings({ section }: { section: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [user, setUser] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [album, setAlbum] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [detail, setDetail] = useState('');
  const [detailPage, setDetailPage] = useState(1);
  const locations = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () =>
      api<{ items: Location[]; allowed_roots: string[] }>('/storage-locations'),
    refetchInterval: 10000,
  });
  const jobs = useQuery({
    queryKey: ['file-jobs'],
    queryFn: () => api<Job[]>('/file-jobs'),
    refetchInterval: 3000,
  });
  const candidates = useQuery({
    queryKey: ['import-candidates'],
    queryFn: () =>
      api<{ enabled: boolean; items: Candidate[] }>('/import-candidates'),
    enabled: false,
  });
  const users = useQuery({
    queryKey: ['import-users', userPage],
    queryFn: () => api<Page<Account>>(`/admin/users?page=${userPage}`),
  });
  const albums = useQuery({
    queryKey: ['import-albums', user],
    queryFn: () => api<Album[]>(`/import-albums/${user}`),
    enabled: !!user,
  });
  const details = useQuery({
    queryKey: ['file-job', detail, detailPage],
    queryFn: () =>
      api<
        {
          id: string;
          source_key: string;
          status: string;
          error: string | null;
        }[]
      >(`/file-jobs/${detail}?page=${detailPage}`),
    enabled: !!detail,
    refetchInterval: 3000,
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
      await Promise.all([
        client.invalidateQueries({ queryKey: ['storage-locations'] }),
        client.invalidateQueries({ queryKey: ['file-jobs'] }),
      ]);
    }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = new FormData(event.currentTarget).get('path');
    void run(
      () => api('/storage-locations', 'POST', { path }),
      '存储位置已添加',
    );
  }
  const options = locations.data?.items.map((item) => (
    <SelectItem key={item.id} value={item.id}>
      {item.path}
    </SelectItem>
  ));
  return (
    <>
      <Card id="settings-storage" className="cove-settings-card" hidden={section !== 'storage'}>
        <CardContent>
          <div className="cove-settings-title">
            <h2>存储位置</h2>
            <p>默认位置用于保存新上传的图片。更改默认位置不会移动已有图片。</p>
          </div>
          {locations.isPending && <p role="status">正在加载存储位置…</p>}
          {locations.isError && (
            <p role="alert" className="cove-error">
              存储位置加载失败。
              <Button
                variant="outline"
                onClick={() => void locations.refetch()}
              >
                重试
              </Button>
            </p>
          )}
          <ul className="cove-location-list">
            {locations.data?.items.map((item) => (
              <li key={item.id}>
                <div className="cove-location-heading">
                  <code>{item.path}</code>
                  {item.default ? (
                    <Badge variant="primary" appearance="light">
                      默认存储
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy || !!item.error}
                      onClick={() =>
                        void run(
                          () =>
                            api(
                              `/storage-locations/${item.id}/default`,
                              'POST',
                            ),
                          '默认存储已切换',
                        )
                      }
                    >
                      设为默认
                    </Button>
                  )}
                </div>
                <dl className="cove-storage-metrics">
                  <div>
                    <dt>图片数量</dt>
                    <dd>{item.count} 张</dd>
                  </div>
                  <div>
                    <dt>图片占用</dt>
                    <dd>{size(item.used_bytes)}</dd>
                  </div>
                  <div>
                    <dt>磁盘可用空间</dt>
                    <dd>
                      {item.available_bytes === null
                        ? '暂不可用'
                        : size(item.available_bytes)}
                    </dd>
                  </div>
                </dl>
                {item.error && (
                  <p role="alert" className="cove-error">
                    {item.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {locations.data?.items.length === 0 && (
            <p>还没有存储位置，请先添加。</p>
          )}
          <form onSubmit={add} className="cove-settings-section">
            <label htmlFor="storage-path">添加存储位置</label>
            <p id="storage-path-hint" className="cove-muted">
              填写应用内可访问的目录路径，目录须已存在于以下允许范围内。
            </p>
            {locations.data && (
              <div className="cove-storage-roots">
                {locations.data.allowed_roots.map((root) => (
                  <code key={root}>{root}</code>
                ))}
              </div>
            )}
            <div className="cove-settings-input-action">
              <Input
                id="storage-path"
                name="path"
                required
                placeholder="例如 /storage/pictures"
                aria-describedby="storage-path-hint"
              />
              <Button disabled={busy}>添加位置</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card id="settings-migration" className="cove-settings-card" hidden={section !== 'migration'}>
        <CardContent>
          <div className="cove-settings-title">
            <h2>图片迁移</h2>
            <p>
              将原图复制到新位置，校验成功后切换；分享链接保持不变，旧副本暂时保留。
            </p>
          </div>
          <p className="cove-settings-note">
            如果原位置是默认存储，新上传的图片也会改存到目标位置。迁移完成后，可在任务记录中清理旧副本。
          </p>
          <div className="cove-settings-fields">
            <label>
              原存储位置
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger aria-label="原存储位置">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>{options}</SelectContent>
              </Select>
            </label>
            <label>
              目标存储位置
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label="目标存储位置">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>{options}</SelectContent>
              </Select>
            </label>
          </div>
          <div className="cove-actions">
            <Button
              disabled={busy || !source || !target || source === target}
              onClick={() => {
                if (
                  window.confirm(
                    '确认迁移图片？分享链接不变，旧副本保留。如果原位置是默认存储，新上传也会改存到目标位置。',
                  )
                )
                  void run(
                    () =>
                      api('/file-jobs/migrate', 'POST', {
                        source_id: source,
                        target_id: target,
                      }),
                    '迁移任务已创建',
                  );
              }}
            >
              开始迁移
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card id="settings-import" className="cove-settings-card" hidden={section !== 'import'}>
        <CardContent>
          <div className="cove-settings-title">
            <h2>批量导入</h2>
            <p>
              通过 SFTP 将图片传入待导入目录，再扫描并选择要导入的图片。每批最多
              1000 张，导入后保留源文件。
            </p>
          </div>
          <p className="cove-settings-note">
            上传时请使用 .part
            临时后缀，传输完成后改回图片扩展名。同一用户已导入过的相同路径、相同内容图片会自动跳过。
          </p>
          <div className="cove-actions">
            <Button
              variant="outline"
              disabled={candidates.isFetching}
              onClick={() => {
                setChosen([]);
                void candidates.refetch();
              }}
            >
              {candidates.isFetching ? '正在扫描…' : '扫描待导入图片'}
            </Button>
          </div>
          {candidates.isError && <p role="alert">{candidates.error.message}</p>}
          {candidates.data && !candidates.data.enabled && (
            <p>尚未设置导入目录，请先按运维文档挂载待导入目录。</p>
          )}
          {candidates.data?.enabled && (
            <>
              <label>
                导入到用户
                <Select
                  value={user}
                  onValueChange={(value) => {
                    setUser(value);
                    setAlbum('');
                  }}
                >
                  <SelectTrigger aria-label="导入到用户">
                    <SelectValue placeholder="请选择用户" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.data?.items.map(({ user: u }) => (
                      <SelectItem key={u.id} value={u.id} disabled={u.disabled}>
                        {u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {users.isError && <p role="alert">用户列表读取失败。</p>}
              <div className="cove-actions">
                <Button
                  variant="outline"
                  disabled={userPage === 1}
                  onClick={() => {
                    setUserPage(userPage - 1);
                    setUser('');
                    setAlbum('');
                  }}
                >
                  上一页用户
                </Button>
                <Button
                  variant="outline"
                  disabled={!users.data?.has_more}
                  onClick={() => {
                    setUserPage(userPage + 1);
                    setUser('');
                    setAlbum('');
                  }}
                >
                  下一页用户
                </Button>
              </div>
              <label>
                相册{' '}
                <Select
                  value={album || 'none'}
                  onValueChange={(value) =>
                    setAlbum(value === 'none' ? '' : value)
                  }
                >
                  <SelectTrigger aria-label="导入相册">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不放入相册</SelectItem>
                    {albums.data?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {albums.isError && <p role="alert">相册读取失败。</p>}
              <label className="cove-check">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setPublic(e.target.checked)}
                />
                公开导入图片（默认私有）
              </label>
              <Button
                variant="outline"
                onClick={() =>
                  setChosen(
                    chosen.length === candidates.data!.items.length
                      ? []
                      : candidates.data!.items.map((f) => f.key),
                  )
                }
              >
                全选 / 取消
              </Button>
              {candidates.data.items.length === 0 && (
                <p>没有找到可导入的图片。</p>
              )}
              <ul className="cove-import-files">
                {candidates.data.items.map((file) => (
                  <li key={file.key}>
                    <label className="cove-check">
                      <input
                        type="checkbox"
                        checked={chosen.includes(file.key)}
                        onChange={(e) =>
                          setChosen(
                            e.target.checked
                              ? [...chosen, file.key]
                              : chosen.filter((key) => key !== file.key),
                          )
                        }
                      />
                      <span>{file.key}</span>
                      <small>{size(file.size)}</small>
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                disabled={busy || !user || !chosen.length}
                onClick={() =>
                  void run(
                    () =>
                      api('/file-jobs/import', 'POST', {
                        user_id: user,
                        album_id: album || null,
                        is_public: isPublic,
                        files: candidates.data!.items.filter((f) =>
                          chosen.includes(f.key),
                        ),
                      }),
                    '导入任务已创建',
                  )
                }
              >
                导入所选图片（{chosen.length}）
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      <Card id="settings-jobs" className="cove-settings-card" hidden={section !== 'jobs'}>
        <CardContent>
          <div className="cove-settings-title">
            <h2>任务记录</h2>
            <p>查看图片迁移、导入和旧副本清理的进度与结果。</p>
          </div>
          {jobs.isError && <p role="alert">任务状态读取失败，正在重试。</p>}
          {jobs.isPending && <p role="status">正在加载任务…</p>}
          {jobs.data?.length === 0 && (
            <p className="cove-muted">还没有任务记录。</p>
          )}
          <ul className="cove-job-list">
            {jobs.data?.map((job) => (
              <li key={job.id}>
                <div className="cove-location-heading">
                  <h3>{states[job.kind] || job.kind}</h3>
                  <Badge variant="outline">
                    {states[job.status] || job.status}
                  </Badge>
                </div>
                <p className="cove-muted">
                  已完成 {job.completed} / {job.total} · 失败 {job.failed}
                </p>
                <div className="cove-actions">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDetail(job.id);
                      setDetailPage(1);
                    }}
                  >
                    查看结果
                  </Button>
                  {job.status === 'failed' && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api(`/file-jobs/${job.id}/retry`, 'POST'),
                          '已安排重试失败项',
                        )
                      }
                    >
                      重试失败项
                    </Button>
                  )}
                  {job.kind === 'migration' && job.status === 'completed' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            '确认清理这次迁移的旧副本？将再次校验目标原图，只删除本任务记录且未变化的源文件。',
                          )
                        )
                          void run(
                            () => api(`/file-jobs/${job.id}/cleanup`, 'POST'),
                            '旧副本清理任务已创建',
                          );
                      }}
                    >
                      清理旧副本
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {detail && (
            <div className="cove-settings-section">
              <h3>文件处理结果</h3>
              {details.isError && <p role="alert">文件结果读取失败。</p>}
              <ul className="cove-job-results">
                {details.data?.map((item) => (
                  <li key={item.id}>
                    {item.source_key}：{states[item.status]}
                    {item.error && ` — ${item.error}`}
                  </li>
                ))}
              </ul>
              <div className="cove-actions">
                <Button
                  variant="outline"
                  disabled={detailPage === 1}
                  onClick={() => setDetailPage(detailPage - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  disabled={details.data?.length !== 48}
                  onClick={() => setDetailPage(detailPage + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
