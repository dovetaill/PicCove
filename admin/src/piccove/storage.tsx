import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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

export function StorageSettings() {
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
      '存储位置已登记',
    );
  }
  const options = locations.data?.items.map((item) => (
    <SelectItem key={item.id} value={item.id}>
      {item.path}
    </SelectItem>
  ));
  return (
    <>
      <Card>
        <CardContent>
          <h2>存储位置</h2>
          <p>
            仅可登记允许根目录内已存在的目录。切换默认存储只影响新上传；原图及分享地址不变。
          </p>
          <p>
            允许根目录：{locations.data?.allowed_roots.join('、') || '读取中…'}
          </p>
          {locations.isError && (
            <p role="alert">
              存储加载失败。
              <Button onClick={() => void locations.refetch()}>重试</Button>
            </p>
          )}
          <ul>
            {locations.data?.items.map((item) => (
              <li key={item.id}>
                <strong>
                  {item.path}
                  {item.default && '（默认）'}
                </strong>{' '}
                · {item.count} 张 · {size(item.used_bytes)} · 可用{' '}
                {item.available_bytes === null
                  ? '未知'
                  : size(item.available_bytes)}
                {item.error && <p role="alert">{item.error}</p>}
                {!item.default && (
                  <Button
                    variant="outline"
                    disabled={busy || !!item.error}
                    onClick={() =>
                      void run(
                        () =>
                          api(`/storage-locations/${item.id}/default`, 'POST'),
                        '默认存储已切换',
                      )
                    }
                  >
                    设为默认
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <form onSubmit={add}>
            <label htmlFor="storage-path">新增存储目录</label>
            <Input
              id="storage-path"
              name="path"
              required
              placeholder="/storage/pictures"
            />
            <Button disabled={busy}>登记目录</Button>
          </form>
          <h3>迁移原图</h3>
          <p>
            逐张复制并校验后切换位置，保留旧副本；源目录若为默认存储，新上传会先切换到目标目录。迁移完成后可单独清理旧副本。
          </p>
          <label>
            源目录{' '}
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger aria-label="源目录">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>{options}</SelectContent>
            </Select>
          </label>
          <label>
            目标目录{' '}
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label="目标目录">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>{options}</SelectContent>
            </Select>
          </label>
          <Button
            disabled={busy || !source || !target || source === target}
            onClick={() => {
              if (
                window.confirm(
                  '开始迁移？分享地址不变，旧副本保留；源目录为默认存储时会切换默认存储。',
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
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <h2>SFTP 图片导入</h2>
          <p>
            先用 SFTP
            上传到独立待导入目录，上传完成后改回图片扩展名。导入保留源文件，每批最多
            1000 张，重复导入同一用户的同路径同内容图片会跳过。
          </p>
          <Button
            variant="outline"
            disabled={candidates.isFetching}
            onClick={() => {
              setChosen([]);
              void candidates.refetch();
            }}
          >
            扫描待导入目录
          </Button>
          {candidates.isError && <p role="alert">{candidates.error.message}</p>}
          {candidates.data && !candidates.data.enabled && (
            <p>尚未配置待导入目录，请按运维文档设置只读挂载。</p>
          )}
          {candidates.data?.enabled && (
            <>
              <label>
                归属用户{' '}
                <Select
                  value={user}
                  onValueChange={(value) => {
                    setUser(value);
                    setAlbum('');
                  }}
                >
                  <SelectTrigger aria-label="归属用户">
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
              <label>
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
              <ul>
                {candidates.data.items.map((file) => (
                  <li key={file.key}>
                    <label>
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
                      {file.key} · {size(file.size)}
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
      <Card>
        <CardContent>
          <h2>最近任务</h2>
          {jobs.isError && <p role="alert">任务状态读取失败，正在重试。</p>}
          <ul>
            {jobs.data?.map((job) => (
              <li key={job.id}>
                {states[job.kind]} · {states[job.status]} · 完成 {job.completed}
                /{job.total} · 失败 {job.failed}
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
              </li>
            ))}
          </ul>
          {detail && (
            <div>
              <h3>文件结果</h3>
              {details.isError && <p role="alert">文件结果读取失败。</p>}
              <ul>
                {details.data?.map((item) => (
                  <li key={item.id}>
                    {item.source_key}：{states[item.status]}
                    {item.error && ` — ${item.error}`}
                  </li>
                ))}
              </ul>
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
          )}
        </CardContent>
      </Card>
    </>
  );
}
