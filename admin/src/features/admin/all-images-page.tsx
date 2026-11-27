import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ColumnDef,
  getCoreRowModel,
  type PaginationState,
  useReactTable,
} from '@tanstack/react-table';
import {
  Copy,
  Globe,
  Info,
  LayoutGrid,
  List,
  Lock,
  MoreHorizontal,
  QrCode,
  Search,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
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
  CardFooter,
  CardHeader,
  CardTable,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DataGrid } from '@/components/ui/data-grid';
import { DataGridPagination } from '@/components/ui/data-grid-pagination';
import { DataGridTable } from '@/components/ui/data-grid-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ImageDetailSheet } from '@/features/gallery/image-detail-sheet';
import { copyTextToClipboard, LinksDialog } from '@/features/gallery/links-dialog';
import { LightboxDialog } from '@/features/gallery/lightbox-dialog';
import { ShareQrDialog } from '@/features/gallery/share-qr-dialog';
import { useUploads } from '@/features/uploads/upload-manager';
import {
  api,
  ApiError,
  errorMessage,
  latestPictures,
  REVIEW_LABELS,
  reviewBadgeVariant,
  sharingProblem,
  size,
  type BatchImageResult,
  type Page,
  type Picture,
} from '@/lib/api';
import { cn, formatShortDate } from '@/lib/utils';

export function AllImagesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filterUserId = searchParams.get('user') || '';
  const filterUsername = searchParams.get('username') || '';

  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 48,
  });
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState('all');
  const [moderationFilter, setModerationFilter] = useState('all');

  const [selected, setSelected] = useState<string[]>([]);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<Picture | null>(null);
  const [copying, setCopying] = useState<Picture[]>([]);
  const [qrPic, setQrPic] = useState<Picture | null>(null);
  const [deleting, setDeleting] = useState<Picture[]>([]);
  const [busyDelete, setBusyDelete] = useState(false);

  const client = useQueryClient();
  const { removeImage, updateImages } = useUploads();

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    setSelected([]);
  }, [debouncedQuery, visibilityFilter, moderationFilter, filterUserId]);

  const page = pagination.pageIndex + 1;
  const queryParams = new URLSearchParams();
  queryParams.set('all', 'true');
  queryParams.set('page', String(page));
  if (debouncedQuery) queryParams.set('q', debouncedQuery);
  if (visibilityFilter === 'public') queryParams.set('is_public', 'true');
  if (visibilityFilter === 'private') queryParams.set('is_public', 'false');
  if (moderationFilter !== 'all')
    queryParams.set('moderation_status', moderationFilter);
  if (filterUserId) queryParams.set('user_id', filterUserId);

  const images = useQuery({
    queryKey: [
      'images',
      true,
      page,
      debouncedQuery,
      visibilityFilter,
      moderationFilter,
      filterUserId,
    ],
    queryFn: () => api<Page<Picture>>(`/images?${queryParams.toString()}`),
    refetchInterval: (q) =>
      q.state.data?.items.some((i) =>
        ['pending', 'running'].includes(i.moderation_status),
      )
        ? 5000
        : false,
  });

  const items = images.data?.items || [];
  const totalCount =
    images.data?.total ??
    (images.data?.has_more ? page * 48 + 1 : (page - 1) * 48 + items.length);
  const chosen = items.filter((i) => selected.includes(i.id));

  useEffect(() => {
    if (
      !images.isPending &&
      !images.isFetching &&
      !images.isError &&
      pagination.pageIndex > 0 &&
      items.length === 0
    ) {
      setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }));
      setSelected([]);
    }
  }, [
    images.isPending,
    images.isFetching,
    images.isError,
    items.length,
    pagination.pageIndex,
  ]);

  async function quickCopy(pic: Picture) {
    try {
      const [latest] = await latestPictures([pic], true);
      if (
        sharingProblem(latest) ||
        !(await copyTextToClipboard(latest.url, '直链已复制'))
      ) {
        setCopying([latest]);
      }
    } catch {
      setCopying([pic]);
    }
  }

  async function confirmDelete() {
    if (!deleting.length || busyDelete) return;
    setBusyDelete(true);
    try {
      if (deleting.length > 1) {
        await api<BatchImageResult>('/images/batch', 'POST', {
          ids: deleting.map((item) => item.id),
          action: 'delete',
        });
        for (const item of deleting) {
          removeImage(item.id);
          if (inspecting?.id === item.id) setInspecting(null);
        }
        setDeleting([]);
      } else {
        for (const item of deleting) {
          try {
            await api(`/images/${item.id}`, 'DELETE');
            removeImage(item.id);
          } catch (err) {
            if (
              err instanceof ApiError &&
              (err.status === 404 || err.status >= 500)
            ) {
              removeImage(item.id);
            }
            throw err;
          }
          if (inspecting?.id === item.id) setInspecting(null);
          setDeleting((curr) => curr.filter((r) => r.id !== item.id));
        }
      }
      setSelected([]);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
        client.invalidateQueries({ queryKey: ['users'] }),
      ]);
      toast.success('已删除所选托管图片');
    } catch (error) {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
        client.invalidateQueries({ queryKey: ['users'] }),
      ]);
      toast.error(errorMessage(error));
    } finally {
      setBusyDelete(false);
    }
  }

  function filterByUser(userId: string, username?: string) {
    const next = new URLSearchParams();
    next.set('user', userId);
    if (username) next.set('username', username);
    setSearchParams(next);
  }

  const columns = useMemo<ColumnDef<Picture>[]>(
    () => [
      {
        id: 'select',
        header: () => (
          <Checkbox
            size="sm"
            checked={items.length > 0 && chosen.length === items.length}
            onCheckedChange={(v) =>
              setSelected(v === true ? items.map((i) => i.id) : [])
            }
            aria-label="选择本页全部图片"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            size="sm"
            checked={selected.includes(row.original.id)}
            onCheckedChange={(v) =>
              setSelected((prev) =>
                v === true
                  ? [...prev, row.original.id]
                  : prev.filter((id) => id !== row.original.id),
              )
            }
            aria-label={`选择 ${row.original.original_name}`}
          />
        ),
        size: 44,
        enableSorting: false,
      },
      {
        id: 'image',
        header: '图片',
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center gap-3 min-w-[220px]">
              <button
                type="button"
                onClick={() => setLightboxId(item.id)}
                className="cursor-pointer size-11 rounded-lg bg-muted border border-border overflow-hidden shrink-0 flex items-center justify-center"
              >
                {item.deleted_at ? (
                  <span className="text-[10px] text-muted-foreground">待清</span>
                ) : (
                  <img
                    src={item.thumbnail_url || item.url}
                    alt={item.original_name}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                )}
              </button>
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => setInspecting(item)}
                  className="cursor-pointer text-sm font-medium text-mono hover:text-primary truncate block max-w-[240px]"
                  title={item.original_name}
                >
                  {item.original_name}
                </button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {item.width} × {item.height} · {size(item.size_bytes)}
                </span>
              </div>
            </div>
          );
        },
        size: 300,
      },
      {
        id: 'owner',
        header: '所属用户',
        cell: ({ row }) => {
          const item = row.original;
          const displayName = item.username || item.user_id.slice(0, 8);
          return (
            <button
              type="button"
              onClick={() => filterByUser(item.user_id, item.username)}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs font-medium text-mono hover:border-primary/50 hover:text-primary transition-colors"
              title="点击只看该用户的图片"
            >
              <UserCheck className="size-3 text-muted-foreground" />
              {displayName}
            </button>
          );
        },
        size: 140,
      },
      {
        id: 'visibility',
        header: '访问权限',
        cell: ({ row }) =>
          row.original.is_public ? (
            <Badge size="sm" variant="success" appearance="light">
              <Globe className="size-3" />
              公开
            </Badge>
          ) : (
            <Badge size="sm" variant="secondary" appearance="light">
              <Lock className="size-3" />
              私有
            </Badge>
          ),
        size: 110,
      },
      {
        id: 'moderation',
        header: '审核状态',
        cell: ({ row }) => (
          <Badge
            size="sm"
            appearance="light"
            variant={reviewBadgeVariant(row.original.moderation_status)}
          >
            {REVIEW_LABELS[row.original.moderation_status] ||
              row.original.moderation_status}
          </Badge>
        ),
        size: 120,
      },
      {
        id: 'created',
        header: '上传时间',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatShortDate(row.original.created_at)}
          </span>
        ),
        size: 130,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                size="sm"
                mode="icon"
                variant="ghost"
                disabled={!!item.deleted_at}
                onClick={() => void quickCopy(item)}
                aria-label={`复制 ${item.original_name} 链接`}
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
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setInspecting(item)}>
                    <Info />
                    查看详情
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCopying([item])}>
                    <Copy />
                    选择外链格式
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!!sharingProblem(item)}
                    onSelect={() => setQrPic(item)}
                  >
                    <QrCode />
                    二维码
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting([item])}
                  >
                    <Trash2 />
                    下架并删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
        size: 90,
      },
    ],
    [items, chosen.length, selected],
  );

  const table = useReactTable({
    data: items,
    columns,
    pageCount: Math.max(1, Math.ceil(totalCount / 48)),
    state: { pagination },
    onPaginationChange: setPagination,
    manualPagination: true,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="container space-y-5 pb-20">
      <Toolbar className="pb-1">
        <ToolbarHeading
          title="全部托管图片"
          description="检索全站用户托管图片，支持按用户、可见性及审核状态过滤或批量下架"
          badge={
            images.data?.total !== undefined ? (
              <Badge variant="secondary" appearance="light" size="sm">
                共 {images.data.total} 张
              </Badge>
            ) : undefined
          }
        />
        <ToolbarActions>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5 bg-muted/40">
            <Button
              size="sm"
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setViewMode('table')}
            >
              <List className="size-3.5" />
              列表
            </Button>
            <Button
              size="sm"
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid className="size-3.5" />
              网格
            </Button>
          </div>
        </ToolbarActions>
      </Toolbar>

      <DataGrid
        table={table}
        recordCount={totalCount}
        isLoading={images.isPending}
        emptyMessage="没有符合条件的托管图片"
      >
        <Card>
          <CardHeader className="py-3.5">
            <div className="flex flex-wrap items-center gap-2.5 w-full">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="size-3.5 text-muted-foreground absolute start-2.5 top-1/2 -translate-y-1/2" />
                <Input
                  variant="sm"
                  value={searchInput}
                  maxLength={200}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="搜索图片文件名…"
                  aria-label="搜索图片文件名"
                  className="ps-8 pe-7"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput('')}
                    className="cursor-pointer absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              <Select
                value={visibilityFilter}
                onValueChange={setVisibilityFilter}
              >
                <SelectTrigger
                  aria-label="访问权限筛选"
                  size="sm"
                  className="w-[115px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部权限</SelectItem>
                  <SelectItem value="public">公开图片</SelectItem>
                  <SelectItem value="private">私有图片</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={moderationFilter}
                onValueChange={setModerationFilter}
              >
                <SelectTrigger
                  aria-label="审核状态筛选"
                  size="sm"
                  className="w-[125px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部审核态</SelectItem>
                  <SelectItem value="passed">已通过</SelectItem>
                  <SelectItem value="review">待人工复核</SelectItem>
                  <SelectItem value="blocked">违规拦截</SelectItem>
                  <SelectItem value="pending">待审核</SelectItem>
                  <SelectItem value="failed">审核失败</SelectItem>
                </SelectContent>
              </Select>

              {filterUserId && (
                <Badge
                  variant="primary"
                  appearance="light"
                  size="md"
                  className="gap-1.5"
                >
                  用户：{filterUsername || filterUserId.slice(0, 8)}
                  <button
                    type="button"
                    aria-label="清除用户筛选"
                    onClick={() => setSearchParams({})}
                    className="cursor-pointer hover:opacity-75"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
            </div>
          </CardHeader>

          {images.isError ? (
            <CardContent className="py-12 text-center space-y-3" role="alert">
              <p className="text-sm text-destructive">
                {errorMessage(images.error)}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void images.refetch()}
              >
                重试
              </Button>
            </CardContent>
          ) : viewMode === 'table' ? (
            <CardTable>
              <ScrollArea>
                <DataGridTable />
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </CardTable>
          ) : (
            <CardContent className="p-4">
              {items.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  没有符合条件的托管图片
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {items.map((item) => {
                    const isSelected = selected.includes(item.id);
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'group rounded-xl border overflow-hidden bg-card transition-all',
                          isSelected
                            ? 'ring-2 ring-primary border-primary'
                            : 'border-border hover:border-primary/40',
                        )}
                      >
                        <div className="relative aspect-[4/3] bg-muted/60">
                          <button
                            type="button"
                            onClick={() => setLightboxId(item.id)}
                            className="cursor-pointer w-full h-full flex items-center justify-center"
                          >
                            {item.deleted_at ? (
                              <span className="text-xs text-muted-foreground">
                                待清理
                              </span>
                            ) : (
                              <img
                                src={item.thumbnail_url || item.url}
                                alt={item.original_name}
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            )}
                          </button>
                          <div className="absolute start-2 top-2">
                            <Checkbox
                              size="sm"
                              checked={isSelected}
                              onCheckedChange={(v) =>
                                setSelected((prev) =>
                                  v === true
                                    ? [...prev, item.id]
                                    : prev.filter((id) => id !== item.id),
                                )
                              }
                              aria-label={`选择 ${item.original_name}`}
                              className="bg-background/90"
                            />
                          </div>
                          <div className="absolute end-2 top-2 flex flex-col items-end gap-1">
                            {!item.is_public && (
                              <Badge
                                size="xs"
                                variant="secondary"
                                className="bg-zinc-900/75 text-white border-0"
                              >
                                私有
                              </Badge>
                            )}
                            <Badge
                              size="xs"
                              variant={reviewBadgeVariant(item.moderation_status)}
                            >
                              {REVIEW_LABELS[item.moderation_status] ||
                                item.moderation_status}
                            </Badge>
                          </div>
                        </div>

                        <div className="p-3 space-y-1.5">
                          <div className="flex items-center justify-between gap-1">
                            <button
                              type="button"
                              onClick={() => setInspecting(item)}
                              className="cursor-pointer text-xs font-medium text-mono truncate hover:text-primary"
                            >
                              {item.original_name}
                            </button>
                            <Button
                              size="sm"
                              mode="icon"
                              variant="ghost"
                              className="size-6.5 shrink-0"
                              onClick={() => setDeleting([item])}
                              aria-label={`删除 ${item.original_name}`}
                            >
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <button
                              type="button"
                              onClick={() =>
                                filterByUser(item.user_id, item.username)
                              }
                              className="cursor-pointer hover:text-primary font-medium truncate"
                            >
                              @{item.username || item.user_id.slice(0, 8)}
                            </button>
                            <span className="tabular-nums">
                              {size(item.size_bytes)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          )}

          <CardFooter>
            <DataGridPagination />
          </CardFooter>
        </Card>
      </DataGrid>

      {chosen.length > 0 && (
        <div className="fixed bottom-5 start-1/2 -translate-x-1/2 z-30 rounded-2xl border border-border bg-card/95 backdrop-blur-md px-4 py-2.5 shadow-xl flex items-center gap-2">
          <Badge variant="primary" size="md">
            已选 {chosen.length} 张
          </Badge>
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
            variant="destructive"
            onClick={() => setDeleting(chosen)}
          >
            <Trash2 />
            批量删除
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            取消
          </Button>
        </div>
      )}

      <LightboxDialog
        items={items}
        activeId={lightboxId}
        onSelectId={setLightboxId}
        onInspect={(pic) => setInspecting(pic)}
        onOpenLinks={(pic) => setCopying([pic])}
      />

      <ImageDetailSheet
        picture={inspecting}
        onClose={() => setInspecting(null)}
        onUpdated={(updated) => {
          setInspecting(updated);
          updateImages([updated]);
        }}
        onOpenLightbox={(pic) => {
          setInspecting(null);
          setLightboxId(pic.id);
        }}
        onOpenQr={(pic) => setQrPic(pic)}
        onDelete={(pic) => setDeleting([pic])}
      />

      <LinksDialog all pictures={copying} onClose={() => setCopying([])} />
      <ShareQrDialog all image={qrPic} onClose={() => setQrPic(null)} />

      <AlertDialog
        open={deleting.length > 0}
        onOpenChange={(open) => {
          if (!open && !busyDelete) setDeleting([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              下架并永久删除 {deleting.length} 张图片？
            </AlertDialogTitle>
            <AlertDialogDescription>
              删除操作不可恢复，对应外链将立即失效并释放所属用户配额占用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyDelete}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyDelete}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busyDelete ? '正在删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
