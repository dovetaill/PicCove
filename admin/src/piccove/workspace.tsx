import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
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
  QrCode,
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
import { Textarea } from '@/components/ui/textarea';
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
import { ShareQr } from './share-qr';
import { SystemSettings } from './system';
import { UploadProvider, useUploads } from './upload-manager';

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
  const [collapsed, setCollapsed] = useState(false);
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
    <div
      className={`demo1 sidebar-fixed header-fixed cove-workspace${collapsed ? ' sidebar-collapse cove-collapsed' : ''}`}
    >
      <UploadProvider>
        <aside
          id="workspace-navigation"
          className={`sidebar cove-sidebar${menuOpen ? ' is-open' : ''}`}
          aria-label="工作台导航"
        >
          <Brand />
          <span className="cove-nav-label">我的空间</span>
          <nav
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a'))
                setMenuOpen(false);
            }}
          >
            <NavLink to="/app" end aria-label="图片库" title="图片库">
              <Images />
              <span className="cove-nav-text">图片库</span>
            </NavLink>
            <NavLink to="/app/albums" aria-label="相册" title="相册">
              <FolderHeart />
              <span className="cove-nav-text">相册</span>
            </NavLink>
            <NavLink to="/app/account" aria-label="账号设置" title="账号设置">
              <Settings2 />
              <span className="cove-nav-text">账号设置</span>
            </NavLink>
            {user.is_admin && (
              <>
                <span className="cove-nav-label">管理控制台</span>
                <NavLink
                  to="/app/admin/users"
                  aria-label="用户与配额"
                  title="用户与配额"
                >
                  <Users />
                  <span className="cove-nav-text">用户与配额</span>
                </NavLink>
                <NavLink
                  to="/app/admin/images"
                  aria-label="全部图片"
                  title="全部图片"
                >
                  <ShieldCheck />
                  <span className="cove-nav-text">全部图片</span>
                </NavLink>
                <NavLink
                  to="/app/admin/settings"
                  aria-label="系统设置"
                  title="系统设置"
                >
                  <Settings2 />
                  <span className="cove-nav-text">系统设置</span>
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
            <p>网页上传的图片默认公开；私有图片仅本人和管理员可见。</p>
          </div>
        </aside>
        <div className="wrapper cove-workbody">
          <header className="header cove-workheader">
            <Button
              className="cove-collapse-button"
              variant="ghost"
              aria-label={collapsed ? '展开导航' : '收起导航'}
              aria-expanded={!collapsed}
              aria-controls="workspace-navigation"
              onClick={() => setCollapsed(!collapsed)}
            >
              <Menu />
            </Button>
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
      </UploadProvider>
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
  const [copying, setCopying] = useState<Picture[]>([]);
  const [qr, setQr] = useState<Picture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Picture | null>(null);
  const [editAlbum, setEditAlbum] = useState('none');
  const [deleting, setDeleting] = useState<Picture[]>([]);
  const [moveTo, setMoveTo] = useState('none');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const {
    queue,
    busy: uploading,
    retryAfter,
    upload,
    retryFailed,
    clearQueue,
    removeImage,
  } = useUploads();
  const action = useAction();
  const me = useMe();
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
  const activeUpload = queue.find((item) =>
    ['上传中', '服务器处理中'].includes(item.status),
  );
  const firstUploadError = queue.find((item) => item.status === '失败');
  useEffect(() => {
    if (
      !images.isPending &&
      !images.isFetching &&
      !images.isError &&
      page > 1 &&
      !items.length
    ) {
      setPage((current) => current - 1);
      setSelected([]);
    }
  }, [images.isPending, images.isFetching, images.isError, items.length, page]);
  function handleUpload(files: FileList | File[]) {
    if (action.busy) {
      toast.info('正在处理，请稍等片刻再添加图片');
      return;
    }
    upload(files, album);
  }
  function showLinks(pictures: Picture[]) {
    if (pictures.some((item) => item.deleted_at)) {
      toast.error('待清理图片的链接已失效，请取消选择后重试');
      return;
    }
    if (pictures.some((item) => !item.is_public)) {
      toast.error('所选图片中有私有图片。如需分享，请先在安卓端将它设为公开');
      return;
    }
    setCopying(pictures);
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('链接已复制');
    } catch {
      toast.error('未能复制到剪贴板，你可以选中文字手动复制');
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
          tabIndex={0}
          aria-busy={uploading}
          aria-label="上传区域，可粘贴剪贴板图片"
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              handleUpload(event.clipboardData.files);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(!uploading && !action.busy);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleUpload(event.dataTransfer.files);
          }}
        >
          <div className="cove-upload-icon">
            <CloudUpload />
          </div>
          <h2>上传图片</h2>
          <p>
            {uploading || action.busy
              ? '正在处理，请稍等片刻再添加图片'
              : '把图片拖到这里，也可以直接粘贴'}
          </p>
          <div className="cove-upload-actions">
            <Button
              disabled={action.busy || uploading}
              onClick={() => input.current?.click()}
            >
              {uploading || action.busy ? '处理中…' : '选择图片'}
              <CloudUpload />
            </Button>
            <input
              ref={input}
              hidden
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(event) => {
                if (event.target.files) {
                  handleUpload(event.target.files);
                  event.currentTarget.value = '';
                }
              }}
            />
            <Button
              variant="outline"
              disabled={action.busy || uploading}
              onClick={() => folderInput.current?.click()}
            >
              选择文件夹
            </Button>
            <input
              ref={folderInput}
              hidden
              type="file"
              multiple
              {...{ webkitdirectory: '' }}
              onChange={(event) => {
                if (event.target.files) {
                  handleUpload(
                    Array.from(event.target.files).filter((file) =>
                      /\.(jpe?g|png|webp|gif)$/i.test(file.name),
                    ),
                  );
                  event.currentTarget.value = '';
                }
              }}
            />
          </div>
          <small>JPEG / PNG / WebP / GIF · 单张最大 10 MiB · 原图保存</small>
          <small>上传的图片可通过链接访问，管理员也可以查看和删除。</small>
        </div>
      )}
      {!all && queue.length > 0 && (
        <section className="cove-upload-queue" aria-label="上传队列">
          <div className="cove-upload-summary">
            <div role="status">
              <h2>
                {uploading
                  ? '正在上传'
                  : queue.some((item) => item.status === '等待重试')
                    ? '上传已暂停'
                    : '上传结果'}
              </h2>
              <p>
                成功 {queue.filter((item) => item.status === '完成').length} ·
                已存在 {queue.filter((item) => item.status === '已存在').length}{' '}
                · 失败 {queue.filter((item) => item.status === '失败').length} ·
                共 {queue.length} 张
              </p>
            </div>
            {!uploading && (
              <Button
                variant="ghost"
                onClick={clearQueue}
                title="只清除上传记录，不会删除图库中的图片"
              >
                清除上传记录
              </Button>
            )}
          </div>
          {activeUpload && (
            <div className="cove-upload-current" role="status">
              <p>
                {activeUpload.file.name} ·{' '}
                {activeUpload.status === '服务器处理中'
                  ? '图片已传完，正在保存…'
                  : `上传中 ${activeUpload.progress}%`}
              </p>
              <progress
                aria-label="当前图片传输进度"
                max={100}
                value={activeUpload.progress}
              />
            </div>
          )}
          {firstUploadError && (
            <p className="cove-error cove-upload-error" role="alert">
              {firstUploadError.file.name}：{firstUploadError.error}
              <span className="block">
                展开上传明细，可以查看每张图片的结果。
              </span>
            </p>
          )}
          <details className="cove-upload-details">
            <summary>查看上传明细（{queue.length} 项）</summary>
            <ul>
              {queue.map((item) => (
                <li key={item.id}>
                  <div className="cove-upload-file">
                    <span
                      title={item.file.webkitRelativePath || item.file.name}
                    >
                      {item.file.webkitRelativePath || item.file.name}
                    </span>
                    <span
                      className={
                        item.status === '失败' ? 'cove-error' : 'cove-muted'
                      }
                    >
                      {item.status === '上传中'
                        ? `上传中 ${item.progress}%`
                        : item.status === '等待重试'
                          ? '等待重试'
                          : item.status}
                    </span>
                  </div>
                  {['上传中', '服务器处理中'].includes(item.status) && (
                    <progress
                      aria-label={`${item.file.name} 传输进度`}
                      max={100}
                      value={item.progress}
                    />
                  )}
                  {item.status === '服务器处理中' && (
                    <p className="cove-muted">图片已传完，正在保存…</p>
                  )}
                  {item.status === '已存在' && (
                    <p className="cove-muted">
                      图库里已有这张图片，没有重复保存。原来的名称、相册和公开状态都不变。
                    </p>
                  )}
                  {item.image && (
                    <div className="cove-upload-result">
                      <a href={item.image.url} target="_blank" rel="noreferrer">
                        查看原图：{item.image.original_name}
                      </a>
                      <Button
                        variant="outline"
                        disabled={
                          !item.image.is_public || !!item.image.deleted_at
                        }
                        onClick={() => showLinks([item.image!])}
                      >
                        <Copy />
                        复制链接
                      </Button>
                      {!item.image.is_public && (
                        <span className="cove-muted">
                          这张图片仅你和管理员可见。如需分享，请先在安卓端将它设为公开。
                        </span>
                      )}
                    </div>
                  )}
                  {item.error && <p className="cove-error">{item.error}</p>}
                </li>
              ))}
            </ul>
          </details>
          {queue.some((item) => ['失败', '等待重试'].includes(item.status)) && (
            <Button
              variant="outline"
              disabled={uploading || retryAfter > Date.now()}
              onClick={retryFailed}
            >
              {retryAfter > Date.now() ? '请稍候再重试' : '重试未完成项'}
            </Button>
          )}
        </section>
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
          onClick={() => showLinks(chosen)}
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
                  let moved = 0;
                  try {
                    for (const item of chosen) {
                      await api(`/images/${item.id}`, 'PATCH', {
                        original_name: item.original_name,
                        album_id: moveTo === 'none' ? null : moveTo,
                      });
                      moved++;
                      setSelected((ids) => ids.filter((id) => id !== item.id));
                    }
                  } catch (error) {
                    throw new Error(
                      `已移动 ${moved} 张，剩余 ${chosen.length - moved} 张未完成，请重试。${message(error)}`,
                    );
                  }
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
          <h2>
            {page > 1
              ? '本页没有图片'
              : album !== 'all'
                ? '相册里还没有图片'
                : '这里还没有图片'}
          </h2>
          <p>
            {page > 1
              ? '正在返回上一页…'
              : all
                ? '用户上传后，图片会出现在这里。'
                : album !== 'all'
                  ? '可以从其他相册移动图片过来。'
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
                      src={item.thumbnail_url || item.url}
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
                    disabled={!!item.deleted_at}
                    onClick={() => showLinks([item])}
                    aria-label={`复制 ${item.original_name} 链接`}
                  >
                    <Copy />
                    复制
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!item.is_public || !!item.deleted_at}
                    onClick={() => setQr(item)}
                    aria-label={`分享 ${item.original_name} 二维码`}
                  >
                    <QrCode />
                    二维码
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
        open={copying.length > 0}
        onOpenChange={(open) => {
          if (!open) setCopying([]);
        }}
      >
        <DialogContent className="cove-copy-dialog">
          <DialogHeader>
            <DialogTitle>复制图片链接</DialogTitle>
            <DialogDescription>
              {copying.length === 1
                ? copying[0].original_name
                : `已选 ${copying.length} 张图片，每张图片占一行。`}{' '}
              找到需要的格式，点击右侧“复制”即可。
            </DialogDescription>
          </DialogHeader>
          <div className="cove-copy-formats">
            {[
              ['url', '直链'],
              ['markdown', 'Markdown'],
              ['html', 'HTML'],
              ['bbcode', 'BBCode'],
              ['markdown-thumbnail', 'Markdown 缩略图链接'],
              ['html-thumbnail', 'HTML 缩略图链接'],
            ].map(([format, label]) => {
              const text = copying
                .map((item) => imageLink(item, format))
                .join('\n');
              return (
                <div className="cove-copy-format" key={format}>
                  <div>
                    <label htmlFor={`copy-${format}`}>{label}</label>
                    <Button
                      variant="outline"
                      aria-label={`复制 ${label}`}
                      onClick={() => void copy(text)}
                    >
                      <Copy />
                      复制
                    </Button>
                  </div>
                  <Textarea
                    id={`copy-${format}`}
                    readOnly
                    rows={2}
                    value={text}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
      <ShareQr image={qr} onClose={() => setQr(null)} />
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
              删除后无法恢复，之前复制或分享的链接也会失效。重复上传得到的同一图片链接同样会失效；文件清理完成后，所占空间会释放。
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                for (const item of deleting) {
                  try {
                    await api(`/images/${item.id}`, 'DELETE');
                  } finally {
                    // A failed file cleanup can already have invalidated the public link.
                    removeImage(item.id);
                  }
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
        description="管理登录用户名、密码与验证方式。"
      />
      <Card className="cove-account">
        <AccountSecurity />
        <section className="cove-account-section">
          <h2>修改密码</h2>
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
                aria-describedby="new-password-hint"
                maxLength={128}
                required
              />
            </label>
            <p id="new-password-hint" className="cove-muted">
              建议使用至少 12 位的字母、数字和符号组合。
            </p>
            <label>
              动态验证码（开启二步验证后填写）
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
            <p className="cove-muted">修改密码后，所有设备需重新登录。</p>
          </form>
        </section>
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
        title="系统设置"
        description="管理用户注册、图片存储和服务更新。"
      />
      <div className="cove-settings-layout">
        <nav className="cove-settings-nav" aria-label="设置分类">
          <a href="#settings-registration">用户注册</a>
          <a href="#settings-storage">存储位置</a>
          <a href="#settings-migration">图片迁移</a>
          <a href="#settings-import">批量导入</a>
          <a href="#settings-jobs">任务记录</a>
          <a href="#settings-system">版本与服务</a>
        </nav>
        <div className="cove-settings-content">
          <Card id="settings-registration" className="cove-settings-card">
            <CardContent>
              <div className="cove-setting">
                <div>
                  <h2 id="registration-label">允许用户自行注册</h2>
                  <p>关闭后将停止接受新用户注册，已有账号不受影响。</p>
                </div>
                <Switch
                  aria-labelledby="registration-label"
                  checked={settings.data?.registration_open || false}
                  disabled={action.busy || !settings.data}
                  onCheckedChange={(value) =>
                    void action.run(
                      () =>
                        api('/settings', 'PATCH', { registration_open: value }),
                      value ? '已开放注册' : '已关闭注册',
                    )
                  }
                />
              </div>
              <p className="cove-muted">
                自行注册的用户默认获得 1 GiB 存储空间。管理员仍可手动创建账号。
              </p>
              {settings.isError && (
                <p role="alert" className="cove-error">
                  注册设置加载失败，请刷新重试。
                </p>
              )}
            </CardContent>
          </Card>
          <SystemSettings />
        </div>
      </div>
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
                aria-describedby="new-password-hint"
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
