import { useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  imageLink,
  REVIEW_LABELS,
  reviewBadgeVariant,
  sharingProblem,
  size,
  useMe,
  type Picture,
} from '@/lib/api';
import { copyTextToClipboard } from './links-dialog';

export function LightboxDialog({
  items,
  activeId,
  onSelectId,
  onInspect,
  onOpenLinks,
}: {
  items: Picture[];
  activeId: string | null;
  onSelectId: (id: string | null) => void;
  onInspect?: (picture: Picture) => void;
  onOpenLinks?: (picture: Picture) => void;
}) {
  const me = useMe();
  const index = activeId ? items.findIndex((i) => i.id === activeId) : -1;
  const current = index >= 0 ? items[index] : null;
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < items.length - 1;

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onSelectId(items[index - 1].id);
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onSelectId(items[index + 1].id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, hasPrev, hasNext, index, items, onSelectId]);

  const restrictedForViewer =
    current &&
    (!!current.deleted_at ||
      (['blocked', 'review'].includes(current.moderation_status) &&
        !me.data?.user.is_admin));

  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) onSelectId(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-[95vw] sm:max-w-[92vw] h-[90dvh] p-0 gap-0 bg-zinc-950/95 text-zinc-100 border-zinc-800 flex flex-col overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {current?.original_name || '图片预览'}
        </DialogTitle>

        {current && (
          <>
            {/* Top Bar */}
            <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-14 border-b border-zinc-800/80 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="font-medium text-sm truncate text-white">
                  {current.original_name}
                </span>
                <span className="hidden sm:inline text-xs text-zinc-400 tabular-nums shrink-0">
                  {current.width} × {current.height} · {size(current.size_bytes)}
                </span>
                <Badge
                  size="sm"
                  variant={current.is_public ? 'success' : 'secondary'}
                  appearance="light"
                >
                  {current.is_public ? '公开' : '私有'}
                </Badge>
                {current.moderation_status &&
                  current.moderation_status !== 'unreviewed' && (
                    <Badge
                      size="sm"
                      variant={reviewBadgeVariant(current.moderation_status)}
                      appearance="light"
                    >
                      {REVIEW_LABELS[current.moderation_status] ||
                        current.moderation_status}
                    </Badge>
                  )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {!sharingProblem(current) ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="复制直链"
                      className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
                      onClick={() => void copyTextToClipboard(current.url, '直链已复制')}
                    >
                      <Copy />
                      <span className="hidden sm:inline">直链</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-zinc-200 hover:bg-zinc-800 hover:text-white hidden md:inline-flex"
                      onClick={() =>
                        void copyTextToClipboard(
                          imageLink(current, 'markdown'),
                          'Markdown 已复制',
                        )
                      }
                    >
                      <Copy />
                      Markdown
                    </Button>
                  </>
                ) : (
                  onOpenLinks && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
                      onClick={() => {
                        onSelectId(null);
                        onOpenLinks(current);
                      }}
                    >
                      <Copy />
                      分享设置
                    </Button>
                  )
                )}

                {onInspect && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="查看详情"
                    className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    onClick={() => {
                      onSelectId(null);
                      onInspect(current);
                    }}
                  >
                    <Info />
                    <span className="hidden sm:inline">详情</span>
                  </Button>
                )}

                {!restrictedForViewer && (
                  <Button
                    size="sm"
                    mode="icon"
                    variant="ghost"
                    asChild
                    className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
                  >
                    <a
                      href={current.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="新窗口查看原图"
                      title="新窗口打开原图"
                    >
                      <ExternalLink />
                    </a>
                  </Button>
                )}

                <Button
                  size="sm"
                  mode="icon"
                  variant="ghost"
                  aria-label="关闭预览"
                  className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
                  onClick={() => onSelectId(null)}
                >
                  <X />
                </Button>
              </div>
            </div>

            {/* Canvas */}
            <div className="relative flex-1 flex items-center justify-center p-4 sm:p-8 min-h-0 select-none">
              {hasPrev && (
                <Button
                  mode="icon"
                  variant="ghost"
                  aria-label="上一张"
                  onClick={() => onSelectId(items[index - 1].id)}
                  className="absolute start-3 top-1/2 -translate-y-1/2 z-10 size-10 rounded-full bg-zinc-900/80 text-white hover:bg-zinc-800 border border-zinc-700/60"
                >
                  <ChevronLeft className="size-5" />
                </Button>
              )}

              {restrictedForViewer ? (
                <div className="text-center space-y-2 text-zinc-400">
                  <p className="text-sm">
                    {current.deleted_at
                      ? '图片待清理'
                      : current.moderation_reason || '该图片因审核限制暂不可预览'}
                  </p>
                </div>
              ) : (
                <img
                  src={current.url}
                  alt={current.original_name}
                  className="max-h-full max-w-full object-contain rounded-md shadow-2xl"
                />
              )}

              {hasNext && (
                <Button
                  mode="icon"
                  variant="ghost"
                  aria-label="下一张"
                  onClick={() => onSelectId(items[index + 1].id)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 z-10 size-10 rounded-full bg-zinc-900/80 text-white hover:bg-zinc-800 border border-zinc-700/60"
                >
                  <ChevronRight className="size-5" />
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
