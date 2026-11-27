import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Copy,
  FolderInput,
  Globe,
  History,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Alert, AlertTitle } from '@/components/ui/alert';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { copyTextToClipboard, LinksDialog } from '@/features/gallery/links-dialog';
import { LightboxDialog } from '@/features/gallery/lightbox-dialog';
import {
  api,
  errorMessage,
  latestPictures,
  REVIEW_LABELS,
  reviewBadgeVariant,
  sharingProblem,
  useMe,
  type AiConversation,
  type AiMessage,
  type AiStatus,
  type Album,
  type Page,
  type Picture,
} from '@/lib/api';
import { uploadImage } from '@/lib/upload';
import { cn } from '@/lib/utils';

function MessageImageCard({
  id,
  status,
  reason,
  isGenerated = false,
  onPreview,
  onShare,
  onMoveAlbum,
}: {
  id: string;
  status: string | null;
  reason?: string | null;
  isGenerated?: boolean;
  onPreview: (id: string) => void;
  onShare?: (id: string) => void;
  onMoveAlbum?: (id: string) => void;
}) {
  const me = useMe();
  const restricted =
    ['blocked', 'review'].includes(status || '') && !me.data?.user.is_admin;

  if (restricted) {
    return (
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400"
      >
        图片受审核限制：{reason || REVIEW_LABELS[status || ''] || '暂不可查看'}
      </div>
    );
  }

  return (
    <div className="inline-flex flex-col gap-2 max-w-full">
      <div className="relative group rounded-2xl border border-border overflow-hidden bg-muted/40 max-w-md">
        <button
          type="button"
          onClick={() => onPreview(id)}
          className="cursor-pointer block focus-visible:outline-hidden"
        >
          <img
            src={`/api/v1/images/${id}/thumbnail`}
            onError={(e) => {
              const target = e.currentTarget;
              if (!target.src.endsWith(`/i/${id}`)) {
                target.src = `/i/${id}`;
              }
            }}
            alt="对话图片"
            className="max-h-80 w-auto object-contain"
          />
        </button>
        <Button
          size="sm"
          mode="icon"
          variant="secondary"
          aria-label="预览大图"
          onClick={() => onPreview(id)}
          className="size-7.5 absolute top-2.5 end-2.5 opacity-0 group-hover:opacity-95 transition-opacity shadow-xs"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>

      {isGenerated && (
        <div className="flex flex-wrap items-center gap-1.5">
          {status && status !== 'unreviewed' && (
            <Badge
              size="xs"
              appearance="light"
              variant={reviewBadgeVariant(status)}
            >
              {REVIEW_LABELS[status] || status}
            </Badge>
          )}
          {onShare && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2.5"
              onClick={() => onShare(id)}
            >
              <Copy className="size-3" />
              分享外链
            </Button>
          )}
          {onMoveAlbum && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2.5"
              onClick={() => onMoveAlbum(id)}
            >
              <FolderInput className="size-3" />
              归入相册
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function AiStudioPage() {
  const messageEndRef = useRef<HTMLDivElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busySend, setBusySend] = useState(false);
  const [referenceUpload, setReferenceUpload] = useState<{
    name: string;
    progress: number;
  } | null>(null);
  const [reference, setReference] = useState<
    (Pick<Picture, 'id' | 'original_name' | 'is_public'> & {
      duplicate?: boolean;
    }) | null
  >(null);

  const [previewPic, setPreviewPic] = useState<Picture | null>(null);
  const [sharingPic, setSharingPic] = useState<Picture[]>([]);
  const [albumTargetPicId, setAlbumTargetPicId] = useState<string | null>(null);
  const [targetAlbumId, setTargetAlbumId] = useState<string>('none');
  const [savingAlbum, setSavingAlbum] = useState(false);
  const [renamingConv, setRenamingConv] = useState<AiConversation | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deletingConv, setDeletingConv] = useState<AiConversation | null>(null);
  const [busyConvOp, setBusyConvOp] = useState(false);

  const client = useQueryClient();
  const me = useMe();
  const ownerId = me.data?.user.id || '';

  const conversations = useQuery({
    queryKey: ['ai-conversations', ownerId, page],
    queryFn: () =>
      api<Page<AiConversation>>(`/ai/conversations?page=${page}`),
  });

  const status = useQuery({
    queryKey: ['ai-status', ownerId],
    queryFn: () => api<AiStatus>('/ai/status'),
  });

  const messages = useQuery({
    queryKey: ['ai-messages', selectedId],
    queryFn: () => api<AiMessage[]>(`/ai/conversations/${selectedId}`),
    enabled: !!selectedId,
    refetchInterval: (q) => {
      const list = q.state.data;
      if (!list) return false;
      const hasRunningTask = list.some((m) =>
        ['queued', 'running'].includes(m.status),
      );
      const hasPendingModeration = list.some(
        (m) =>
          ['pending', 'running'].includes(m.image_status || '') ||
          ['pending', 'running'].includes(m.reference_status || ''),
      );
      return hasRunningTask || hasPendingModeration ? 2500 : false;
    },
  });

  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
    enabled: !!albumTargetPicId,
  });

  const latestMsg = messages.data?.[messages.data.length - 1];

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedId, latestMsg?.id, latestMsg?.status]);

  const hadRunningRef = useRef(false);

  useEffect(() => {
    hadRunningRef.current = false;
  }, [selectedId]);

  useEffect(() => {
    const hasRunning = !!messages.data?.some((m) =>
      ['queued', 'running'].includes(m.status),
    );
    if (hasRunning) {
      hadRunningRef.current = true;
      return;
    }
    if (
      hadRunningRef.current &&
      messages.data?.some((m) => ['completed', 'failed'].includes(m.status))
    ) {
      hadRunningRef.current = false;
      void client.invalidateQueries({ queryKey: ['me'] });
      void client.invalidateQueries({ queryKey: ['ai-status'] });
      void client.invalidateQueries({ queryKey: ['images'] });
    }
  }, [messages.data, client]);

  const isGenerating = !!messages.data?.some((m) =>
    ['queued', 'running'].includes(m.status),
  );
  const isBanned = !!me.data?.user.content_ban;
  const isEmpty = !selectedId || (messages.data && messages.data.length === 0);
  const canSend =
    !busySend &&
    !referenceUpload &&
    !isBanned &&
    !isGenerating &&
    !!status.data?.enabled &&
    !!prompt.trim();

  async function resolvePictureById(id: string): Promise<Picture | null> {
    try {
      const pageRes = await api<Page<Picture>>(`/images?ids=${id}`);
      return pageRes.items[0] || null;
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    }
  }

  async function handleOpenPreview(id: string) {
    const pic = await resolvePictureById(id);
    if (pic) {
      setPreviewPic(pic);
    } else {
      window.open(`/i/${id}`, '_blank', 'noopener,noreferrer');
    }
  }

  async function handleOpenShare(id: string) {
    const pic = await resolvePictureById(id);
    if (!pic) return;
    const [latest] = await latestPictures([pic]);
    if (!sharingProblem(latest)) {
      if (await copyTextToClipboard(latest.url, '直链已复制')) {
        return;
      }
    }
    setSharingPic([latest]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    setBusySend(true);
    let targetConvId = selectedId;
    try {
      if (!targetConvId) {
        const created = await api<{ id: string }>('/ai/conversations', 'POST');
        targetConvId = created.id;
        setSelectedId(targetConvId);
      }
      await api(`/ai/conversations/${targetConvId}`, 'POST', {
        prompt: prompt.trim(),
        reference_id: reference?.id || null,
      });
      setPrompt('');
      setReference(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['ai-conversations'] }),
        client.invalidateQueries({ queryKey: ['ai-messages', targetConvId] }),
        client.invalidateQueries({ queryKey: ['ai-status'] }),
      ]);
    } catch (error) {
      if (targetConvId) {
        void client.invalidateQueries({
          queryKey: ['ai-messages', targetConvId],
        });
      }
      toast.error(errorMessage(error));
    } finally {
      setBusySend(false);
    }
  }

  async function handleSaveToAlbum() {
    if (!albumTargetPicId || savingAlbum) return;
    setSavingAlbum(true);
    try {
      await api(`/images/${albumTargetPicId}`, 'PATCH', {
        album_id: targetAlbumId === 'none' ? null : targetAlbumId,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
      ]);
      toast.success('已归入相册');
      setAlbumTargetPicId(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSavingAlbum(false);
    }
  }

  async function handleRenameConversation(e: FormEvent) {
    e.preventDefault();
    if (!renamingConv || busyConvOp) return;
    const trimmed = renameTitle.trim();
    if (!trimmed) {
      toast.error('会话标题不能为空');
      return;
    }
    setBusyConvOp(true);
    try {
      await api(`/ai/conversations/${renamingConv.id}`, 'PATCH', {
        title: trimmed,
      });
      await client.invalidateQueries({ queryKey: ['ai-conversations'] });
      toast.success('会话已重命名');
      setRenamingConv(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyConvOp(false);
    }
  }

  async function handleDeleteConversation() {
    if (!deletingConv || busyConvOp) return;
    setBusyConvOp(true);
    try {
      await api(`/ai/conversations/${deletingConv.id}`, 'DELETE');
      if (selectedId === deletingConv.id) {
        setSelectedId(null);
        setPrompt('');
        setReference(null);
      }
      await client.invalidateQueries({ queryKey: ['ai-conversations'] });
      toast.success('会话已移除');
      setDeletingConv(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyConvOp(false);
    }
  }

  const historyListContent = (
    <div className="flex flex-col h-full p-3 gap-2">
      <Button
        variant="outline"
        className="w-full justify-start gap-2"
        disabled={busySend || isBanned || !!referenceUpload}
        onClick={() => {
          setSelectedId(null);
          setPrompt('');
          setReference(null);
          setMobileHistoryOpen(false);
        }}
      >
        <SquarePen className="size-4" />
        开启新创作
      </Button>

      <div className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        历史会话
      </div>

      <ScrollArea className="flex-1 -mx-1 px-1">
        {conversations.data && conversations.data.items.length === 0 ? (
          <p className="px-2 py-6 text-xs text-muted-foreground text-center">
            暂无历史创作记录
          </p>
        ) : (
          <div className="space-y-0.5">
            {conversations.data?.items.map((conv) => {
              const active = selectedId === conv.id;
              return (
                <div
                  key={conv.id}
                  className={cn(
                    'group flex items-center gap-0.5 rounded-lg pe-1 transition-colors',
                    active ? 'bg-primary/10' : 'hover:bg-accent',
                  )}
                >
                  <button
                    type="button"
                    disabled={busySend || !!referenceUpload}
                    aria-current={active ? 'page' : undefined}
                    title={conv.title}
                    onClick={() => {
                      setSelectedId(conv.id);
                      setReference(null);
                      setPrompt('');
                      setMobileHistoryOpen(false);
                    }}
                    className={cn(
                      'cursor-pointer min-w-0 flex-1 text-start px-2.5 py-2 text-xs truncate block',
                      active
                        ? 'text-primary font-semibold'
                        : 'text-secondary-foreground',
                    )}
                  >
                    {conv.title}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        mode="icon"
                        variant="ghost"
                        aria-label={`会话操作 ${conv.title}`}
                        className={cn(
                          'size-6 shrink-0',
                          active
                            ? 'opacity-80 hover:opacity-100'
                            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                        )}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setRenamingConv(conv);
                          setRenameTitle(conv.title);
                        }}
                      >
                        <Pencil />
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeletingConv(conv)}
                      >
                        <Trash2 />
                        删除会话
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {(page > 1 || !!conversations.data?.has_more) && (
        <div className="flex items-center gap-1.5 pt-2 border-t border-border">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上页
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!conversations.data?.has_more}
            onClick={() => setPage((p) => p + 1)}
          >
            下页
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex grow h-[calc(100dvh-var(--header-height))] min-h-[520px] overflow-hidden bg-background">
      {/* Desktop Conversation Rail */}
      <aside
        aria-label="历史对话"
        className="hidden md:flex w-60 shrink-0 flex-col border-e border-border bg-muted/25"
      >
        {historyListContent}
      </aside>

      {/* Mobile History Sheet */}
      <Sheet open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
        <SheetContent side="left" className="w-[270px] p-0 gap-0 flex flex-col">
          <SheetHeader className="px-4 py-3 border-b border-border">
            <SheetTitle className="text-sm">历史创作会话</SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0">{historyListContent}</div>
        </SheetContent>
      </Sheet>

      {/* Main Studio Area */}
      <section className="flex flex-1 flex-col min-w-0 min-h-0">
        {/* Studio Subheader */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-12 border-b border-border/70 shrink-0">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              mode="icon"
              variant="ghost"
              aria-label="历史对话"
              className="md:hidden size-8"
              onClick={() => setMobileHistoryOpen(true)}
            >
              <History className="size-4" />
            </Button>
            <Sparkles className="size-4 text-primary hidden sm:inline" />
            <h1 className="text-sm font-semibold text-mono">AI 图片创作台</h1>
          </div>

          {status.data && (
            <Badge variant="secondary" appearance="light" size="sm">
              {status.data.unlimited
                ? '无限生图额度'
                : `今日额度 ${status.data.used} / ${status.data.daily_limit}`}
            </Badge>
          )}
        </div>

        {/* Status Alerts */}
        {status.isError && (
          <div className="px-4 sm:px-6 pt-3">
            <Alert variant="destructive" appearance="light">
              <div className="flex items-center justify-between gap-2 w-full">
                <AlertTitle>{errorMessage(status.error)}</AlertTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void status.refetch()}
                >
                  重试
                </Button>
              </div>
            </Alert>
          </div>
        )}

        {status.data && !status.data.enabled && (
          <div className="px-4 sm:px-6 pt-3" role="status">
            <Alert variant="info" appearance="light">
              <AlertTitle>
                尚未启用 AI 生图服务。
                {me.data?.user.is_admin ? (
                  <Link
                    to="/app/admin/settings#settings-ai"
                    className="ms-2 font-semibold underline"
                  >
                    前往配置 API →
                  </Link>
                ) : (
                  '请联系管理员开启。'
                )}
              </AlertTitle>
            </Alert>
          </div>
        )}

        {/* Messages Stream */}
        <div
          aria-label="对话消息"
          aria-live="polite"
          className="flex-1 overflow-y-auto px-4 sm:px-6 py-6"
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {isEmpty && (
              <div className="py-16 sm:py-24 text-center space-y-3">
                <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Sparkles className="size-6" />
                </span>
                <h2 className="text-2xl font-semibold tracking-tight text-mono">
                  今天想创作什么画面？
                </h2>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  输入画面描述直接生成原图，或上传参考图进行风格重绘与细节调整。
                </p>
              </div>
            )}

            {selectedId && messages.isPending && (
              <div className="py-12 text-center text-sm text-muted-foreground" role="status">
                正在读取会话内容…
              </div>
            )}

            {messages.data?.map((m) => (
              <article key={m.id} className="space-y-4">
                {/* User Bubble */}
                <div className="flex flex-col items-end gap-2" aria-label="你的消息">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-2xs">
                    {m.prompt}
                  </div>
                  {m.reference_id && (
                    <MessageImageCard
                      id={m.reference_id}
                      status={m.reference_status}
                      onPreview={(id) => void handleOpenPreview(id)}
                    />
                  )}
                </div>

                {/* Assistant Reply */}
                <div className="flex flex-col items-start gap-2.5" aria-label="AI 回复">
                  {m.text && (
                    <div className="max-w-[90%] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                      {m.text}
                    </div>
                  )}

                  {m.image_id && (
                    <MessageImageCard
                      id={m.image_id}
                      status={m.image_status}
                      reason={m.image_reason}
                      isGenerated
                      onPreview={(id) => void handleOpenPreview(id)}
                      onShare={(id) => void handleOpenShare(id)}
                      onMoveAlbum={(id) => {
                        setTargetAlbumId('none');
                        setAlbumTargetPicId(id);
                      }}
                    />
                  )}

                  {['queued', 'running'].includes(m.status) && (
                    <div
                      role="status"
                      className="inline-flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3.5 py-2 text-xs text-muted-foreground"
                    >
                      <LoaderCircle className="size-4 animate-spin text-primary" />
                      {m.status === 'queued' ? '正在排队等待生成…' : '正在绘制图像…'}
                    </div>
                  )}

                  {m.status === 'failed' && (
                    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3.5 space-y-2.5 max-w-md">
                      <p role="alert" className="text-xs text-destructive">
                        {m.error || '生成未成功'}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busySend}
                        onClick={() => {
                          setPrompt(m.prompt);
                          setReference(
                            m.reference_id
                              ? {
                                  id: m.reference_id,
                                  original_name: '上次参考图',
                                  is_public: false,
                                }
                              : null,
                          );
                        }}
                      >
                        <RotateCcw />
                        填入提示词重试
                      </Button>
                    </div>
                  )}
                </div>
              </article>
            ))}

            <div ref={messageEndRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 sm:px-6 pb-4 pt-2 border-t border-border/50 bg-background shrink-0">
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="mx-auto max-w-3xl rounded-2xl border border-input bg-card p-3 shadow-xs focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 transition-all space-y-2.5"
          >
            <input
              ref={referenceInputRef}
              hidden
              aria-label="参考图片"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={busySend || isBanned || isGenerating}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (!file.size || file.size > 10 * 1024 * 1024) {
                  toast.error('参考图不能为空且单张不能超过 10 MiB');
                  return;
                }
                const form = new FormData();
                form.append('file', file);
                setReferenceUpload({ name: file.name, progress: 0 });
                void uploadImage(
                  `/images?private=true${ownerId ? `&expected_user_id=${ownerId}` : ''}`,
                  form,
                  (progress) =>
                    setReferenceUpload({ name: file.name, progress }),
                )
                  .then(async (uploaded) => {
                    setReference(uploaded);
                    if (uploaded.duplicate && uploaded.is_public) {
                      toast.info('已复用图库中已有的相同内容公开图片');
                    }
                    await Promise.all([
                      client.invalidateQueries({ queryKey: ['images'] }),
                      client.invalidateQueries({ queryKey: ['me'] }),
                    ]);
                  })
                  .catch((err) => {
                    toast.error(errorMessage(err));
                  })
                  .finally(() => {
                    setReferenceUpload(null);
                  });
              }}
            />

            {referenceUpload && (
              <div
                role="status"
                className="rounded-xl bg-muted/60 p-2.5 space-y-1.5 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium">
                    {referenceUpload.name}
                  </span>
                  <span className="text-muted-foreground">
                    {referenceUpload.progress === 100
                      ? '正在保存…'
                      : `${referenceUpload.progress}%`}
                  </span>
                </div>
                <Progress
                  value={referenceUpload.progress}
                  aria-label="参考图片上传进度"
                />
              </div>
            )}

            {reference && (
              <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 p-2">
                <img
                  src={`/api/v1/images/${reference.id}/thumbnail`}
                  alt={`参考图 ${reference.original_name}`}
                  className="size-11 rounded-lg object-cover border border-border shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-mono truncate">
                    {reference.original_name}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge size="xs" variant="secondary">
                      参考图
                    </Badge>
                    {reference.duplicate && reference.is_public && (
                      <Badge size="xs" variant="info" appearance="light">
                        <Globe className="size-2.5" />
                        图库原图为公开状态
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  mode="icon"
                  variant="ghost"
                  aria-label="移除参考图片"
                  disabled={busySend}
                  onClick={() => setReference(null)}
                >
                  <X />
                </Button>
              </div>
            )}

            <Textarea
              aria-label="描述图片或修改要求"
              disabled={busySend}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              maxLength={4000}
              rows={2}
              placeholder="描述你想生成的画面，或告诉 AI 如何修改上一张图片…（Enter 发送，Shift + Enter 换行）"
              className="border-0 shadow-none focus-visible:ring-0 px-1 py-0.5 resize-none min-h-[52px] max-h-[160px]"
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  if (canSend) event.currentTarget.form?.requestSubmit();
                }
              }}
            />

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busySend || isBanned || isGenerating || !!referenceUpload}
                onClick={() => referenceInputRef.current?.click()}
                aria-label="添加参考图片"
              >
                <ImagePlus />
                添加参考图
              </Button>

              <Button
                type="submit"
                size="sm"
                shape="circle"
                aria-label={isGenerating ? '正在生成…' : '生成图片'}
                title="生成图片"
                disabled={!canSend}
                className="size-8.5 p-0"
              >
                {isGenerating || busySend ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
          </form>
        </div>
      </section>

      {/* Lightbox & Share & Move to Album Dialogs */}
      <LightboxDialog
        items={previewPic ? [previewPic] : []}
        activeId={previewPic?.id || null}
        onSelectId={(id) => {
          if (!id) setPreviewPic(null);
        }}
        onOpenLinks={(pic) => setSharingPic([pic])}
      />

      <LinksDialog pictures={sharingPic} onClose={() => setSharingPic([])} />

      <Dialog
        open={!!albumTargetPicId}
        onOpenChange={(open) => {
          if (!open && !savingAlbum) setAlbumTargetPicId(null);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>归入相册</DialogTitle>
            <DialogDescription>将生成的图片整理到指定相册</DialogDescription>
          </DialogHeader>
          <Select value={targetAlbumId} onValueChange={setTargetAlbumId}>
            <SelectTrigger aria-label="目标相册">
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
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingAlbum}
              onClick={() => setAlbumTargetPicId(null)}
            >
              取消
            </Button>
            <Button
              disabled={savingAlbum}
              onClick={() => void handleSaveToAlbum()}
            >
              {savingAlbum ? '保存中…' : '确认归档'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renamingConv}
        onOpenChange={(open) => {
          if (!open && !busyConvOp) setRenamingConv(null);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>修改左侧历史列表中的会话标题</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void handleRenameConversation(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="ai-conv-title">会话标题</Label>
              <Input
                id="ai-conv-title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                maxLength={100}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busyConvOp}
                onClick={() => setRenamingConv(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busyConvOp}>
                {busyConvOp ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deletingConv}
        onOpenChange={(open) => {
          if (!open && !busyConvOp) setDeletingConv(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除会话「{deletingConv?.title}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              删除后该会话不再显示在列表中，已保存到图库的生成图片不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyConvOp}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyConvOp}
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConversation();
              }}
            >
              {busyConvOp ? '正在删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
