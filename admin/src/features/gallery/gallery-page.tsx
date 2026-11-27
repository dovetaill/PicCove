import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CloudUpload,
  Copy,
  FolderInput,
  FolderOutput,
  FolderPlus,
  Globe,
  Grid2x2,
  Grid3x3,
  Images,
  Info,
  Lock,
  MoreHorizontal,
  QrCode,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useLayout } from '@/components/layout/layout-context';
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
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AlbumDialog } from '@/features/albums/albums-page';
import { useUploads } from '@/features/uploads/upload-manager';
import {
  api,
  ApiError,
  errorMessage,
  imageLink,
  latestPictures,
  REVIEW_LABELS,
  reviewBadgeVariant,
  sharingProblem,
  size,
  useMe,
  type Album,
  type Page,
  type Picture,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { ImageDetailSheet } from './image-detail-sheet';
import { copyTextToClipboard, LinksDialog } from './links-dialog';
import { LightboxDialog } from './lightbox-dialog';
import { ShareQrDialog } from './share-qr-dialog';

export function GalleryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const albumParam = (searchParams.get('album') || 'all').toLowerCase();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<
    'all' | 'public' | 'private'
  >('all');
  const [density, setDensity] = useState<'comfortable' | 'compact'>(
    'comfortable',
  );
  const [uploadAlbum, setUploadAlbum] = useState(albumParam);
  const [uploadPrivate, setUploadPrivate] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const lastClickedIdx = useRef<number | null>(null);

  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<Picture | null>(null);
  const [copying, setCopying] = useState<Picture[]>([]);
  const [qrPicture, setQrPicture] = useState<Picture | null>(null);
  const [deleting, setDeleting] = useState<Picture[]>([]);
  const [movingOpen, setMovingOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('none');
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const me = useMe();
  const client = useQueryClient();
  const { setUploadSheetOpen } = useLayout();
  const {
    queue,
    busy: uploading,
    upload,
    removeImage,
    ready: uploadsReady,
    storageError,
    updateImages,
  } = useUploads();

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
    setSelected([]);
    lastClickedIdx.current = null;
    setPicking(false);
    setUploadAlbum(albumParam);
  }, [albumParam]);

  useEffect(() => {
    setPage(1);
    setSelected([]);
    lastClickedIdx.current = null;
  }, [debouncedQuery, visibilityFilter]);

  const invalidAlbum =
    albumParam !== 'all' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      albumParam,
    );

  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });

  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  if (albumParam !== 'all' && !picking) {
    queryParams.set('album_id', albumParam);
  }
  if (debouncedQuery) {
    queryParams.set('q', debouncedQuery);
  }
  if (visibilityFilter === 'public') {
    queryParams.set('is_public', 'true');
  } else if (visibilityFilter === 'private') {
    queryParams.set('is_public', 'false');
  }

  const images = useQuery({
    queryKey: [
      'images',
      false,
      picking ? 'all' : albumParam,
      page,
      debouncedQuery,
      visibilityFilter,
    ],
    enabled: !invalidAlbum,
    queryFn: () => api<Page<Picture>>(`/images?${queryParams.toString()}`),
    refetchInterval: (q) =>
      q.state.data?.items.some((item) =>
        ['pending', 'running'].includes(item.moderation_status),
      )
        ? 5000
        : false,
  });

  const items = images.data?.items || [];
  const totalCount = images.data?.total;
  const currentAlbum = albums.data?.find((a) => a.id === albumParam);
  const missingAlbum =
    invalidAlbum ||
    (albumParam !== 'all' &&
      albums.isSuccess &&
      !albums.data.some((a) => a.id === albumParam));

  const invalidUploadAlbum =
    uploadAlbum !== 'all' &&
    (!/^[0-9a-f-]{36}$/.test(uploadAlbum) ||
      (albums.isSuccess && !albums.data.some((a) => a.id === uploadAlbum)));

  const selectable = items.filter(
    (item) => !picking || (!item.deleted_at && item.album_id !== albumParam),
  );
  const chosen = items.filter((item) => selected.includes(item.id));
  const unfinishedUploads = queue.filter(
    (item) => !item.image && item.file,
  ).length;

  useEffect(() => {
    if (
      !images.isPending &&
      !images.isFetching &&
      !images.isError &&
      page > 1 &&
      items.length === 0
    ) {
      setPage((p) => p - 1);
      setSelected([]);
      lastClickedIdx.current = null;
    }
  }, [images.isPending, images.isFetching, images.isError, items.length, page]);

  useEffect(() => {
    if (picking) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      if (
        document.querySelector('[role="dialog"], [role="alertdialog"]') ||
        !event.clipboardData?.files.length
      )
        return;
      event.preventDefault();
      handleFilesUpload(event.clipboardData.files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  function handleFilesUpload(files: FileList | File[]) {
    if (busyAction) {
      toast.info('当前操作处理中，请稍候');
      return;
    }
    if (invalidUploadAlbum) {
      toast.error('目标相册不存在，请重新选择上传相册');
      return;
    }
    if (uploadAlbum !== 'all' && (!albums.isSuccess || albums.isFetching)) {
      toast.error('正在读取相册信息，请稍候');
      return;
    }
    upload(files, uploadAlbum, uploadPrivate);
  }

  async function handleDirectCopy(picture: Picture) {
    try {
      const [latest] = await latestPictures([picture]);
      updateImages([latest]);
      if (
        sharingProblem(latest) ||
        !(await copyTextToClipboard(latest.url, '直链已复制'))
      ) {
        setCopying([latest]);
      }
    } catch {
      setCopying([picture]);
    }
  }

  async function handleToggleSingleVisibility(picture: Picture) {
    setBusyAction(true);
    try {
      const nextPublic = !picture.is_public;
      await api(`/images/${picture.id}/visibility`, 'PATCH', {
        is_public: nextPublic,
      });
      updateImages([{ ...picture, is_public: nextPublic }]);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success(nextPublic ? '已设为公开' : '已设为私有');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  async function handleBatchVisibility(nextPublic: boolean) {
    if (!chosen.length || busyAction) return;
    setBusyAction(true);
    let updatedCount = 0;
    try {
      for (const item of chosen) {
        if (item.deleted_at || item.is_public === nextPublic) continue;
        await api(`/images/${item.id}/visibility`, 'PATCH', {
          is_public: nextPublic,
        });
        updatedCount++;
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      setSelected([]);
      toast.success(
        nextPublic
          ? `已将 ${updatedCount} 张图片设为公开`
          : `已将 ${updatedCount} 张图片设为私有`,
      );
    } catch (error) {
      await client.invalidateQueries({ queryKey: ['images'] });
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  async function handleMovePictures(pictures: Picture[], destination: string) {
    if (!pictures.length || busyAction) return;
    setBusyAction(true);
    let moved = 0;
    try {
      const targetAlbum = destination === 'none' ? null : destination;
      for (const item of pictures) {
        await api(`/images/${item.id}`, 'PATCH', {
          album_id: targetAlbum,
        });
        updateImages([{ ...item, album_id: targetAlbum }]);
        moved++;
        setSelected((ids) => ids.filter((id) => id !== item.id));
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
      ]);
      toast.success(
        destination === 'none'
          ? `已将 ${moved} 张图片移出相册`
          : `已移动 ${moved} 张图片`,
      );
      setMovingOpen(false);
      if (picking) {
        setPicking(false);
        setPage(1);
      }
    } catch (error) {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
      ]);
      toast.error(
        `已完成 ${moved} 张，剩余 ${pictures.length - moved} 张未完成：${errorMessage(error)}`,
      );
    } finally {
      setBusyAction(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleting.length || busyAction) return;
    setBusyAction(true);
    try {
      for (const item of deleting) {
        try {
          await api(`/images/${item.id}`, 'DELETE');
          removeImage(item.id);
        } catch (err) {
          if (!(err instanceof ApiError && [401, 403].includes(err.status))) {
            removeImage(item.id);
          }
          throw err;
        }
        if (inspecting?.id === item.id) setInspecting(null);
        setDeleting((curr) => curr.filter((r) => r.id !== item.id));
      }
      setSelected([]);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success('图片已永久删除');
    } catch (error) {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
      ]);
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  function toggleSelectCard(id: string, idx: number, shiftKey: boolean) {
    if (shiftKey && lastClickedIdx.current !== null) {
      const start = Math.min(lastClickedIdx.current, idx);
      const end = Math.max(lastClickedIdx.current, idx);
      const rangeIds = items
        .slice(start, end + 1)
        .filter((item) => selectable.some((s) => s.id === item.id))
        .map((item) => item.id);
      setSelected((prev) => Array.from(new Set([...prev, ...rangeIds])));
    } else {
      setSelected((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
      );
      lastClickedIdx.current = idx;
    }
  }

  const totalPages =
    totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / 48)) : null;

  return (
    <div className="container space-y-5 pb-20">
      {/* Page Header */}
      <Toolbar className="pb-1">
        <ToolbarHeading
          title={
            picking
              ? `移入「${currentAlbum?.name || '相册'}」`
              : currentAlbum?.name || '我的图片库'
          }
          description={
            picking
              ? '勾选需要归入此相册的图片'
              : currentAlbum
                ? currentAlbum.description || '管理此相册中的图片素材'
                : '拖拽或粘贴即可上传原图，点击图片查看大图或复制外链'
          }
          badge={
            totalCount !== undefined ? (
              <Badge variant="secondary" appearance="light" size="sm">
                {totalCount} 张
              </Badge>
            ) : undefined
          }
        />
        <ToolbarActions>
          {albumParam !== 'all' && (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to="/app/albums">
                  <ArrowLeft />
                  返回相册
                </Link>
              </Button>
              {picking ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPicking(false);
                    setPage(1);
                    setSelected([]);
                  }}
                >
                  取消移入
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!currentAlbum}
                  onClick={() => {
                    setPicking(true);
                    setPage(1);
                    setSelected([]);
                  }}
                >
                  <FolderInput />
                  从图库移入
                </Button>
              )}
            </>
          )}

          {queue.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUploadSheetOpen(true)}
            >
              <CloudUpload />
              上传记录（{queue.length}）
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      {/* Unfinished Restored Queue Banner */}
      {storageError && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400"
        >
          {storageError}
        </div>
      )}
      {!uploading && unfinishedUploads > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm"
        >
          <span className="text-foreground">
            检测到 <strong>{unfinishedUploads}</strong> 张上次未完成的待传图片
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setUploadSheetOpen(true)}
          >
            查看并继续上传
          </Button>
        </div>
      )}

      {/* Compact Smart Dropzone */}
      {!picking && (
        <div
          tabIndex={0}
          aria-busy={uploading}
          aria-label="图片上传区域，支持拖放或直接粘贴"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(!busyAction);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFilesUpload(e.dataTransfer.files);
          }}
          className={cn(
            'rounded-xl border border-dashed transition-all p-4 sm:px-6 sm:py-5 bg-card shadow-2xs',
            dragging
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-border hover:border-primary/40',
          )}
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <CloudUpload className="size-5.5" />
              </span>
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-mono">
                  {uploading
                    ? '正在后台上传，可继续添加图片'
                    : '拖拽图片到此处，或直接 Ctrl+V 粘贴上传'}
                </h2>
                <p className="text-xs text-muted-foreground">
                  支持 JPEG、PNG、WebP、GIF 原图保存，单张最大 10 MiB
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {/* Target Album Selector */}
              <Select
                value={uploadAlbum}
                disabled={busyAction}
                onValueChange={setUploadAlbum}
              >
                <SelectTrigger
                  aria-label="上传到相册"
                  size="sm"
                  className="w-[150px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">不放入相册</SelectItem>
                  {invalidUploadAlbum && (
                    <SelectItem value={uploadAlbum} disabled>
                      失效相册
                    </SelectItem>
                  )}
                  {albums.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Visibility Segmented Pill */}
              <div
                role="group"
                aria-label="上传可见性"
                className="inline-flex h-7 items-center rounded-md border border-input bg-muted/60 p-0.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => setUploadPrivate(false)}
                  className={cn(
                    'cursor-pointer inline-flex items-center gap-1 rounded-xs px-2 py-1 font-medium transition-colors',
                    !uploadPrivate
                      ? 'bg-background text-mono shadow-2xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Globe className="size-3" />
                  公开
                </button>
                <button
                  type="button"
                  onClick={() => setUploadPrivate(true)}
                  className={cn(
                    'cursor-pointer inline-flex items-center gap-1 rounded-xs px-2 py-1 font-medium transition-colors',
                    uploadPrivate
                      ? 'bg-background text-mono shadow-2xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Lock className="size-3" />
                  私有
                </button>
              </div>

              <Button
                size="sm"
                disabled={busyAction || !uploadsReady}
                onClick={() => fileInputRef.current?.click()}
              >
                <CloudUpload />
                {!uploadsReady
                  ? '准备中…'
                  : uploading
                    ? '追加图片'
                    : '选择图片'}
              </Button>
              <input
                ref={fileInputRef}
                hidden
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => {
                  if (e.target.files) {
                    handleFilesUpload(e.target.files);
                    e.currentTarget.value = '';
                  }
                }}
              />

              <Button
                size="sm"
                variant="outline"
                disabled={busyAction || !uploadsReady}
                onClick={() => folderInputRef.current?.click()}
              >
                选择文件夹
              </Button>
              <input
                ref={folderInputRef}
                hidden
                type="file"
                multiple
                {...{ webkitdirectory: '' }}
                onChange={(e) => {
                  if (e.target.files) {
                    handleFilesUpload(
                      Array.from(e.target.files).filter((f) =>
                        /\.(jpe?g|png|webp|gif)$/i.test(f.name),
                      ),
                    );
                    e.currentTarget.value = '';
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Filter & View Bar */}
      <Card>
        <CardContent className="p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[220px]">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-secondary-foreground cursor-pointer select-none pe-1">
              <Checkbox
                size="sm"
                disabled={busyAction || selectable.length === 0}
                checked={
                  selectable.length > 0 && chosen.length === selectable.length
                }
                onCheckedChange={(v) =>
                  setSelected(v === true ? selectable.map((i) => i.id) : [])
                }
                aria-label="选择本页"
              />
              全选本页
            </label>

            <div className="relative flex-1 max-w-[240px]">
              <Search className="size-3.5 text-muted-foreground absolute start-2.5 top-1/2 -translate-y-1/2" />
              <Input
                variant="sm"
                value={searchInput}
                maxLength={200}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索图片名称…"
                aria-label="搜索图片名称"
                className="ps-8 pe-7"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  aria-label="清空搜索"
                  className="cursor-pointer absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {!picking && (
              <Select
                value={albumParam}
                onValueChange={(val) => {
                  if (val === 'all') {
                    setSearchParams({});
                  } else {
                    setSearchParams({ album: val });
                  }
                }}
              >
                <SelectTrigger
                  aria-label="筛选相册"
                  size="sm"
                  className="w-[140px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部图片</SelectItem>
                  {albums.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select
              value={visibilityFilter}
              onValueChange={(val) =>
                setVisibilityFilter(val as 'all' | 'public' | 'private')
              }
            >
              <SelectTrigger
                aria-label="筛选可见性"
                size="sm"
                className="w-[115px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="public">仅公开</SelectItem>
                <SelectItem value="private">仅私有</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-border p-0.5 bg-muted/40">
            <Button
              size="sm"
              mode="icon"
              variant={density === 'comfortable' ? 'secondary' : 'ghost'}
              className="size-7"
              aria-label="舒适视图"
              onClick={() => setDensity('comfortable')}
            >
              <Grid2x2 className="size-3.5" />
            </Button>
            <Button
              size="sm"
              mode="icon"
              variant={density === 'compact' ? 'secondary' : 'ghost'}
              className="size-7"
              aria-label="紧凑网格"
              onClick={() => setDensity('compact')}
            >
              <Grid3x3 className="size-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {missingAlbum && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive flex items-center justify-between"
        >
          <span>所选相册不存在或无权访问</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSearchParams({})}
          >
            返回全部图片
          </Button>
        </div>
      )}

      {/* Gallery Content */}
      {invalidAlbum ? null : images.isPending ? (
        <div
          className={cn(
            'grid gap-4',
            density === 'compact'
              ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
              : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
          )}
        >
          {Array.from({ length: 10 }).map((_, idx) => (
            <Card key={idx} className="overflow-hidden">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <CardContent className="p-3 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : images.isError ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3" role="alert">
            <p className="text-sm text-destructive">
              {errorMessage(images.error)}
            </p>
            <Button variant="outline" onClick={() => void images.refetch()}>
              重新加载
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center text-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Images className="size-6" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-mono">
                {debouncedQuery || visibilityFilter !== 'all'
                  ? '没有符合筛选条件的图片'
                  : albumParam !== 'all'
                    ? '此相册还没有图片'
                    : '图片库还是空的'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {debouncedQuery || visibilityFilter !== 'all'
                  ? '试试调整关键词或重置筛选条件'
                  : albumParam !== 'all'
                    ? '可以直接上传图片，或从图库移入已有图片'
                    : '上传第一张图片，开启你的灵感图库'}
              </p>
            </div>
            <div className="flex items-center gap-2.5 mt-2">
              {debouncedQuery || visibilityFilter !== 'all' ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchInput('');
                    setVisibilityFilter('all');
                  }}
                >
                  重置筛选
                </Button>
              ) : (
                !picking && (
                  <>
                    <Button onClick={() => fileInputRef.current?.click()}>
                      <CloudUpload />
                      上传图片
                    </Button>
                    {currentAlbum && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPicking(true);
                          setPage(1);
                        }}
                      >
                        从图库移入
                      </Button>
                    )}
                  </>
                )
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div
          className={cn(
            'grid gap-4',
            density === 'compact'
              ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
              : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
          )}
        >
          {items.map((item, idx) => {
            const isSelected = selected.includes(item.id);
            const isDisabledPick =
              picking && (!!item.deleted_at || item.album_id === albumParam);
            const restrictedPreview =
              !!item.deleted_at ||
              (['blocked', 'review'].includes(item.moderation_status) &&
                !me.data?.user.is_admin);
            const showReviewBadge =
              item.moderation_status &&
              !['unreviewed', 'passed', 'exempt'].includes(
                item.moderation_status,
              );

            return (
              <ContextMenu key={item.id}>
                <ContextMenuTrigger asChild>
                  <Card
                    className={cn(
                      'group overflow-hidden transition-all',
                      isSelected
                        ? 'ring-2 ring-primary border-primary'
                        : 'hover:border-primary/40',
                    )}
                  >
                    {/* Preview Area */}
                    <div className="relative aspect-[4/3] bg-muted/60 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => {
                          if (picking && !isDisabledPick) {
                            toggleSelectCard(item.id, idx, false);
                          } else {
                            setLightboxId(item.id);
                          }
                        }}
                        className="cursor-pointer w-full h-full flex items-center justify-center focus-visible:outline-hidden"
                      >
                        {restrictedPreview ? (
                          <span className="text-xs text-muted-foreground px-3 text-center">
                            {item.deleted_at
                              ? '待清理'
                              : item.moderation_reason || '受审核限制'}
                          </span>
                        ) : (
                          <img
                            src={item.thumbnail_url || item.url}
                            alt={item.original_name}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                          />
                        )}
                      </button>

                      {/* Top-Left Selection Checkbox (44x44px hit target) */}
                      <div
                        className={cn(
                          'absolute start-0.5 top-0.5 z-10 transition-opacity',
                          isSelected
                            ? 'opacity-100'
                            : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100',
                        )}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={`选择 ${item.original_name}`}
                          disabled={busyAction || isDisabledPick}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectCard(item.id, idx, e.shiftKey);
                          }}
                          className={cn(
                            'cursor-pointer flex size-11 items-center justify-center focus-visible:outline-hidden',
                            isDisabledPick && 'opacity-40 pointer-events-none',
                          )}
                        >
                          <span
                            className={cn(
                              'flex size-6 items-center justify-center rounded-md border shadow-xs transition-colors',
                              isSelected
                                ? 'bg-primary border-primary text-primary-foreground'
                                : 'bg-background/90 backdrop-blur-xs border-border hover:border-primary',
                            )}
                          >
                            {isSelected && (
                              <svg
                                viewBox="0 0 14 14"
                                className="size-3.5 fill-none stroke-current stroke-[2.2]"
                              >
                                <path d="M2.5 7.5L5.5 10.5L11.5 3.5" />
                              </svg>
                            )}
                          </span>
                        </button>
                      </div>

                      {/* Top-Right Status Badges (Only when non-default!) */}
                      <div className="absolute end-2 top-2 flex flex-col items-end gap-1 pointer-events-none">
                        {!item.is_public && (
                          <Badge
                            size="xs"
                            variant="secondary"
                            className="bg-zinc-900/75 text-white border-0 backdrop-blur-xs"
                          >
                            <Lock className="size-2.5" />
                            私有
                          </Badge>
                        )}
                        {showReviewBadge && (
                          <Badge
                            size="xs"
                            variant={reviewBadgeVariant(item.moderation_status)}
                          >
                            {REVIEW_LABELS[item.moderation_status] ||
                              item.moderation_status}
                          </Badge>
                        )}
                        {picking && item.album_id === albumParam && (
                          <Badge size="xs" variant="info">
                            已在相册
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Footer */}
                    <CardContent
                      className={cn(
                        'flex items-center justify-between gap-1.5',
                        density === 'compact' ? 'p-2.5' : 'px-3.5 py-2.5',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setInspecting(item)}
                        className="cursor-pointer min-w-0 flex-1 text-start focus-visible:outline-hidden"
                      >
                        <p
                          className="text-xs font-medium text-mono truncate hover:text-primary transition-colors"
                          title={item.original_name}
                        >
                          {item.original_name}
                        </p>
                        {density === 'comfortable' && (
                          <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                            {item.width} × {item.height} · {size(item.size_bytes)}
                          </p>
                        )}
                      </button>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button
                          size="sm"
                          mode="icon"
                          variant="ghost"
                          disabled={!!item.deleted_at}
                          onClick={() => void handleDirectCopy(item)}
                          aria-label={`复制 ${item.original_name} 链接`}
                          title="复制直链"
                          className="size-7.5"
                        >
                          <Copy className="size-3.5" />
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              mode="icon"
                              variant="ghost"
                              aria-label={`更多操作 ${item.original_name}`}
                              className="size-7.5"
                            >
                              <MoreHorizontal className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onSelect={() => setInspecting(item)}
                            >
                              <Info />
                              详情与编辑
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setCopying([item])}
                            >
                              <Copy />
                              选择外链格式
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!!sharingProblem(item)}
                              onSelect={() => setQrPicture(item)}
                            >
                              <QrCode />
                              二维码分享
                            </DropdownMenuItem>
                            {!item.deleted_at && (
                              <DropdownMenuItem
                                disabled={
                                  busyAction ||
                                  (!item.is_public &&
                                    ['blocked', 'review'].includes(
                                      item.moderation_status,
                                    ))
                                }
                                onSelect={() =>
                                  void handleToggleSingleVisibility(item)
                                }
                              >
                                {item.is_public ? <Lock /> : <Globe />}
                                {item.is_public ? '设为私有' : '设为公开'}
                              </DropdownMenuItem>
                            )}
                            {item.album_id && !item.deleted_at && (
                              <DropdownMenuItem
                                disabled={busyAction}
                                onSelect={() =>
                                  void handleMovePictures([item], 'none')
                                }
                              >
                                <FolderOutput />
                                移出相册
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={busyAction}
                              onSelect={() => setDeleting([item])}
                            >
                              <Trash2 />
                              永久删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </CardContent>
                  </Card>
                </ContextMenuTrigger>

                <ContextMenuContent className="w-48">
                  <ContextMenuItem onSelect={() => setLightboxId(item.id)}>
                    大图预览
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => setInspecting(item)}>
                    查看详情与改名
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!!sharingProblem(item)}
                    onSelect={() =>
                      void copyTextToClipboard(item.url, '直链已复制')
                    }
                  >
                    复制 URL 直链
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!!sharingProblem(item)}
                    onSelect={() =>
                      void copyTextToClipboard(
                        imageLink(item, 'markdown'),
                        'Markdown 已复制',
                      )
                    }
                  >
                    复制 Markdown
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => setCopying([item])}>
                    更多链接格式…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting([item])}
                  >
                    永久删除
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {(page > 1 || !!images.data?.has_more) && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction || page === 1}
            onClick={() => {
              setPage((p) => p - 1);
              setSelected([]);
              lastClickedIdx.current = null;
            }}
          >
            <ArrowLeft />
            上一页
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            第 {page} {totalPages ? `/ ${totalPages}` : ''} 页
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction || !images.data?.has_more}
            onClick={() => {
              setPage((p) => p + 1);
              setSelected([]);
              lastClickedIdx.current = null;
            }}
          >
            下一页
            <ArrowRight />
          </Button>
        </div>
      )}

      {/* Floating Frosted Batch Action Island */}
      {chosen.length > 0 && (
        <div className="fixed bottom-5 start-1/2 -translate-x-1/2 z-30 max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-card/95 backdrop-blur-md px-4 py-2.5 shadow-xl flex flex-wrap items-center gap-2">
          <Badge variant="primary" size="md" className="me-1">
            已选 {chosen.length} 张
          </Badge>

          {picking ? (
            <Button
              size="sm"
              disabled={busyAction || missingAlbum}
              onClick={() => void handleMovePictures(chosen, albumParam)}
            >
              <FolderInput />
              移入当前相册
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCopying(chosen)}
              >
                <Copy />
                复制外链
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction}
                onClick={() => void handleBatchVisibility(true)}
              >
                <Globe />
                设为公开
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction}
                onClick={() => void handleBatchVisibility(false)}
              >
                <Lock />
                设为私有
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction}
                onClick={() => setMovingOpen(true)}
              >
                <FolderInput />
                移动到相册
              </Button>
              {albumParam !== 'all' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyAction}
                  onClick={() => void handleMovePictures(chosen, 'none')}
                >
                  <FolderOutput />
                  移出相册
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={busyAction}
                onClick={() => setDeleting(chosen)}
              >
                <Trash2 />
                删除
              </Button>
            </>
          )}

          <Button
            size="sm"
            variant="ghost"
            disabled={busyAction}
            onClick={() => setSelected([])}
          >
            取消
          </Button>
        </div>
      )}

      {/* Lightbox, Detail Sheet, Links, QR, Move & Delete Dialogs */}
      <LightboxDialog
        items={items}
        activeId={lightboxId}
        onSelectId={setLightboxId}
        onInspect={(pic) => setInspecting(pic)}
        onOpenLinks={(pic) => setCopying([pic])}
      />

      <ImageDetailSheet
        picture={inspecting}
        albums={albums.data}
        onClose={() => setInspecting(null)}
        onUpdated={(updated) => {
          setInspecting(updated);
          updateImages([updated]);
        }}
        onOpenLightbox={(pic) => {
          setInspecting(null);
          setLightboxId(pic.id);
        }}
        onOpenQr={(pic) => setQrPicture(pic)}
        onDelete={(pic) => setDeleting([pic])}
      />

      <LinksDialog pictures={copying} onClose={() => setCopying([])} />

      <ShareQrDialog image={qrPicture} onClose={() => setQrPicture(null)} />

      <Dialog
        open={movingOpen}
        onOpenChange={(open) => {
          if (!busyAction) setMovingOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>移动 {chosen.length} 张图片</DialogTitle>
            <DialogDescription>选择目标相册，或移出当前相册</DialogDescription>
          </DialogHeader>
          <Select
            value={moveTarget}
            onValueChange={setMoveTarget}
            disabled={busyAction || !albums.isSuccess}
          >
            <SelectTrigger aria-label="目标相册">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不放入相册（移出相册）</SelectItem>
              {albums.data?.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              disabled={busyAction}
              onClick={() => {
                setMovingOpen(false);
                setCreatingAlbum(true);
              }}
              className="sm:me-auto"
            >
              <FolderPlus />
              新建相册并移入
            </Button>
            <Button
              variant="ghost"
              disabled={busyAction}
              onClick={() => setMovingOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={busyAction || !chosen.length || !albums.isSuccess}
              onClick={() => void handleMovePictures(chosen, moveTarget)}
            >
              {busyAction
                ? '正在移动…'
                : moveTarget === 'none'
                  ? '移出相册'
                  : '确认移动'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlbumDialog
        open={creatingAlbum}
        onClose={() => setCreatingAlbum(false)}
        onSaved={(created) => {
          setMoveTarget(created.id);
          void handleMovePictures(chosen, created.id);
        }}
      />

      <AlertDialog
        open={deleting.length > 0}
        onOpenChange={(open) => {
          if (!open && !busyAction) setDeleting([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              永久删除 {deleting.length} 张图片？
            </AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复，此前已分享的图片外链将立即失效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyAction}
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {busyAction ? '正在删除…' : '确认永久删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
