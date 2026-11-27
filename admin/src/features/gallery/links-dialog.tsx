import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Globe, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  api,
  errorMessage,
  imageLink,
  latestPictures,
  LINK_FORMATS,
  sharingProblem,
  useMe,
  type Picture,
} from '@/lib/api';

export async function copyTextToClipboard(text: string, label = '链接已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
    return true;
  } catch {
    toast.error('未能自动复制，请选中下方文本手动复制');
    return false;
  }
}

export function LinksDialog({
  pictures,
  all = false,
  onClose,
}: {
  pictures: Picture[];
  all?: boolean;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<string>('url');
  const [publishing, setPublishing] = useState(false);
  const me = useMe();
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['image-links', all, pictures.map((item) => item.id)],
    enabled: pictures.length > 0,
    queryFn: ({ signal }) => latestPictures(pictures, all, signal),
    refetchInterval: (q) =>
      q.state.data?.some((item) =>
        ['pending', 'running'].includes(item.moderation_status),
      )
        ? 5000
        : false,
  });

  const currentItems = query.data || [];
  const shareable = currentItems.filter((item) => !sharingProblem(item));
  const skippedCount = currentItems.length - shareable.length;
  const text = shareable.map((item) => imageLink(item, format)).join('\n');

  const singleItem = currentItems.length === 1 ? currentItems[0] : null;
  const singleProblem = singleItem ? sharingProblem(singleItem) : null;
  const canMakePublic =
    singleItem &&
    !singleItem.is_public &&
    !singleItem.deleted_at &&
    !['blocked', 'review'].includes(singleItem.moderation_status) &&
    singleItem.user_id === me.data?.user.id;

  async function publishAndCopy(item: Picture) {
    setPublishing(true);
    try {
      await api(`/images/${item.id}/visibility`, 'PATCH', { is_public: true });
      const [refetched] = await Promise.all([
        query.refetch(),
        client.invalidateQueries({ queryKey: ['images'] }),
      ]);
      const updated = refetched.data?.[0] || { ...item, is_public: true };
      if (!sharingProblem(updated)) {
        await copyTextToClipboard(
          imageLink(updated, format),
          '已设为公开并复制链接',
        );
      } else {
        toast.success('已设为公开');
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Dialog
      open={pictures.length > 0}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[620px] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>复制图片外链</DialogTitle>
          <DialogDescription className="truncate">
            {pictures.length === 1
              ? pictures[0].original_name
              : `已选 ${pictures.length} 张图片，按行输出外链`}
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <div className="py-8 text-center text-sm text-muted-foreground" role="status">
            正在同步图片最新状态…
          </div>
        ) : query.isError ? (
          <div role="alert" className="space-y-3 py-4">
            <p className="text-sm text-destructive">
              {errorMessage(query.error, '无法核对图片状态')}
            </p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </div>
        ) : (
          <div className="space-y-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger
                  aria-label="外链格式"
                  className="w-full sm:w-[230px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINK_FORMATS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-xs text-muted-foreground ms-auto">
                可分享 {shareable.length} 张
              </span>

              <Button
                variant="primary"
                disabled={query.isFetching || !shareable.length}
                onClick={() => void copyTextToClipboard(text)}
              >
                <Copy />
                复制全部链接
              </Button>
            </div>

            {singleProblem && (
              <Alert
                variant={canMakePublic ? 'info' : 'warning'}
                appearance="light"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 w-full">
                  <AlertTitle>{singleProblem}</AlertTitle>
                  {canMakePublic && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={publishing}
                      onClick={() => void publishAndCopy(singleItem)}
                    >
                      <Globe />
                      {publishing ? '正在公开…' : '设为公开并复制'}
                    </Button>
                  )}
                </div>
              </Alert>
            )}

            {!singleItem && skippedCount > 0 && (
              <p className="text-xs text-muted-foreground" role="status">
                已跳过 {skippedCount} 张私有或受限图片。
              </p>
            )}

            <Textarea
              aria-label="批量图片链接"
              readOnly
              rows={Math.min(7, Math.max(3, shareable.length))}
              value={text}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs leading-relaxed"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
