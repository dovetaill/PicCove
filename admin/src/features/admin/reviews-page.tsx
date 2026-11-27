import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  Maximize2,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Toolbar, ToolbarHeading } from '@/components/layout/page-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LightboxDialog } from '@/features/gallery/lightbox-dialog';
import {
  api,
  errorMessage,
  REVIEW_LABELS,
  reviewBadgeVariant,
  type Page,
  type Picture,
  type ReviewItem,
} from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

const STATUS_TABS = [
  ['all', '全部记录'],
  ['review', '待复核'],
  ['blocked', '已拦截'],
  ['failed', '审核失败'],
  ['pending', '排队中'],
  ['passed', '已通过'],
  ['exempt', '免审'],
] as const;

export function ReviewsPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewPic, setPreviewPic] = useState<Picture | null>(null);
  const client = useQueryClient();

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedQuery]);

  const params = new URLSearchParams();
  params.set('page', String(page));
  if (statusFilter !== 'all') params.set('status', statusFilter);
  if (debouncedQuery) params.set('q', debouncedQuery);

  const query = useQuery({
    queryKey: ['reviews', page, statusFilter, debouncedQuery],
    queryFn: () => api<Page<ReviewItem>>(`/admin/reviews?${params.toString()}`),
    refetchInterval: 5000,
  });

  const items = query.data?.items || [];
  const total = query.data?.total;
  const totalPages =
    total !== undefined ? Math.max(page, Math.ceil(total / 48)) : null;

  useEffect(() => {
    if (
      !query.isPending &&
      !query.isFetching &&
      !query.isError &&
      page > 1 &&
      items.length === 0
    ) {
      setPage((p) => p - 1);
    }
  }, [query.isPending, query.isFetching, query.isError, items.length, page]);

  async function decide(id: string, decision: 'passed' | 'blocked') {
    if (busyId) return;
    setBusyId(id);
    try {
      await api(`/admin/reviews/${id}`, 'PATCH', { decision });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['reviews'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['users'] }),
      ]);
      toast.success(decision === 'passed' ? '已标记为通过' : '已确认违规并拦截');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function retry(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      await api(`/admin/reviews/${id}/retry`, 'POST');
      await client.invalidateQueries({ queryKey: ['reviews'] });
      toast.success('已重新提交审核');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function openLightboxForReview(imageId: string) {
    try {
      const res = await api<Page<Picture>>(`/images?all=true&ids=${imageId}`);
      if (res.items[0]) {
        setPreviewPic(res.items[0]);
        return;
      }
    } catch {
      // Fallback to direct preview object.
    }
    setPreviewPic({
      id: imageId,
      user_id: '',
      album_id: null,
      original_name: `审核图片 ${imageId.slice(0, 8)}`,
      size_bytes: 0,
      width: 0,
      height: 0,
      url: `/i/${imageId}`,
      thumbnail_url: `/api/v1/images/${imageId}/thumbnail`,
      deleted_at: null,
      is_public: false,
      moderation_status: 'review',
      moderation_reason: '',
      moderation_hold: false,
    });
  }

  return (
    <div className="container space-y-5">
      <Toolbar className="pb-1">
        <ToolbarHeading
          title="图片审核"
          description="人工复核疑似内容，处理误判或执行违规拦截"
          badge={
            total !== undefined ? (
              <Badge variant="secondary" appearance="light" size="sm">
                {total} 条记录
              </Badge>
            ) : undefined
          }
        />
      </Toolbar>

      {/* Filter Bar */}
      <Card>
        <CardContent className="p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3">
          <Tabs value={statusFilter} onValueChange={setStatusFilter}>
            <TabsList className="flex-wrap h-auto">
              {STATUS_TABS.map(([val, label]) => (
                <TabsTrigger key={val} value={val} className="text-xs">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-64">
            <Search className="size-3.5 text-muted-foreground absolute start-2.5 top-1/2 -translate-y-1/2" />
            <Input
              variant="sm"
              value={searchInput}
              maxLength={200}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索用户名或原因…"
              aria-label="搜索审核记录"
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
        </CardContent>
      </Card>

      {query.isPending ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 flex gap-4">
                <Skeleton className="w-36 h-28 rounded-lg shrink-0" />
                <div className="flex-1 space-y-2.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-8 w-44" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3" role="alert">
            <p className="text-sm text-destructive">
              {errorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent
            role="status"
            className="py-16 flex flex-col items-center text-center gap-3"
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-6" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-mono">
                {statusFilter !== 'all' || debouncedQuery
                  ? '没有匹配的审核记录'
                  : '暂无审核记录'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {statusFilter !== 'all' || debouncedQuery
                  ? '可切换状态分类或清空搜索词查看全部记录'
                  : '启用 AI 内容审核后，新增上传与生成图片的审核结果将汇总在此'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3.5">
          {items.map((r) => {
            const isBusy = busyId === r.id;
            return (
              <Card key={r.id}>
                <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row gap-4 sm:items-center">
                  {/* Thumbnail */}
                  <div className="w-full sm:w-40 h-32 rounded-xl border border-border bg-muted/50 flex items-center justify-center overflow-hidden shrink-0 relative group">
                    {r.image_id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void openLightboxForReview(r.image_id!)}
                          className="cursor-pointer w-full h-full flex items-center justify-center"
                        >
                          <img
                            src={`/api/v1/images/${r.image_id}/thumbnail`}
                            alt="审核图片"
                            loading="lazy"
                            className="max-h-full max-w-full object-contain"
                          />
                        </button>
                        <Button
                          size="sm"
                          mode="icon"
                          variant="secondary"
                          aria-label="放大查看"
                          onClick={() => void openLightboxForReview(r.image_id!)}
                          className="size-7 absolute top-2 end-2 opacity-0 group-hover:opacity-95 transition-opacity"
                        >
                          <Maximize2 className="size-3.5" />
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground px-3 text-center">
                        原图已删除
                      </span>
                    )}
                  </div>

                  {/* Metadata & Reason */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-mono">
                        {r.username}
                      </span>
                      <Badge
                        size="sm"
                        appearance="light"
                        variant={reviewBadgeVariant(r.status)}
                      >
                        {REVIEW_LABELS[r.status] || r.status}
                      </Badge>
                      {r.counted && (
                        <Badge
                          size="sm"
                          variant="destructive"
                          appearance="outline"
                        >
                          已计违规
                        </Badge>
                      )}
                      {r.categories.map((cat) => (
                        <Badge key={cat} size="xs" variant="secondary">
                          {cat}
                        </Badge>
                      ))}
                      <span className="text-xs text-muted-foreground sm:ms-auto tabular-nums">
                        {formatDateTime(r.created_at)} · 尝试 {r.attempts} 次
                      </span>
                    </div>

                    <p className="text-sm text-secondary-foreground leading-relaxed break-words">
                      {r.reason || '等待审核模型返回结果…'}
                    </p>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        variant={r.status === 'passed' ? 'outline' : 'primary'}
                        disabled={isBusy}
                        onClick={() => void decide(r.id, 'passed')}
                      >
                        <CheckCircle2 />
                        通过／撤销误判
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          r.status === 'blocked' ? 'outline' : 'destructive'
                        }
                        disabled={isBusy}
                        onClick={() => void decide(r.id, 'blocked')}
                      >
                        <Ban />
                        确认违规
                      </Button>
                      {r.status === 'failed' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isBusy}
                          onClick={() => void retry(r.id)}
                        >
                          <RotateCcw />
                          重试审核
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {(page > 1 || !!query.data?.has_more) && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
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
            disabled={!query.data?.has_more}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
            <ArrowRight />
          </Button>
        </div>
      )}

      <LightboxDialog
        items={previewPic ? [previewPic] : []}
        activeId={previewPic?.id || null}
        onSelectId={(id) => {
          if (!id) setPreviewPic(null);
        }}
      />
    </div>
  );
}
