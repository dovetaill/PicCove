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
  MoreHorizontal,
  Pencil,
  QrCode,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  useNavigate,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  api,
  imageLink,
  latestPictures,
  sharingProblem,
  size,
  useMe,
  useSettings,
  type Account,
  type Album,
  type Page,
  type Picture,
} from './api';
import { Brand } from './public';
import { AiSettings, UserModerationControls, reviewLabels } from './ai';
import { AccountProfile, AccountSecurity, type PendingTotp } from './security';
import { ShareQr } from './share-qr';
import { SystemSettings } from './system';
import { UploadProvider, useUploads } from './upload-manager';

const linkFormats = [
  ['url', '图片地址（直链）'],
  ['markdown', 'Markdown 外链'],
  ['html', 'HTML 外链'],
  ['bbcode', 'BBCode 外链'],
  ['markdown-thumbnail', 'Markdown 缩略图链接'],
  ['html-thumbnail', 'HTML 缩略图链接'],
];

function BatchLinks({
  pictures,
  onCopy,
  refreshing,
}: {
  pictures: Picture[];
  onCopy: (text: string) => Promise<unknown>;
  refreshing: boolean;
}) {
  const [format, setFormat] = useState('url');
  const shareable = pictures.filter((item) => !sharingProblem(item));
  const text = shareable.map((item) => imageLink(item, format)).join('\n');
  return (
    <div className="cove-batch-links">
      <div className="cove-batch-links-toolbar">
        <Select value={format} onValueChange={setFormat}>
          <SelectTrigger aria-label="批量链接格式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {linkFormats.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>{shareable.length} 个链接 · 每行一张</span>
        <Button
          variant="outline"
          disabled={refreshing || !shareable.length}
          onClick={() => void onCopy(text)}
        >
          <Copy />
          复制全部链接
        </Button>
      </div>
      {shareable.length !== pictures.length && (
        <p className="cove-muted">
          已跳过 {pictures.length - shareable.length}{' '}
          张不可分享图片（私有、待清理或审核限制），公开状态保持不变。
        </p>
      )}
      {pictures.length === 1 && sharingProblem(pictures[0]) && (
        <p role="status">{sharingProblem(pictures[0])}</p>
      )}
      <Textarea
        aria-label="批量图片链接"
        readOnly
        rows={Math.min(6, Math.max(2, shareable.length))}
        value={text}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}

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
  const me = useMe();
  if (me.isPending) return <p className="cove-loading" role="status">正在打开图片空间…</p>;
  if (me.isError && !me.data) return <div className="cove-loading" role="alert">加载失败。<Button onClick={() => void me.refetch()}>重试</Button></div>;
  if (!me.data) return <Navigate to="/login" replace />;
  return <UploadProvider key={me.data.user.id} owner={me.data.user.id}><WorkspaceContent account={me.data} /></UploadProvider>;
}
function WorkspaceContent({ account }: { account: Account }) {
  const { prepareLeave, resetLeave } = useUploads();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (location.pathname === '/app/ai') setCollapsed(true);
  }, [location.pathname]);
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user, used_bytes } = account;
  async function logout() {
    if (!(await prepareLeave())) return;
    try {
      await api('/auth/logout', 'POST');
      client.clear();
      navigate('/login');
    } catch (error) {
      resetLeave();
      toast.error(message(error));
    }
  }
  return (
    <div
      className={`demo1 sidebar-fixed header-fixed cove-workspace${collapsed ? ' sidebar-collapse cove-collapsed' : ''}`}
    >
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
            <NavLink to="/app/ai" aria-label="AI 图片对话" title="AI 图片对话">
              <Images />
              <span className="cove-nav-text">AI 图片对话</span>
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
                <NavLink to="/app/admin/reviews" aria-label="图片审核" title="图片审核">
                  <ShieldCheck />
                  <span className="cove-nav-text">图片审核</span>
                </NavLink>
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
            {user.content_ban && (
              <p role="alert">账号因内容违规已封禁（累计 {user.violation_count} 次），不能上传、生图或新增公开分享。请联系管理员。</p>
            )}
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
  disabled = false,
}: {
  page: number;
  more: boolean;
  change: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="cove-pager">
      <Button
        variant="outline"
        disabled={disabled || page === 1}
        onClick={() => change(page - 1)}
      >
        <ArrowLeft />
        上一页
      </Button>
      <span>第 {page} 页</span>
      <Button
        variant="outline"
        disabled={disabled || !more}
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
  const [searchParams] = useSearchParams();
  const album = all ? 'all' : (searchParams.get('album') || 'all').toLowerCase();
  const [uploadAlbum, setUploadAlbum] = useState(album);
  const invalidAlbum =
    album !== 'all' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(album);
  const [copying, setCopying] = useState<Picture[]>([]);
  const [qr, setQr] = useState<Picture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Picture | null>(null);
  const [editAlbum, setEditAlbum] = useState('none');
  const [deleting, setDeleting] = useState<Picture[]>([]);
  const [moveTo, setMoveTo] = useState('none');
  const [moving, setMoving] = useState(false);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [picking, setPicking] = useState(false);
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
    removePending,
    stopWaiting,
    ready: uploadsReady,
    storageError,
    updateImages,
  } = useUploads();
  const action = useAction();
  const me = useMe();
  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });
  const images = useQuery({
    queryKey: ['images', all, picking ? 'all' : album, page],
    enabled: !invalidAlbum,
    queryFn: () =>
      api<Page<Picture>>(
        `/images?page=${page}&all=${all}${album !== 'all' && !picking ? `&album_id=${encodeURIComponent(album)}` : ''}`,
      ),
    refetchInterval: (query) => query.state.data?.items.some((item) =>
      ['pending', 'running'].includes(item.moderation_status),
    ) ? 5000 : false,
  });
  const missingAlbum =
    invalidAlbum ||
    (album !== 'all' &&
      albums.isSuccess &&
      !albums.data.some((item) => item.id === album));
  const items = images.data?.items || [];
  const chosen = items.filter((item) => selected.includes(item.id));
  const uploaded = queue.flatMap((item) => item.image ? [items.find((image) => image.id === item.image!.id) || item.image] : []);
  const currentAlbum = albums.data?.find((item) => item.id === album);
  const invalidUploadAlbum = uploadAlbum !== 'all' && (!/^[0-9a-f-]{36}$/.test(uploadAlbum) || (albums.isSuccess && !albums.data.some((item) => item.id === uploadAlbum)));
  const links = useQuery({
    queryKey: ['image-links', all, copying.map((item) => item.id)],
    enabled: copying.length > 0,
    queryFn: ({ signal }) => latestPictures(copying, all, signal),
    refetchInterval: (query) => query.state.data?.some((item) => ['pending', 'running'].includes(item.moderation_status)) ? 5000 : false,
  });
  const selectable = items.filter((item) => !picking || (!item.deleted_at && item.album_id !== album));
  const activeUpload = queue.find((item) =>
    ['上传中', '服务器处理中', '核对结果'].includes(item.status),
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
  useEffect(() => {
    setPage(1);
    setSelected([]);
    setPicking(false);
    setUploadAlbum(album);
  }, [album]);
  useEffect(() => {
    if (all || picking) return;
    const paste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      if (document.querySelector('[role="dialog"]') || !event.clipboardData?.files.length) return;
      event.preventDefault();
      handleUpload(event.clipboardData.files);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  });
  function handleUpload(files: FileList | File[]) {
    if (action.busy) {
      toast.info('正在处理，请稍等片刻再添加图片');
      return;
    }
    if (invalidUploadAlbum) {
      toast.error('该相册已不存在或无权访问，请重新选择相册后上传');
      return;
    }
    if (uploadAlbum !== 'all' && (!albums.isSuccess || albums.isFetching)) {
      toast.error('请等待相册加载成功后再上传');
      return;
    }
    upload(files, uploadAlbum);
  }
  function showLinks(pictures: Picture[]) {
    setCopying(pictures);
  }
  async function copyDirect(pictures: Picture[]) {
    try {
      const current = await latestPictures(pictures, all);
      updateImages(current);
      if (current.some((item) => sharingProblem(item)) || !(await copy(current.map((item) => item.url).join('\n')))) showLinks(current);
    } catch { showLinks(pictures); }
  }
  async function movePictures(pictures: Picture[], destination: string) {
    const ok = await action.run(async () => {
      let moved = 0;
      try {
        for (const item of pictures) {
          await api(`/images/${item.id}`, 'PATCH', {
            original_name: item.original_name,
            album_id: destination === 'none' ? null : destination,
          });
          updateImages([{ ...item, album_id: destination === 'none' ? null : destination }]);
          moved++;
          setSelected((ids) => ids.filter((id) => id !== item.id));
        }
      } catch (error) {
        throw new Error(`已${destination === 'none' ? '移出' : '移动'} ${moved} 张，剩余 ${pictures.length - moved} 张未完成，请重试。${message(error)}`);
      }
    }, destination === 'none' ? '已移出相册，图片和外链已保留' : '已移动图片，外链保持不变');
    if (ok) {
      setMoving(false);
      if (picking) { setPicking(false); setPage(1); }
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('链接已复制');
      return true;
    } catch {
      toast.error('未能复制到剪贴板，你可以选中文字手动复制');
      return false;
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
        title={all ? '全部图片' : picking ? `从图库移入「${currentAlbum?.name || '相册'}」` : currentAlbum?.name || '我的图片库'}
        description={
          all
            ? '管理全部用户的托管图片。删除后外链失效，请谨慎操作。'
            : picking ? '每张图片只属于一个相册；移入会离开原相册，原图和外链保持不变。' : currentAlbum ? currentAlbum.description || '上传到此相册，或从图库移入已有图片。' : '上传图片、整理相册，随时复制分享链接。'
        }
      />
      {!all && album !== 'all' && (
        <div className="cove-album-navigation">
          <Link to="/app/albums"><ArrowLeft size={16} /> 返回相册</Link>
          {picking ? (
            <Button variant="outline" disabled={action.busy} onClick={() => { setPicking(false); setPage(1); setSelected([]); }}>取消移入</Button>
          ) : (
            <Button variant="outline" disabled={action.busy || !currentAlbum} onClick={() => { setPicking(true); setPage(1); setSelected([]); }}>从图库移入</Button>
          )}
        </div>
      )}
      {!all && !picking && (
        <div
          className={`cove-drop ${dragging ? 'is-dragging' : ''}`}
          tabIndex={0}
          aria-busy={uploading}
          aria-label="上传区域，可粘贴剪贴板图片"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(!action.busy);
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
            {uploading ? '正在上传，可以继续添加图片' : '拖入图片，或在本页直接粘贴图片'}
          </p>
          <div className="cove-upload-destination"><span>上传到：</span>
          {!all && (
            <Select
              value={uploadAlbum}
              disabled={action.busy}
              onValueChange={setUploadAlbum}
            >
              <SelectTrigger aria-label="上传到相册">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">不放入相册</SelectItem>
                {invalidUploadAlbum && (
                  <SelectItem value={uploadAlbum} disabled>
                    相册不可用
                  </SelectItem>
                )}
                {albums.data?.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          </div>
          <div className="cove-upload-actions">
            <Button
              disabled={action.busy || !uploadsReady}
              onClick={() => input.current?.click()}
            >
              {!uploadsReady ? '正在恢复上传记录…' : uploading ? '继续添加图片' : '选择图片'}
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
              disabled={action.busy || !uploadsReady}
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
      {!all && storageError && <p role="alert" className="cove-error">{storageError}</p>}
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
                onClick={() => { if (!queue.some((item) => !item.image) || window.confirm('清除记录后，未完成的图片需要重新选择。已保存的图片不受影响。')) clearQueue(); }}
                title="只清除上传记录，不会删除图库中的图片"
              >
                清除上传记录
              </Button>
            )}
          </div>
          <div className="cove-upload-actions">
            {!!uploaded.length && <Button variant="outline" onClick={() => showLinks(uploaded)}><Copy />复制本次链接</Button>}
            {uploading && queue.some((item) => item.status === '等待') && <Button variant="outline" onClick={stopWaiting}>停止后续上传</Button>}
            {queue.some((item) => ['失败', '等待重试'].includes(item.status)) && (
              <Button variant="outline" disabled={uploading || retryAfter > Date.now()} onClick={retryFailed}>
                {retryAfter > Date.now() ? '请稍候再重试' : '重试未完成项'}
              </Button>
            )}
          </div>
          <p className="cove-muted">{uploading ? '可以切换工作台页面；离开会暂停上传。' : '未完成项可点击重试继续。'}{!storageError && '待传文件保存在本浏览器，返回同一账号后可恢复。'}</p>
          {queue.some((item) => item.status === '已存在') && <p className="cove-muted">重复图片保留原名称、公开状态和相册。展开上传明细可查看原位置，或移入目标相册。</p>}
          {activeUpload && (
            <div className="cove-upload-current" role="status">
              <p>
                {activeUpload.name} ·{' '}
                {activeUpload.status === '核对结果' ? '正在核对上次上传结果…' : activeUpload.status === '服务器处理中'
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
              {firstUploadError.name}：{firstUploadError.error}
            </p>
          )}
          <details className="cove-upload-details">
            <summary>上传明细（{queue.length} 项，未完成 {queue.filter((item) => !item.image).length} 项）</summary>
            <ul className="cove-upload-list">
              {queue.map((item) => (
                <li key={item.id}>
                  <div className="cove-upload-file">
                    <span title={item.name}>{item.name}</span>
                    <span>{item.status}</span>
                    {item.image ? (
                      <Button variant="ghost" onClick={() => void copyDirect([item.image!])} aria-label={`复制上传结果 ${item.name}`}>复制链接</Button>
                    ) : ['等待', '失败', '等待重试'].includes(item.status) && (
                      <Button variant="ghost" onClick={() => removePending(item.id)} aria-label={`移除待上传 ${item.name}`}><X /></Button>
                    )}
                  </div>
                  {item.error && <p className="cove-error">{item.error}</p>}
                  {item.status === '已存在' && item.image && <p className="cove-muted">
                    图片已存在，保留原名称、公开状态和位置：{albums.data?.find((album) => album.id === item.image!.album_id)?.name || (item.image.album_id ? '原相册' : '未归入相册')}。
                    {item.targetAlbum !== 'all' && item.targetAlbum !== item.image.album_id && albums.data?.some((album) => album.id === item.targetAlbum) &&
                      <Button variant="outline" disabled={action.busy} onClick={() => void action.run(async () => {
                        const [current] = await latestPictures([item.image!]);
                        await api(`/images/${current.id}`, 'PATCH', { original_name: current.original_name, album_id: item.targetAlbum });
                        updateImages([{ ...current, album_id: item.targetAlbum }]);
                      }, '已移入目标相册，原图和外链已保留')}>移入「{albums.data.find((album) => album.id === item.targetAlbum)?.name}」</Button>}
                  </p>}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      <div className="cove-toolbar">
        <div>
          <h2>
            {all ? '托管图片' : '图片'} <span>{items.length}</span>
          </h2>

        </div>
      </div>
      {albums.isError && !all && (
        <p role="alert" className="cove-error">
          相册加载失败，请刷新重试。
        </p>
      )}
      {missingAlbum && (
        <p role="alert" className="cove-error">
          该相册已不存在或无权访问，请重新选择相册后上传。
        </p>
      )}
      <div className="cove-batch">
        <label className="cove-check">
          <input type="checkbox" disabled={action.busy || !selectable.length}
            checked={selectable.length > 0 && chosen.length === selectable.length}
            onChange={(event) => setSelected(event.target.checked ? selectable.map((item) => item.id) : [])} />
          选择本页
        </label>
        {!!chosen.length && <>
          <span>已选 {chosen.length} 张</span>
          {picking ? (
            <Button disabled={action.busy || missingAlbum} onClick={() => void movePictures(chosen, album)}>移入当前相册</Button>
          ) : <>
            <Button variant="outline" onClick={() => showLinks(chosen)}><Copy />复制链接</Button>
            {!all && <Button variant="outline" disabled={action.busy} onClick={() => setMoving(true)}>移动到相册</Button>}
            {!all && album !== 'all' && <Button variant="outline" disabled={action.busy} onClick={() => void movePictures(chosen, 'none')}>移出相册</Button>}
            <Button variant="outline" disabled={action.busy} onClick={() => setDeleting(chosen)}><Trash2 />永久删除</Button>
          </>}
          <Button variant="ghost" disabled={action.busy} onClick={() => setSelected([])}>取消选择</Button>
        </>}
      </div>
      {invalidAlbum ? null : images.isPending ? (
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
          {!all && !picking && <div className="cove-actions">
            <Button onClick={() => input.current?.click()}>上传图片</Button>
            {currentAlbum && <Button variant="outline" disabled={action.busy} onClick={() => { setPicking(true); setPage(1); }}>从图库移入</Button>}
          </div>}
        </div>
      ) : (
        <div className="cove-gallery">
          {items.map((item) => (
            <Card key={item.id} className="cove-image">
              <div className="cove-image-preview">
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.deleted_at ? (
                    <span>待清理 · 请重试删除</span>
                  ) : ['blocked', 'review'].includes(item.moderation_status) && !me.data?.user.is_admin ? (
                    <span>{item.moderation_reason || '图片被审核限制'}</span>
                  ) : (
                    <img
                      src={item.thumbnail_url || item.url}
                      alt={item.original_name}
                      loading="lazy"
                    />
                  )}
                </a>
                <label className="cove-image-select">
                <input
                  aria-label={`选择 ${item.original_name}`}
                  type="checkbox"
                  disabled={action.busy || (picking && (!!item.deleted_at || item.album_id === album))}
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
                </label>
              </div>
              <CardContent>
                <h3 title={item.original_name}>{item.original_name}</h3>
                {picking && item.album_id === album && <small>已在当前相册</small>}
                <small title={item.moderation_reason}>
                  {reviewLabels[item.moderation_status] || '未审核'}
                </small>
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
                    onClick={() => copyDirect([item])}
                    aria-label={`复制 ${item.original_name} 链接`}
                  >
                    <Copy />
                    复制
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" aria-label={`更多操作 ${item.original_name}`}><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => showLinks([item])}>选择链接格式</DropdownMenuItem>
                      <DropdownMenuItem disabled={!!sharingProblem(item)} onSelect={() => setQr(item)}><QrCode />二维码分享</DropdownMenuItem>
                      {item.user_id === me.data?.user.id && !item.deleted_at && <>
                        <DropdownMenuItem onSelect={() => { setEditing(item); setEditAlbum(item.album_id || 'none'); }}><Pencil />整理图片</DropdownMenuItem>
                        {item.album_id && <DropdownMenuItem disabled={action.busy} onSelect={() => void movePictures([item], 'none')}>移出相册（保留图片）</DropdownMenuItem>}
                      </>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" disabled={action.busy} onSelect={() => setDeleting([item])}><Trash2 />永久删除</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Pager
        page={page}
        more={images.data?.has_more || false}
        disabled={action.busy}
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
              选择一种格式，复制可公开访问的图片链接。
            </DialogDescription>
          </DialogHeader>
          {links.isPending ? <p role="status">正在核对图片状态…</p> : links.isError ? <p role="alert">无法核对图片状态。<Button onClick={() => void links.refetch()}>重试</Button></p> : <BatchLinks pictures={links.data || []} onCopy={copy} refreshing={links.isFetching} />}
        </DialogContent>
      </Dialog>
      <Dialog open={moving} onOpenChange={(open) => { if (!action.busy) setMoving(open); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>移动 {chosen.length} 张图片</DialogTitle><DialogDescription>每张图片只属于一个相册。移动会离开原相册，图片和外链保持不变。</DialogDescription></DialogHeader>
          <Select value={moveTo} onValueChange={setMoveTo} disabled={action.busy || !albums.isSuccess}>
            <SelectTrigger aria-label="移动到相册"><SelectValue /></SelectTrigger>
            <SelectContent>{albumOptions}</SelectContent>
          </Select>
          <Button disabled={action.busy || !chosen.length || !albums.isSuccess} onClick={() => void movePictures(chosen, moveTo)}>{action.busy ? '正在移动…' : moveTo === 'none' ? '移出相册' : '确认移动'}</Button>
          <Button variant="outline" disabled={action.busy} onClick={() => { setMoving(false); setCreatingAlbum(true); }}>新建相册并移入</Button>
          <DialogClose asChild><Button variant="ghost" disabled={action.busy}>取消</Button></DialogClose>
        </DialogContent>
      </Dialog>
      <AlbumDialog open={creatingAlbum} onClose={() => setCreatingAlbum(false)} onSaved={(created) => { setMoveTo(created.id); void movePictures(chosen, created.id); }} />
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
function AlbumDialog({ open, album, onClose, onSaved }: {
  open: boolean;
  album?: Album;
  onClose: () => void;
  onSaved: (album: Album) => void;
}) {
  const action = useAction();
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !action.busy) onClose(); }}>
      <DialogContent className="cove-album-dialog" onEscapeKeyDown={(event) => { if (action.busy) event.preventDefault(); }} onPointerDownOutside={(event) => { if (action.busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{album ? '编辑相册' : '创建相册'}</DialogTitle>
          <DialogDescription>{album ? '修改名称和描述，图片外链保持不变。' : '起一个容易辨认的名字，创建后即可添加图片。'}</DialogDescription>
        </DialogHeader>
        <form className="cove-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void action.run(async () => {
            const saved = await api<Album>(album ? `/albums/${album.id}` : '/albums', album ? 'PATCH' : 'POST', {
              name: values.get('name'), description: values.get('description'),
            });
            onClose();
            onSaved(saved);
          }, album ? '相册已更新' : '相册已创建');
        }}>
          <label>名称<Input name="name" required maxLength={100} defaultValue={album?.name} placeholder="例如：旅行照片、博客配图" disabled={action.busy} /></label>
          <label>描述（选填）<Textarea name="description" maxLength={500} rows={2} defaultValue={album?.description || ''} disabled={action.busy} /></label>
          <div className="cove-actions">
            <Button type="submit" disabled={action.busy}>{action.busy ? '正在保存…' : album ? '保存' : '创建相册'}</Button>
            <Button type="button" variant="outline" disabled={action.busy} onClick={onClose}>取消</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function Albums() {
  const navigate = useNavigate();
  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });
  const action = useAction();
  const [deleting, setDeleting] = useState<Album | null>(null);
  const [editing, setEditing] = useState<Album | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Heading
        title="我的相册"
        description="按文章、项目或灵感分类，让图片更好找。"
      />
      <div className="cove-albums-toolbar"><Button onClick={() => setCreating(true)}>创建相册</Button><span className="cove-muted">{albums.data ? `${albums.data.length} 个相册` : ''}</span></div>
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
              <Link className="cove-album-cover" to={`/app?album=${album.id}`} aria-label={`打开相册 ${album.name}`}>
                {album.cover_id ? <img src={`/api/v1/images/${album.cover_id}/thumbnail`} alt="" loading="lazy" /> : <FolderHeart aria-hidden="true" />}
              </Link>
              <h2><Link to={`/app?album=${album.id}`}>{album.name}</Link></h2>
              {album.image_count !== undefined && <p>{album.image_count} 张图片</p>}
              {album.description && <p>{album.description}</p>}
              <div className="cove-album-actions">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑相册 ${album.name}`}
                  onClick={() => setEditing(album)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除相册 ${album.name}`}
                  onClick={() => setDeleting(album)}
                >
                  <Trash2 />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {albums.data?.length === 0 && (
        <p className="cove-empty">还没有相册。创建后可直接上传图片，或从图库移入已有图片。</p>
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
          <DialogClose asChild>
            <Button variant="outline" disabled={action.busy}>
              取消
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
      <AlbumDialog open={creating || !!editing} album={editing || undefined}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={(saved) => { if (creating) navigate(`/app?album=${saved.id}`); }} />
    </>
  );
}
export function AccountSettings() {
  const action = useAction();
  const navigate = useNavigate();
  const [pendingTotp, setPendingTotp] = useState<PendingTotp>(null);
  return (
    <>
      <Heading
        title="账号设置"
        description="管理登录用户名、密码与验证方式。"
      />
      <Card className="cove-account">
        <Tabs defaultValue="profile">
          <TabsList variant="line" className="px-5 pt-4 md:px-7">
            <TabsTrigger value="profile">账号资料</TabsTrigger>
            <TabsTrigger value="security">登录与安全</TabsTrigger>
          </TabsList>
          <TabsContent value="profile">
            <AccountProfile />
          </TabsContent>
          <TabsContent value="security">
            <AccountSecurity pending={pendingTotp} setPending={setPendingTotp} />
            <section className="cove-account-section">
              <h2>修改密码</h2>
              <form
                className="cove-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  if (!form.reportValidity()) return;
                  const values = new FormData(form);
                  if (values.get('password') !== values.get('confirm')) {
                    toast.error('两次输入的新密码不一致');
                    return;
                  }
                  void action.run(async () => {
                    await api('/me/password', 'POST', {
                      current_password: values.get('current'),
                      password: values.get('password'),
                      code: values.get('code') || '',
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
                <label>
                  确认新密码
                  <Input
                    name="confirm"
                    type="password"
                    autoComplete="new-password"
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
          </TabsContent>
        </Tabs>
      </Card>
    </>
  );
}
export function RegistrationSettings() {
  const { hash } = useLocation();
  const sections = [['ai', 'AI 生图与审核'], ['registration', '用户注册'], ['storage', '存储位置'], ['migration', '图片迁移'], ['import', '批量导入'], ['jobs', '任务记录'], ['system', '版本与服务']];
  const active = sections.some(([id]) => hash === `#settings-${id}`) ? hash.slice(10) : 'ai';
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
          {sections.map(([id, label]) => <Link key={id} to={`#settings-${id}`} aria-current={active === id ? 'page' : undefined}>{label}</Link>)}
        </nav>
        <div className="cove-settings-content">
          <div hidden={active !== 'ai'}><AiSettings /></div>
          <Card id="settings-registration" className="cove-settings-card" hidden={active !== 'registration'}>
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
          <SystemSettings section={active} />
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
                    <th>内容审核</th>
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
                        <UserModerationControls user={account.user} />
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
