import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderHeart, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
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
import { Card, CardContent } from '@/components/ui/card';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, type Album } from '@/lib/api';

export function AlbumDialog({
  open,
  album,
  onClose,
  onSaved,
}: {
  open: boolean;
  album?: Album;
  onClose: () => void;
  onSaved: (album: Album) => void;
}) {
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const saved = await api<Album>(
        album ? `/albums/${album.id}` : '/albums',
        album ? 'PATCH' : 'POST',
        {
          name: values.get('name'),
          description: values.get('description'),
        },
      );
      await client.invalidateQueries({ queryKey: ['albums'] });
      toast.success(album ? '相册已更新' : '相册已创建');
      onClose();
      onSaved(saved);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-[440px] max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{album ? '编辑相册' : '创建相册'}</DialogTitle>
          <DialogDescription>
            {album ? '更新相册名称或简介' : '创建相册以归档整理你的图片'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="album-name-input">名称</Label>
            <Input
              id="album-name-input"
              name="name"
              required
              maxLength={100}
              defaultValue={album?.name || ''}
              placeholder="例如：旅行摄影、博客配图、产品设计"
              disabled={busy}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="album-desc-input">描述（选填）</Label>
            <Textarea
              id="album-desc-input"
              name="description"
              maxLength={500}
              rows={3}
              defaultValue={album?.description || ''}
              placeholder="简要记录相册用途…"
              disabled={busy}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? '保存中…' : album ? '保存' : '创建相册'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AlbumsPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Album | null>(null);
  const [deleting, setDeleting] = useState<Album | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
  });

  async function confirmDelete() {
    if (!deleting || busyDelete) return;
    setBusyDelete(true);
    try {
      await api(`/albums/${deleting.id}`, 'DELETE');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['albums'] }),
        client.invalidateQueries({ queryKey: ['images'] }),
      ]);
      toast.success('相册已删除（相册内图片仍保留在图库中）');
      setDeleting(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyDelete(false);
    }
  }

  return (
    <div className="container space-y-6">
      <Toolbar>
        <ToolbarHeading
          title="我的相册"
          description="按主题、项目或文章分类管理图片素材"
          badge={
            albums.data ? (
              <Badge variant="secondary" appearance="light" size="sm">
                {albums.data.length} 个相册
              </Badge>
            ) : undefined
          }
        />
        <ToolbarActions>
          <Button onClick={() => setCreating(true)}>
            <FolderPlus />
            创建相册
          </Button>
        </ToolbarActions>
      </Toolbar>

      {albums.isPending ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Card key={idx} className="overflow-hidden">
              <Skeleton className="aspect-[16/10] w-full rounded-none" />
              <CardContent className="p-4 space-y-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : albums.isError ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3" role="alert">
            <p className="text-sm text-destructive">
              {errorMessage(albums.error)}
            </p>
            <Button variant="outline" onClick={() => void albums.refetch()}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : albums.data.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center text-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <FolderHeart className="size-6" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-mono">还没有创建相册</h2>
              <p className="text-sm text-muted-foreground">
                创建第一个相册，可直接上传新图或从图库归入已有图片
              </p>
            </div>
            <Button className="mt-2" onClick={() => setCreating(true)}>
              <FolderPlus />
              创建相册
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5">
          {albums.data.map((album) => (
            <Card
              key={album.id}
              className="group overflow-hidden hover:border-primary/40 transition-colors"
            >
              <Link
                to={`/app?album=${album.id}`}
                aria-label={`打开相册 ${album.name}`}
                className="relative aspect-[16/10] bg-muted/70 flex items-center justify-center overflow-hidden border-b border-border"
              >
                {album.cover_id ? (
                  <img
                    src={`/api/v1/images/${album.cover_id}/thumbnail`}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                ) : (
                  <FolderHeart className="size-10 text-muted-foreground/45" />
                )}
                {album.image_count !== undefined && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    className="absolute bottom-2.5 end-2.5 bg-background/85 backdrop-blur-xs shadow-2xs"
                  >
                    {album.image_count} 张
                  </Badge>
                )}
              </Link>

              <CardContent className="p-4 flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-base font-semibold text-mono truncate">
                    <Link
                      to={`/app?album=${album.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {album.name}
                    </Link>
                  </h2>
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-[1rem]">
                    {album.description || '点击查看与管理相册图片'}
                  </p>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      mode="icon"
                      variant="ghost"
                      aria-label={`相册操作 ${album.name}`}
                      className="size-8 shrink-0"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      aria-label={`编辑相册 ${album.name}`}
                      onSelect={() => setEditing(album)}
                    >
                      <Pencil />
                      编辑相册
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      aria-label={`删除相册 ${album.name}`}
                      onSelect={() => setDeleting(album)}
                    >
                      <Trash2 />
                      删除相册
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlbumDialog
        open={creating || !!editing}
        album={editing || undefined}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved) => {
          if (creating) navigate(`/app?album=${saved.id}`);
        }}
      />

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busyDelete) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除相册「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除相册不会删除其中的图片，所有图片与已分享外链均保持有效。
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
              {busyDelete ? '正在删除…' : '确认删除相册'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
