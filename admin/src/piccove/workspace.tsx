import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CloudUpload,
  Copy,
  FolderHeart,
  Images,
  LogOut,
  Menu,
  Pencil,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  api,
  imageLink,
  size,
  useMe,
  useSettings,
  type Account,
  type Album,
  type Page,
  type Picture,
} from './api';
import { Brand } from './public';
import { AccountSecurity } from './security';

function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败';
}
function useAction() {
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  async function run(action: () => Promise<unknown>, success = '已保存') {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(message(error));
      return false;
    } finally {
      setBusy(false);
      await client.invalidateQueries();
    }
  }
  return { busy, run };
}
export function Workspace() {
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  if (me.isPending)
    return (
      <p className="cove-loading" role="status">
        正在打开图片空间…
      </p>
    );
  if (me.isError)
    return (
      <div className="cove-loading" role="alert">
        加载失败。<Button onClick={() => void me.refetch()}>重试</Button>
      </div>
    );
  if (!me.data) return <Navigate to="/login" replace />;
  const { user, used_bytes } = me.data;
  async function logout() {
    try {
      await api('/auth/logout', 'POST');
      client.clear();
      navigate('/login');
    } catch (error) {
      toast.error(message(error));
    }
  }
  return (
    <div className="demo1 sidebar-fixed header-fixed cove-workspace">
      <aside
        id="workspace-navigation"
        className={`sidebar cove-sidebar${menuOpen ? ' is-open' : ''}`}
        aria-label="工作台导航"
      >
        <Brand />
        <span className="cove-nav-label">我的空间</span>
        <nav
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setMenuOpen(false);
          }}
        >
          <NavLink to="/app" end>
            <Images />
            图片库
          </NavLink>
          <NavLink to="/app/albums">
            <FolderHeart />
            相册
          </NavLink>
          <NavLink to="/app/account">
            <Settings2 />
            账号设置
          </NavLink>
          {user.is_admin && (
            <>
              <span className="cove-nav-label">管理控制台</span>
              <NavLink to="/app/admin/users">
                <Users />
                用户与配额
              </NavLink>
              <NavLink to="/app/admin/images">
                <ShieldCheck />
                全部图片
              </NavLink>
              <NavLink to="/app/admin/settings">
                <Settings2 />
                注册设置
              </NavLink>
            </>
          )}
        </nav>
        <div className="cove-storage">
          <span>存储空间</span>
          <strong>
            {size(used_bytes)} <small>/ {size(user.quota_bytes)}</small>
          </strong>
          <progress
            max={Math.max(user.quota_bytes, 1)}
            value={Math.min(used_bytes, Math.max(user.quota_bytes, 1))}
          />
          <p>Web 上传默认公开；安卓私有图片仅本人及管理员可见。</p>
        </div>
      </aside>
      <div className="wrapper cove-workbody">
        <header className="header cove-workheader">
          <Button
            className="cove-menu-button"
            variant="ghost"
            aria-label={menuOpen ? '关闭导航' : '打开导航'}
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X /> : <Menu />}
          </Button>
          <span>
            工作台 <span className="cove-muted">/ 图湾</span>
          </span>
          <div>
            <span className="cove-avatar">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <span>{user.username}</span>
            <Button
              variant="ghost"
              onClick={() => void logout()}
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <main className="cove-workmain">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
export function AdminOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  return me.data?.user.is_admin ? children : <Navigate to="/app" replace />;
}
function Pager({
  page,
  more,
  change,
}: {
  page: number;
  more: boolean;
  change: (value: number) => void;
}) {
  return (
    <div className="cove-pager">
      <Button
        variant="outline"
        disabled={page === 1}
        onClick={() => change(page - 1)}
      >
        <ArrowLeft />
        上一页
      </Button>
      <span>第 {page} 页</span>
      <Button
        variant="outline"
        disabled={!more}
        onClick={() => change(page + 1)}
      >
        下一页
        <ArrowRight />
      </Button>
    </div>
  );
}
function Heading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="cove-heading">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
export function Gallery({ all = false }: { all?: boolean }) {
  const [page, setPage] = useState(1);
  const [album, setAlbum] = useState('all');
  const [format, setFormat] = useState('url');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Picture | null>(null);
  const [editAlbum, setEditAlbum] = useState('none');
  const [deleting, setDeleting] = useState<Picture[]>([]);
  const [moveTo, setMoveTo] = useState('none');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const action = useAction();
  const me = useMe();
  const client = useQueryClient();
  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });
  const images = useQuery({
    queryKey: ['images', all, album, page],
    queryFn: () =>
      api<Page<Picture>>(
        `/images?page=${page}&all=${all}${album !== 'all' ? `&album_id=${album}` : ''}`,
      ),
  });
  const items = images.data?.items || [];
  const chosen = items.filter((item) => selected.includes(item.id));
  async function upload(files: FileList | File[]) {
    if (uploading.current || action.busy || !files.length) return;
    uploading.current = true;
    let count = 0;
    await action.run(async () => {
      const errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          if (!file.size || file.size > 10 * 1024 * 1024)
            throw new Error('单张图片须为 1 字节至 10 MiB');
          const body = new FormData();
          body.append('file', file);
          const result = await api<Picture>('/images', 'POST', body);
          count++;
          if (album !== 'all')
            await api(`/images/${result.id}`, 'PATCH', {
              original_name: result.original_name,
              album_id: album,
            });
        } catch (error) {
          errors.push(`${file.name}：${message(error)}`);
        }
      }
      setPage(1);
      setSelected([]);
      if (errors.length)
        throw new Error(`已上传 ${count} 张。${errors.join('；')}`);
    }, '图片上传完成');
    uploading.current = false;
    if (input.current) input.current.value = '';
    await client.invalidateQueries({ queryKey: ['images'] });
  }
  async function copy(pictures: Picture[]) {
    if (pictures.some((item) => !item.is_public)) {
      toast.error('私有图片不能复制公开链接，请先在安卓端确认公开分享');
      return;
    }
    try {
      await navigator.clipboard.writeText(
        pictures.map((item) => imageLink(item, format)).join('\n'),
      );
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败，请在 HTTPS 下使用，或打开图片手动复制地址');
    }
  }
  const albumOptions = (
    <>
      <SelectItem value="none">不放入相册</SelectItem>
      {albums.data?.map((item) => (
        <SelectItem key={item.id} value={item.id}>
          {item.name}
        </SelectItem>
      ))}
    </>
  );
  return (
    <>
      <Heading
        title={all ? '全部图片' : '我的图片库'}
        description={
          all
            ? '管理全部用户的托管图片。删除后外链失效，请谨慎操作。'
            : '每一份灵感，都值得好好收藏。'
        }
      />
      {!all && (
        <div
          className={`cove-drop ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files);
          }}
        >
          <div className="cove-upload-icon">
            <CloudUpload />
          </div>
          <h2>把图片放进你的港湾</h2>
          <p>拖拽到此处，或选择图片上传</p>
          <Button disabled={action.busy} onClick={() => input.current?.click()}>
            {action.busy ? '处理中…' : '选择图片'}
            <CloudUpload />
          </Button>
          <input
            ref={input}
            hidden
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files);
            }}
          />
          <small>JPEG / PNG / WebP / GIF · 单张最大 10 MiB · 原图保存</small>
          <small>持有链接即可访问；管理员可查看和删除图片。</small>
        </div>
      )}
      <div className="cove-toolbar">
        <div>
          <h2>
            {all ? '托管图片' : '图片'} <span>{items.length}</span>
          </h2>
          {!all && (
            <Select
              value={album}
              onValueChange={(value) => {
                setAlbum(value);
                setPage(1);
                setSelected([]);
              }}
            >
              <SelectTrigger aria-label="筛选相册">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部相册</SelectItem>
                {albums.data?.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <Select value={format} onValueChange={setFormat}>
          <SelectTrigger aria-label="复制格式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="url">直链</SelectItem>
            <SelectItem value="markdown">Markdown</SelectItem>
            <SelectItem value="html">HTML</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {albums.isError && !all && (
        <p role="alert" className="cove-error">
          相册加载失败，请刷新重试。
        </p>
      )}
      <div className="cove-batch">
        <label className="cove-check">
          <input
            type="checkbox"
            checked={items.length > 0 && chosen.length === items.length}
            onChange={(event) =>
              setSelected(
                event.target.checked ? items.map((item) => item.id) : [],
              )
            }
          />
          选择本页
        </label>
        <span>已选 {chosen.length} 张</span>
        <Button
          variant="outline"
          disabled={!chosen.length}
          onClick={() => void copy(chosen)}
        >
          <Copy />
          复制链接
        </Button>
        <Button
          variant="outline"
          disabled={!chosen.length || action.busy}
          onClick={() => setDeleting(chosen)}
        >
          <Trash2 />
          删除
        </Button>
        {!all && (
          <>
            <Select value={moveTo} onValueChange={setMoveTo}>
              <SelectTrigger aria-label="批量移动到相册">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{albumOptions}</SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={!chosen.length || action.busy}
              onClick={() =>
                void action.run(async () => {
                  for (const item of chosen)
                    await api(`/images/${item.id}`, 'PATCH', {
                      original_name: item.original_name,
                      album_id: moveTo === 'none' ? null : moveTo,
                    });
                  setSelected([]);
                }, '已移动图片')
              }
            >
              移动
            </Button>
          </>
        )}
      </div>
      {images.isPending ? (
        <p role="status">正在读取图库…</p>
      ) : images.isError ? (
        <p role="alert" className="cove-error">
          {message(images.error)}{' '}
          <Button onClick={() => void images.refetch()}>重试</Button>
        </p>
      ) : !items.length ? (
        <div className="cove-empty">
          <Images />
          <h2>这里还没有图片</h2>
          <p>
            {all
              ? '用户上传后，图片会出现在这里。'
              : '上传第一张图片，开始收藏你的灵感。'}
          </p>
        </div>
      ) : (
        <div className="cove-gallery">
          {items.map((item) => (
            <Card key={item.id} className="cove-image">
              <div className="cove-image-preview">
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.deleted_at ? (
                    <span>待清理 · 请重试删除</span>
                  ) : (
                    <img
                      src={item.url}
                      alt={item.original_name}
                      loading="lazy"
                    />
                  )}
                </a>
                <input
                  aria-label={`选择 ${item.original_name}`}
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
              </div>
              <CardContent>
                <h3 title={item.original_name}>{item.original_name}</h3>
                {!item.is_public && <small>私有 · 本人及管理员可见</small>}
                <p>
                  {item.width} × {item.height}
                  <span>{size(item.size_bytes)}</span>
                </p>
                {all && (
                  <small className="cove-owner" title={item.user_id}>
                    用户 {item.user_id}
                  </small>
                )}
                <div className="cove-image-actions">
                  <Button
                    variant="ghost"
                    onClick={() => void copy([item])}
                    aria-label={`复制 ${item.original_name} 链接`}
                  >
                    <Copy />
                    复制
                  </Button>
                  {item.user_id === me.data?.user.id && !item.deleted_at && (
                    <Button
                      variant="ghost"
                      aria-label={`编辑 ${item.original_name}`}
                      onClick={() => {
                        setEditing(item);
                        setEditAlbum(item.album_id || 'none');
                      }}
                    >
                      <Pencil />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={`删除 ${item.original_name}`}
                    disabled={action.busy}
                    onClick={() => setDeleting([item])}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Pager
        page={page}
        more={images.data?.has_more || false}
        change={(value) => {
          setPage(value);
          setSelected([]);
        }}
      />
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>整理图片</DialogTitle>
            <DialogDescription>
              修改名称和相册不会改变图片外链。
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              className="cove-form"
              onSubmit={(event) => {
                event.preventDefault();
                const name = new FormData(event.currentTarget).get('name');
                void action.run(async () => {
                  await api(`/images/${editing.id}`, 'PATCH', {
                    original_name: name,
                    album_id: editAlbum === 'none' ? null : editAlbum,
                  });
                  setEditing(null);
                });
              }}
            >
              <label>
                展示名称
                <Input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={editing.original_name}
                />
              </label>
              <label>
                相册
                <Select value={editAlbum} onValueChange={setEditAlbum}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>{albumOptions}</SelectContent>
                </Select>
              </label>
              <Button type="submit" disabled={action.busy}>
                保存
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting.length}
        onOpenChange={(open) => {
          if (!open && !action.busy) setDeleting([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {deleting.length} 张图片？</DialogTitle>
            <DialogDescription>
              文件将被永久删除，原外链失效，无法恢复。成功清理文件后释放容量。
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                for (const item of deleting) {
                  await api(`/images/${item.id}`, 'DELETE');
                  setDeleting((current) =>
                    current.filter((row) => row.id !== item.id),
                  );
                }
                setSelected([]);
              }, '图片已删除')
            }
          >
            {action.busy ? '正在删除…' : '确认永久删除'}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
export function Albums() {
  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });
  const action = useAction();
  const [deleting, setDeleting] = useState<Album | null>(null);
  return (
    <>
      <Heading
        title="我的相册"
        description="按文章、项目或灵感分类，让图片更好找。"
      />
      <Card>
        <CardContent>
          <form
            className="cove-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const name = new FormData(form).get('name');
              void action.run(async () => {
                await api('/albums', 'POST', { name });
                form.reset();
              }, '相册已创建');
            }}
          >
            <Input
              name="name"
              aria-label="新相册名称"
              required
              maxLength={100}
              placeholder="给新相册起个名字"
            />
            <Button type="submit" disabled={action.busy}>
              创建相册
            </Button>
          </form>
        </CardContent>
      </Card>
      {albums.isPending && <p role="status">正在加载…</p>}
      {albums.isError && (
        <p role="alert" className="cove-error">
          {message(albums.error)}
        </p>
      )}
      <div className="cove-albums">
        {albums.data?.map((album) => (
          <Card key={album.id}>
            <CardContent>
              <FolderHeart />
              <h2>{album.name}</h2>
              <Button variant="outline" onClick={() => setDeleting(album)}>
                <Trash2 />
                删除相册
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {albums.data?.length === 0 && (
        <p className="cove-empty">暂无相册。创建后可在图片库中移动图片。</p>
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除相册“{deleting?.name}”？</DialogTitle>
            <DialogDescription>
              相册内的图片会保留，外链不受影响。
            </DialogDescription>
          </DialogHeader>
          <Button
            disabled={action.busy}
            variant="destructive"
            onClick={() =>
              void action.run(async () => {
                await api(`/albums/${deleting?.id}`, 'DELETE');
                setDeleting(null);
              }, '相册已删除，图片已保留')
            }
          >
            确认删除相册
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
export function AccountSettings() {
  const action = useAction();
  const navigate = useNavigate();
  return (
    <>
      <Heading
        title="账号设置"
        description="修改密码后，所有设备需重新登录。"
      />
      <AccountSecurity />
      <Card className="cove-narrow">
        <CardContent>
          <form
            className="cove-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                await api('/me/password', 'POST', {
                  current_password: form.get('current'),
                  password: form.get('password'),
                  code: form.get('code') || '',
                });
                navigate('/login');
              }, '密码已更新，请重新登录');
            }}
          >
            <label>
              当前密码
              <Input
                name="current"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              新密码
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label>
              动态验证码（已开启二步验证时必填）
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
              />
            </label>
            <Button disabled={action.busy} type="submit">
              更新密码
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
export function RegistrationSettings() {
  const settings = useSettings();
  const action = useAction();
  return (
    <>
      <Heading
        title="注册设置"
        description="控制新用户是否可以自行创建账号。"
      />
      <Card>
        <CardContent>
          <div className="cove-setting">
            <div>
              <h2 id="registration-label">开放普通用户注册</h2>
              <p>关闭后隐藏注册入口并拒绝注册请求，已有账号仍可正常使用。</p>
            </div>
            <Switch
              aria-labelledby="registration-label"
              checked={settings.data?.registration_open || false}
              disabled={action.busy || !settings.data}
              onCheckedChange={(value) =>
                void action.run(
                  () => api('/settings', 'PATCH', { registration_open: value }),
                  value ? '已开放注册' : '已关闭注册',
                )
              }
            />
          </div>
          <p className="cove-muted">
            自助注册用户默认获得 1 GiB 容量。管理员始终可以手动创建账号。
          </p>
          {settings.isError && (
            <p role="alert" className="cove-error">
              注册设置加载失败，请刷新重试。
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
export function UserManagement() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Account | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [create, setCreate] = useState(false);
  const action = useAction();
  const users = useQuery({
    queryKey: ['users', page],
    queryFn: () => api<Page<Account>>(`/admin/users?page=${page}`),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action.run(async () => {
      if (create)
        await api('/admin/users', 'POST', {
          username: form.get('username'),
          password: form.get('password'),
        });
      else if (editing)
        await api(`/admin/users/${editing.user.id}`, 'PATCH', {
          quota_bytes: Math.round(Number(form.get('quota')) * 1024 * 1024),
          disabled,
          password: form.get('password') || null,
        });
      setCreate(false);
      setEditing(null);
    });
  }
  return (
    <>
      <Heading
        title="用户与配额"
        description="管理账号、容量和访问权限。禁用账号保留已有图片与外链。"
      />
      <Button onClick={() => setCreate(true)}>
        <Users />
        创建用户
      </Button>
      <Card className="cove-user-table">
        <CardContent>
          {users.isPending ? (
            <p role="status">正在加载用户…</p>
          ) : users.isError ? (
            <p role="alert" className="cove-error">
              {message(users.error)}
            </p>
          ) : (
            <div className="cove-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>状态</th>
                    <th>已用 / 配额</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data?.items.map((account) => (
                    <tr key={account.user.id}>
                      <td>
                        <strong>{account.user.username}</strong>
                        {account.user.is_admin && <small>管理员</small>}
                      </td>
                      <td>
                        <span
                          className={`cove-status ${account.user.disabled ? 'is-disabled' : ''}`}
                        >
                          {account.user.disabled ? '已禁用' : '正常'}
                        </span>
                      </td>
                      <td>
                        {size(account.used_bytes)} /{' '}
                        {size(account.user.quota_bytes)}
                      </td>
                      <td>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setEditing(account);
                            setDisabled(account.user.disabled);
                          }}
                        >
                          管理
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <Pager
        page={page}
        more={users.data?.has_more || false}
        change={setPage}
      />
      <Dialog
        open={create || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreate(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {create ? '创建用户' : `管理 ${editing?.user.username}`}
            </DialogTitle>
            <DialogDescription>
              {create
                ? '新用户默认获得 1 GiB 容量。请通过可信渠道交付账号。'
                : '重置密码或禁用账号会撤销现有登录。降低配额不删除图片。'}
            </DialogDescription>
          </DialogHeader>
          <form className="cove-form" onSubmit={submit}>
            {create ? (
              <label>
                用户名
                <Input
                  name="username"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]+"
                  autoComplete="off"
                />
              </label>
            ) : (
              <>
                <label>
                  容量配额（MiB）
                  <Input
                    name="quota"
                    type="number"
                    required
                    min={0}
                    max={8583068847}
                    step="any"
                    defaultValue={
                      (editing?.user.quota_bytes || 0) / 1024 / 1024
                    }
                  />
                </label>
                <label className="cove-setting">
                  禁用账号
                  <Switch
                    checked={disabled}
                    disabled={editing?.user.is_admin}
                    onCheckedChange={setDisabled}
                    aria-label="禁用账号"
                  />
                </label>
              </>
            )}
            <label>
              {create ? '初始密码' : '重置密码（留空保留原密码）'}
              <Input
                name="password"
                type="password"
                required={create}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <Button type="submit" disabled={action.busy}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
