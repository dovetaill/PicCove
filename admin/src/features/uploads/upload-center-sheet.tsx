import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  FolderInput,
  PauseCircle,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { LinksDialog } from '@/features/gallery/links-dialog';
import {
  api,
  errorMessage,
  latestPictures,
  sharingProblem,
  type Album,
  type Picture,
} from '@/lib/api';
import { useUploads } from './upload-manager';

export function UploadCenterSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    queue,
    busy,
    retryAfter,
    retryFailed,
    clearQueue,
    clearCompleted,
    removePending,
    stopWaiting,
    storageError,
    updateImages,
  } = useUploads();
  const client = useQueryClient();
  const [copyingItems, setCopyingItems] = useState<Picture[]>([]);
  const [movingId, setMovingId] = useState<string | null>(null);

  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
    enabled: open,
  });

  const completedCount = queue.filter((i) => i.status === '完成').length;
  const duplicateCount = queue.filter((i) => i.status === '已存在').length;
  const failedCount = queue.filter((i) => i.status === '失败').length;
  const retryableCount = queue.filter(
    (i) => ['失败', '等待重试'].includes(i.status) && i.file,
  ).length;
  const waitingCount = queue.filter((i) => i.status === '等待').length;
  const uploadedPictures = queue.flatMap((i) => (i.image ? [i.image] : []));
  const hasUnfinished = queue.some((i) => !i.image && i.file);

  const activeItem = queue.find((item) =>
    ['上传中', '服务器处理中', '核对结果'].includes(item.status),
  );

  async function quickCopy(picture: Picture) {
    try {
      const [latest] = await latestPictures([picture]);
      updateImages([latest]);
      if (sharingProblem(latest)) {
        setCopyingItems([latest]);
        return;
      }
      await navigator.clipboard.writeText(latest.url);
      toast.success('直链已复制');
    } catch {
      setCopyingItems([picture]);
    }
  }

  async function moveDuplicateToTarget(
    itemId: string,
    picture: Picture,
    targetAlbumId: string,
  ) {
    setMovingId(itemId);
    try {
      await api(`/images/${picture.id}`, 'PATCH', { album_id: targetAlbumId });
      updateImages([{ ...picture, album_id: targetAlbumId }]);
      await client.invalidateQueries({ queryKey: ['images'] });
      await client.invalidateQueries({ queryKey: ['albums'] });
      toast.success('已移入目标相册');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setMovingId(null);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <>
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0 gap-0">
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2">
              上传任务中心
              <Badge variant="secondary" size="sm">
                {queue.length}
              </Badge>
            </SheetTitle>
            <SheetDescription>
              成功 {completedCount} · 已存在 {duplicateCount} · 失败 {failedCount}
            </SheetDescription>
          </SheetHeader>

          <div className="px-6 py-3 border-b border-border bg-muted/40 flex flex-wrap items-center gap-2">
            {uploadedPictures.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCopyingItems(uploadedPictures)}
              >
                <Copy />
                复制本次链接
              </Button>
            )}
            {busy && waitingCount > 0 && (
              <Button size="sm" variant="outline" onClick={stopWaiting}>
                <PauseCircle />
                暂停后续（{waitingCount}）
              </Button>
            )}
            {retryableCount > 0 && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy || retryAfter > Date.now()}
                onClick={retryFailed}
              >
                <RotateCcw />
                {retryAfter > Date.now() ? '请稍候重试' : `重试未完成（${retryableCount}）`}
              </Button>
            )}
            <div className="ms-auto flex items-center gap-1.5">
              {(busy || hasUnfinished) &&
                completedCount + duplicateCount > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={clearCompleted}
                  >
                    清除已完成
                  </Button>
                )}
              {!busy && queue.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void clearQueue()}
                >
                  <Trash2 />
                  清空记录
                </Button>
              )}
            </div>
          </div>

          {storageError && (
            <div
              role="alert"
              className="mx-6 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            >
              {storageError}
            </div>
          )}

          {activeItem && (
            <div
              role="status"
              className="mx-6 mt-3 rounded-lg border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground truncate">
                  {activeItem.name}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {activeItem.status === '核对结果'
                    ? '核对中…'
                    : activeItem.status === '服务器处理中'
                      ? '正在保存…'
                      : `${activeItem.progress}%`}
                </span>
              </div>
              <Progress
                value={activeItem.progress}
                aria-label="当前图片传输进度"
              />
            </div>
          )}

          <ScrollArea className="flex-1 px-6 py-3">
            {queue.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                暂无上传记录
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {queue.map((item) => {
                  const currentAlbumName =
                    albums.data?.find((a) => a.id === item.image?.album_id)
                      ?.name || (item.image?.album_id ? '原相册' : '未归档');
                  const targetAlbumObj =
                    item.targetAlbum !== 'all'
                      ? albums.data?.find((a) => a.id === item.targetAlbum)
                      : undefined;
                  const canMoveDuplicate =
                    item.status === '已存在' &&
                    item.image &&
                    targetAlbumObj &&
                    item.image.album_id !== targetAlbumObj.id;

                  return (
                    <li key={item.id} className="py-3 space-y-1.5">
                      <div className="flex items-center gap-3">
                        {item.image ? (
                          <img
                            src={item.image.thumbnail_url || item.image.url}
                            alt=""
                            className="size-10 rounded-md object-cover bg-muted border border-border shrink-0"
                          />
                        ) : (
                          <div className="size-10 rounded-md bg-muted flex items-center justify-center shrink-0">
                            {item.status === '失败' ? (
                              <AlertCircle className="size-4 text-destructive" />
                            ) : (
                              <CheckCircle2 className="size-4 text-muted-foreground" />
                            )}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p
                            className="text-sm font-medium text-foreground truncate"
                            title={item.name}
                          >
                            {item.name}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Badge
                              size="xs"
                              appearance="light"
                              variant={
                                item.status === '完成'
                                  ? 'success'
                                  : item.status === '已存在'
                                    ? 'info'
                                    : item.status === '失败'
                                      ? 'destructive'
                                      : 'secondary'
                              }
                            >
                              {item.status}
                            </Badge>
                            {item.status === '已存在' && item.image && (
                              <span className="text-xs text-muted-foreground truncate">
                                {item.image.is_public ? '公开' : '私有'} · 位于：{currentAlbumName}
                              </span>
                            )}
                          </div>
                        </div>
                        {item.image ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void quickCopy(item.image!)}
                            aria-label={`复制上传结果 ${item.name}`}
                          >
                            <Copy />
                            复制
                          </Button>
                        ) : (
                          ['等待', '失败', '等待重试'].includes(item.status) && (
                            <Button
                              size="sm"
                              mode="icon"
                              variant="ghost"
                              onClick={() => removePending(item.id)}
                              aria-label={`移除待上传 ${item.name}`}
                            >
                              <X />
                            </Button>
                          )
                        )}
                      </div>

                      {item.error && (
                        <p className="text-xs text-destructive ps-13">
                          {item.error}
                        </p>
                      )}

                      {canMoveDuplicate && (
                        <div className="ps-13 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={movingId === item.id}
                            onClick={() =>
                              void moveDuplicateToTarget(
                                item.id,
                                item.image!,
                                targetAlbumObj.id,
                              )
                            }
                          >
                            <FolderInput />
                            移入「{targetAlbumObj.name}」
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <LinksDialog
        pictures={copyingItems}
        onClose={() => setCopyingItems([])}
      />
    </>
  );
}
