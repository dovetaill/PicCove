import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  Maximize2,
  QrCode,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import {
  api,
  errorMessage,
  imageLink,
  LINK_FORMATS,
  REVIEW_LABELS,
  reviewBadgeVariant,
  sharingProblem,
  size,
  useMe,
  type Album,
  type ImageShareItem,
  type Picture,
} from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { copyTextToClipboard } from './links-dialog';

export function ImageDetailSheet({
  picture,
  albums,
  onClose,
  onUpdated,
  onOpenLightbox,
  onOpenQr,
  onDelete,
}: {
  picture: Picture | null;
  albums?: Album[];
  onClose: () => void;
  onUpdated?: (updated: Picture) => void;
  onOpenLightbox?: (picture: Picture) => void;
  onOpenQr?: (picture: Picture) => void;
  onDelete?: (picture: Picture) => void;
}) {
  const me = useMe();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [albumId, setAlbumId] = useState('none');
  const [saving, setSaving] = useState(false);
  const [togglingPublic, setTogglingPublic] = useState(false);
  const [shareTtl, setShareTtl] = useState('24');
  const [creatingShare, setCreatingShare] = useState(false);
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null);
  const [sharesExpanded, setSharesExpanded] = useState(false);

  useEffect(() => {
    if (picture) {
      setName(picture.original_name);
      setAlbumId(picture.album_id || 'none');
      setSharesExpanded(false);
    }
  }, [picture]);

  const isOwner = !!picture && picture.user_id === me.data?.user.id;
  const problem = picture ? sharingProblem(picture) : null;
  const canTempShare =
    isOwner &&
    !!picture &&
    !picture.deleted_at &&
    !['blocked', 'review'].includes(picture.moderation_status) &&
    !(
      picture.moderation_hold &&
      ['pending', 'running', 'failed'].includes(picture.moderation_status)
    );

  const shares = useQuery({
    queryKey: ['image-shares', picture?.id],
    queryFn: () => api<ImageShareItem[]>(`/images/${picture!.id}/shares`),
    enabled: canTempShare && sharesExpanded,
  });

  async function handleCreateTempShare() {
    if (!picture || creatingShare) return;
    setCreatingShare(true);
    try {
      const created = await api<ImageShareItem>(
        `/images/${picture.id}/shares`,
        'POST',
        { ttl_hours: Number(shareTtl) },
      );
      setSharesExpanded(true);
      await client.invalidateQueries({
        queryKey: ['image-shares', picture.id],
      });
      await copyTextToClipboard(created.url, '临时分享链接已生成并复制');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreatingShare(false);
    }
  }

  async function handleRevokeShare(shareId: string) {
    if (!picture || revokingShareId) return;
    setRevokingShareId(shareId);
    try {
      await api(`/images/${picture.id}/shares/${shareId}`, 'DELETE');
      await client.invalidateQueries({
        queryKey: ['image-shares', picture.id],
      });
      toast.success('临时链接已撤销');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRevokingShareId(null);
    }
  }

  async function handleSaveMeta(e: FormEvent) {
    e.preventDefault();
    if (!picture || !isOwner || saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('图片名称不能为空');
      return;
    }
    setSaving(true);
    try {
      const nextAlbum = albumId === 'none' ? null : albumId;
      const payload: { original_name?: string; album_id?: string | null } = {};
      if (trimmed !== picture.original_name) {
        payload.original_name = trimmed;
      }
      if (albums !== undefined && nextAlbum !== picture.album_id) {
        payload.album_id = nextAlbum;
      }
      if (Object.keys(payload).length === 0) {
        toast.info('未做修改');
        return;
      }
      await api(`/images/${picture.id}`, 'PATCH', payload);
      const updated = {
        ...picture,
        ...(payload.original_name !== undefined
          ? { original_name: payload.original_name }
          : {}),
        ...(payload.album_id !== undefined
          ? { album_id: payload.album_id }
          : {}),
      };
      onUpdated?.(updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
      ]);
      toast.success('图片信息已保存');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleVisibility(nextPublic: boolean) {
    if (!picture || !isOwner || togglingPublic) return;
    setTogglingPublic(true);
    try {
      await api(`/images/${picture.id}/visibility`, 'PATCH', {
        is_public: nextPublic,
      });
      const updated = { ...picture, is_public: nextPublic };
      onUpdated?.(updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success(nextPublic ? '已设为公开访问' : '已设为仅本人可见');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTogglingPublic(false);
    }
  }

  return (
    <Sheet
      open={!!picture}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md p-0 gap-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle className="truncate pe-6">
            {picture?.original_name || '图片详情'}
          </SheetTitle>
          <SheetDescription>查看属性、调整可见性与复制外链</SheetDescription>
        </SheetHeader>

        {picture && (
          <ScrollArea className="flex-1 px-6 py-5">
            <div className="space-y-6">
              {/* Thumbnail Preview */}
              <div className="relative group rounded-xl border border-border bg-muted/50 overflow-hidden aspect-video flex items-center justify-center">
                {picture.deleted_at ? (
                  <span className="text-xs text-muted-foreground">待清理</span>
                ) : ['blocked', 'review'].includes(picture.moderation_status) &&
                  !me.data?.user.is_admin ? (
                  <span className="text-xs text-muted-foreground px-4 text-center">
                    {picture.moderation_reason || '受审核限制'}
                  </span>
                ) : (
                  <img
                    src={picture.thumbnail_url || picture.url}
                    alt={picture.original_name}
                    className="max-h-full max-w-full object-contain"
                  />
                )}
                {onOpenLightbox && !picture.deleted_at && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenLightbox(picture)}
                    className="absolute bottom-2.5 end-2.5 opacity-90 shadow-sm"
                  >
                    <Maximize2 />
                    大图预览
                  </Button>
                )}
              </div>

              {/* Visibility Switch (Owner) */}
              {isOwner && !picture.deleted_at && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3.5">
                  <div className="flex items-center gap-2.5">
                    {picture.is_public ? (
                      <Globe className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <Lock className="size-4 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-mono">公开外链访问</p>
                      <p className="text-xs text-muted-foreground">
                        {picture.is_public
                          ? '持有链接的访客可查看此图'
                          : '私有状态，仅你本人与管理员可见'}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={picture.is_public}
                    disabled={
                      togglingPublic ||
                      ['blocked', 'review'].includes(picture.moderation_status)
                    }
                    onCheckedChange={(v) => void handleToggleVisibility(v)}
                    aria-label="公开外链访问"
                  />
                </div>
              )}

              {/* Metadata Grid */}
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3.5 text-xs">
                <div>
                  <span className="text-muted-foreground block">分辨率</span>
                  <span className="font-medium text-mono tabular-nums">
                    {picture.width} × {picture.height}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">文件体积</span>
                  <span className="font-medium text-mono tabular-nums">
                    {size(picture.size_bytes)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">格式</span>
                  <span className="font-medium text-mono">
                    {picture.content_type || 'image/*'}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">上传时间</span>
                  <span className="font-medium text-mono tabular-nums">
                    {formatDateTime(picture.created_at)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">审核状态</span>
                  <Badge
                    size="xs"
                    appearance="light"
                    variant={reviewBadgeVariant(picture.moderation_status)}
                    className="mt-0.5"
                  >
                    {REVIEW_LABELS[picture.moderation_status] ||
                      picture.moderation_status}
                  </Badge>
                </div>
                {(picture.username || me.data?.user.is_admin) && (
                  <div>
                    <span className="text-muted-foreground block">所属用户</span>
                    <span className="font-medium text-mono truncate block">
                      {picture.username || me.data?.user.username || picture.user_id}
                    </span>
                  </div>
                )}
              </div>

              {/* Edit Name & Album (Owner) */}
              {isOwner && !picture.deleted_at && (
                <form onSubmit={(e) => void handleSaveMeta(e)} className="space-y-3.5 border-t border-border pt-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="detail-image-name">展示名称</Label>
                    <Input
                      id="detail-image-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={200}
                      required
                    />
                  </div>
                  {albums && (
                    <div className="space-y-1.5">
                      <Label>所属相册</Label>
                      <Select value={albumId} onValueChange={setAlbumId}>
                        <SelectTrigger aria-label="所属相册">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不放入相册</SelectItem>
                          {albums.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? '保存中…' : '保存更改'}
                  </Button>
                </form>
              )}

              {/* Quick Link Copy Section */}
              <div className="space-y-2.5 border-t border-border pt-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    快速复制外链
                  </span>
                  {onOpenQr && !problem && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onOpenQr(picture)}
                    >
                      <QrCode />
                      二维码
                    </Button>
                  )}
                </div>

                {problem ? (
                  <p className="text-xs text-muted-foreground rounded-lg bg-muted/60 p-3">
                    {problem}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {LINK_FORMATS.map(([fmt, label]) => (
                      <Button
                        key={fmt}
                        size="sm"
                        variant="outline"
                        className="justify-start text-xs truncate"
                        onClick={() =>
                          void copyTextToClipboard(
                            imageLink(picture, fmt),
                            `${label} 已复制`,
                          )
                        }
                      >
                        <Copy className="size-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              {/* Temporary Expiring Share Section (Stage 4D) */}
              {canTempShare && (
                <div className="space-y-3 border-t border-border pt-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Clock className="size-3.5" />
                      临时分享（到期自动失效）
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setSharesExpanded((v) => !v)}
                    >
                      {sharesExpanded ? '收起记录' : '查看已有记录'}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    无需将私有图片永久公开，可生成随时可撤销的限时访问外链。
                  </p>
                  <div className="flex items-center gap-2">
                    <Select value={shareTtl} onValueChange={setShareTtl}>
                      <SelectTrigger
                        aria-label="临时链接有效期"
                        size="sm"
                        className="w-[120px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 小时</SelectItem>
                        <SelectItem value="24">24 小时</SelectItem>
                        <SelectItem value="168">7 天</SelectItem>
                        <SelectItem value="720">30 天</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={creatingShare}
                      onClick={() => void handleCreateTempShare()}
                    >
                      <Copy />
                      {creatingShare ? '生成中…' : '生成并复制临时链'}
                    </Button>
                  </div>

                  {sharesExpanded && (
                    <div className="space-y-2 pt-1">
                      {shares.isPending ? (
                        <p className="text-xs text-muted-foreground">
                          正在加载临时链接记录…
                        </p>
                      ) : !shares.data?.length ? (
                        <p className="text-xs text-muted-foreground">
                          当前没有生效中的临时链接
                        </p>
                      ) : (
                        shares.data.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-mono truncate">{item.url}</p>
                              <p className="text-[11px] text-muted-foreground tabular-nums">
                                有效至 {formatDateTime(item.expires_at)}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                onClick={() =>
                                  void copyTextToClipboard(
                                    item.url,
                                    '临时链接已复制',
                                  )
                                }
                              >
                                复制
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive hover:text-destructive"
                                disabled={revokingShareId === item.id}
                                onClick={() => void handleRevokeShare(item.id)}
                              >
                                撤销
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Footer Actions */}
              <div className="flex items-center justify-between gap-2 border-t border-border pt-5">
                {!picture.deleted_at && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={picture.url} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      新窗口打开原图
                    </a>
                  </Button>
                )}
                {onDelete && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="ms-auto"
                    onClick={() => {
                      onClose();
                      onDelete(picture);
                    }}
                  >
                    <Trash2 />
                    永久删除
                  </Button>
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
