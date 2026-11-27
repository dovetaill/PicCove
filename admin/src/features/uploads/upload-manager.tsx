import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router-dom';
import { toast } from 'sonner';
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
import { api, ApiError, type Page, type Picture } from '@/lib/api';
import { uploadImage, UploadError } from '@/lib/upload';
import { deleteUploads, loadUploads, saveUpload } from './upload-store';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type UploadItem = {
  id: string;
  file?: File;
  name: string;
  queuedAt: number;
  hash?: string;
  uncertain?: boolean;
  targetAlbum: string;
  targetPrivate?: boolean;
  status: string;
  progress: number;
  error?: string;
  image?: Picture;
};

type UploadContextValue = {
  queue: UploadItem[];
  busy: boolean;
  retryAfter: number;
  upload: (
    files: FileList | File[],
    targetAlbum: string,
    targetPrivate?: boolean,
  ) => void;
  retryFailed: () => void;
  clearQueue: () => void;
  removeImage: (id: string) => void;
  removePending: (id: string) => void;
  stopWaiting: () => void;
  ready: boolean;
  storageError: string;
  prepareLeave: () => Promise<boolean>;
  resetLeave: () => void;
  updateImages: (images: Picture[]) => void;
};

const UploadContext = createContext<UploadContextValue | null>(null);

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function isUnfinishedItem(item: UploadItem) {
  return !item.image && !(item.status === '失败' && !item.file);
}

export function UploadProvider({
  children,
  owner,
}: {
  children: ReactNode;
  owner: string;
}) {
  const client = useQueryClient();
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const queueRef = useRef<UploadItem[]>([]);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const writes = useRef(Promise.resolve());
  const persistenceFailed = useRef(false);
  const leaveAllowed = useRef(false);
  const [leavePrompt, setLeavePrompt] = useState<{
    message: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const askConfirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      setLeavePrompt({ message, resolve });
    });

  const blocker = useBlocker(
    ({ nextLocation }) =>
      !leaveAllowed.current &&
      (!ready || queueRef.current.some(isUnfinishedItem)) &&
      nextLocation.pathname !== '/app' &&
      !nextLocation.pathname.startsWith('/app/'),
  );

  useEffect(() => {
    let cancelled = false;
    void loadUploads(owner)
      .then((items) => {
        if (cancelled) return;
        const restored = items
          .sort((a, b) => a.queuedAt - b.queuedAt)
          .map((item) =>
            item.image
              ? item
              : {
                  ...item,
                  status: item.status === '失败' && !item.file ? '失败' : '等待重试',
                  progress: 0,
                  uncertain:
                    item.uncertain ||
                    ['上传中', '服务器处理中', '核对结果'].includes(item.status),
                },
          );
        queueRef.current = restored;
        setQueue(restored);
      })
      .catch(() => {
        persistenceFailed.current = true;
        if (!cancelled)
          setStorageError('浏览器本地队列不可用，本页仍可正常上传。');
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [owner]);

  async function prepareLeave() {
    if (!ready) {
      toast.info('正在读取上传状态，请稍候');
      return false;
    }
    await writes.current;
    const hasUnfinished = queueRef.current.some(isUnfinishedItem);
    const failedBeforeLeaving = persistenceFailed.current;
    if (hasUnfinished) {
      const confirmed = await askConfirm(
        failedBeforeLeaving
          ? '本地队列保存不可用，现在离开可能丢失待上传图片。确定离开工作台吗？'
          : '当前仍有未完成的上传任务，离开工作台后将暂停（重新进入后可继续）。确定离开吗？',
      );
      if (!confirmed) return false;
    }
    controller.current?.abort();
    await Promise.resolve();
    await writes.current;
    if (
      !failedBeforeLeaving &&
      persistenceFailed.current &&
      queueRef.current.some((item) => !item.image && item.file)
    ) {
      const forceLeave = await askConfirm(
        '本地队列保存失败，离开后未完成的图片将无法自动恢复。仍要离开吗？',
      );
      if (!forceLeave) return false;
    }
    leaveAllowed.current = true;
    return true;
  }

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void prepareLeave().then((allowed) => {
      if (allowed) blocker.proceed();
      else blocker.reset();
    });
  }, [blocker]);

  useEffect(() => {
    const timer = retryAfter
      ? window.setTimeout(
          () => setRetryAfter(0),
          Math.max(0, retryAfter - Date.now()),
        )
      : undefined;
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [retryAfter]);

  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (!queueRef.current.some(isUnfinishedItem)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  function update(
    updater: (items: UploadItem[]) => UploadItem[],
    persist = true,
  ) {
    if (!mounted.current) return Promise.resolve();
    const before = queueRef.current;
    const next = updater(queueRef.current);
    queueRef.current = next;
    setQueue(next);
    if (persist && !persistenceFailed.current) {
      const removed = before
        .filter((item) => !next.some((row) => row.id === item.id))
        .map((item) => item.id);
      const changed = next.filter(
        (item) =>
          !before.includes(item) && !(item.status === '失败' && !item.file),
      );
      writes.current = writes.current
        .then(async () => {
          if (persistenceFailed.current) return;
          if (removed.length) await deleteUploads(owner, removed);
          for (const item of changed)
            await saveUpload(
              owner,
              item,
              !before.some((row) => row.id === item.id),
            );
        })
        .catch(() => {
          persistenceFailed.current = true;
          if (mounted.current)
            setStorageError('本地队列空间不足，本页仍可继续上传。');
        });
    }
    return writes.current;
  }

  async function process(signal: AbortSignal) {
    const errors: string[] = [];
    let paused = false;
    while (true) {
      const item = queueRef.current.find((row) => row.status === '等待');
      if (!mounted.current || signal.aborted || !item) break;
      const itemId = item.id;
      await update((items) =>
        items.map((row) =>
          row.id === itemId
            ? {
                ...row,
                status: item.uncertain ? '核对结果' : '上传中',
                progress: 0,
                error: undefined,
              }
            : row,
        ),
      );
      try {
        if (!item.file?.size || item.file.size > MAX_FILE_BYTES)
          throw new Error('图片不能为空，且单张不能超过 10 MiB');
        let hash = item.hash;
        if (!hash && globalThis.crypto?.subtle) {
          hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', await item.file.arrayBuffer()),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('');
        }
        let existing: Picture | undefined;
        if (item.uncertain && hash) {
          const lookup = new AbortController();
          const timeout = setTimeout(() => lookup.abort(), 15000);
          const abort = () => lookup.abort();
          signal.addEventListener('abort', abort, { once: true });
          try {
            existing = (
              await api<Page<Picture>>(
                `/images?content_hash=${hash}&expected_user_id=${owner}`,
                'GET',
                undefined,
                lookup.signal,
              )
            ).items[0];
          } catch (err) {
            if (err instanceof ApiError) {
              throw new UploadError(err.message, err.status);
            }
            throw new Error('暂时无法核对上次上传状态，请稍后重试（未重复上传）');
          } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
          }
        }
        if (signal.aborted || !mounted.current) break;
        await update((items) =>
          items.map((row) =>
            row.id === itemId
              ? { ...row, hash, uncertain: true, status: '上传中' }
              : row,
          ),
        );
        if (signal.aborted || !mounted.current) break;
        const body = new FormData();
        body.append('file', item.file);
        const query = [
          `expected_user_id=${owner}`,
          item.targetAlbum !== 'all' ? `album_id=${item.targetAlbum}` : '',
          item.targetPrivate ? 'private=true' : '',
        ]
          .filter(Boolean)
          .join('&');
        const result = existing
          ? { ...existing, duplicate: true }
          : await uploadImage(
              `/images?${query}`,
              body,
              (progress) =>
                update(
                  (items) =>
                    items.map((row) =>
                      row.id === itemId
                        ? {
                            ...row,
                            progress,
                            status:
                              progress === 100 ? '服务器处理中' : '上传中',
                          }
                        : row,
                    ),
                  false,
                ),
              signal,
            );
        await update((items) =>
          items.map((row) =>
            row.id === itemId
              ? {
                  ...row,
                  status: result.duplicate ? '已存在' : '完成',
                  image: result,
                  file: undefined,
                  uncertain: false,
                }
              : row,
          ),
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : '操作失败';
        update((items) =>
          items.map((row) =>
            row.id === itemId
              ? {
                  ...row,
                  status: signal.aborted ? '等待重试' : '失败',
                  error: text,
                  uncertain:
                    error instanceof UploadError &&
                    error.status >= 400 &&
                    error.status < 500
                      ? false
                      : row.uncertain,
                }
              : row,
          ),
        );
        if (signal.aborted) break;
        errors.push(`${item.name}：${text}`);
        if (
          error instanceof UploadError &&
          [401, 409, 429, 503].includes(error.status)
        ) {
          paused = true;
          update((items) =>
            items.map((row) =>
              row.status === '等待' ? { ...row, status: '等待重试' } : row,
            ),
          );
          if (error.status === 429) setRetryAfter(Date.now() + 60_000);
          break;
        }
      }
    }
    if (mounted.current) {
      if (signal.aborted)
        await update((items) =>
          items.map((item) =>
            !item.image &&
            ['等待', '上传中', '服务器处理中', '核对结果'].includes(item.status)
              ? { ...item, status: '等待重试' }
              : item,
          ),
        );
      setBusy(false);
      busyRef.current = false;
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      if (!mounted.current || busyRef.current) return;
      if (paused || queueRef.current.some((item) => item.status === '等待重试'))
        toast.error('上传已暂停，可在右上角上传列表中点击重试');
      else if (errors.length)
        toast.error('部分图片上传未成功，请打开上传列表查看原因');
      else toast.success('图片上传完成');
    }
  }

  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function start() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    controller.current = new AbortController();
    void process(controller.current.signal);
  }

  async function upload(
    files: FileList | File[],
    targetAlbum: string,
    targetPrivate = false,
  ) {
    if (!files.length) return;
    if (!ready) {
      toast.info('正在读取上传状态，请稍候');
      return;
    }
    if (retryAfter > Date.now()) {
      toast.info('上传过于频繁，请稍后再试');
      return;
    }
    const baseTime = Math.max(
      Date.now(),
      (queueRef.current[queueRef.current.length - 1]?.queuedAt || 0) + 1,
    );
    let rejectedCount = 0;
    const items: UploadItem[] = Array.from(files).map((file, index) => {
      const invalidSize = !file.size || file.size > MAX_FILE_BYTES;
      if (invalidSize) rejectedCount++;
      return {
        id: makeId(),
        file: invalidSize ? undefined : file,
        name: file.webkitRelativePath || file.name,
        queuedAt: baseTime + index,
        targetAlbum,
        targetPrivate,
        status: invalidSize ? '失败' : '等待',
        progress: 0,
        error: invalidSize
          ? !file.size
            ? '文件为空'
            : '单张图片超过 10 MiB 限制'
          : undefined,
      };
    });
    const validItems = items.filter((item) => item.file);
    await update((current) => [...current, ...items], validItems.length > 0);
    setRetryAfter(0);
    if (rejectedCount > 0 && validItems.length === 0) {
      toast.error(
        rejectedCount === 1
          ? `${items[0].name}：${items[0].error}`
          : `${rejectedCount} 个文件大小不符合要求（单张最大 10 MiB）`,
      );
      return;
    }
    if (rejectedCount > 0) {
      toast.warning(`已跳过 ${rejectedCount} 个超出 10 MiB 或空文件`);
    }
    if (mounted.current && !leaveAllowed.current && validItems.length > 0) {
      start();
    }
  }

  function retryFailed() {
    if (busyRef.current) return;
    if (retryAfter > Date.now()) {
      toast.info('上传过于频繁，请稍后再试');
      return;
    }
    update((items) =>
      items.map((item) =>
        ['失败', '等待重试'].includes(item.status) && item.file
          ? { ...item, status: '等待', error: undefined }
          : item,
      ),
    );
    if (queueRef.current.some((item) => item.status === '等待')) start();
  }

  async function clearQueue() {
    if (!busyRef.current) {
      const ids = queueRef.current.map((item) => item.id);
      writes.current = writes.current
        .then(() => deleteUploads(owner, ids))
        .then(() => {})
        .catch(() => {
          persistenceFailed.current = true;
          if (mounted.current)
            setStorageError('本地队列记录清理失败，刷新后可能重新出现。');
        });
      await writes.current;
      await update((items) => items.filter((item) => !ids.includes(item.id)), false);
    }
  }

  function removeImage(imageId: string) {
    void update((items) => items.filter((item) => item.image?.id !== imageId));
  }

  function removePending(itemId: string) {
    void update((items) =>
      items.filter(
        (item) =>
          item.id !== itemId ||
          !['等待', '失败', '等待重试'].includes(item.status),
      ),
    );
  }

  function stopWaiting() {
    void update((items) =>
      items.map((item) =>
        item.status === '等待' ? { ...item, status: '等待重试' } : item,
      ),
    );
    toast.info('已暂停后续排队项，当前传输中的图片将继续完成');
  }

  return (
    <UploadContext.Provider
      value={{
        queue,
        busy,
        retryAfter,
        upload,
        retryFailed,
        clearQueue,
        removeImage,
        removePending,
        stopWaiting,
        ready,
        storageError,
        prepareLeave,
        resetLeave: () => {
          leaveAllowed.current = false;
        },
        updateImages: (images) => {
          void update((items) =>
            items.map((item) => {
              const found = images.find((img) => img.id === item.image?.id);
              return found ? { ...item, image: found } : item;
            }),
          );
        },
      }}
    >
      {children}
      <AlertDialog
        open={!!leavePrompt}
        onOpenChange={(open) => {
          if (!open && leavePrompt) {
            leavePrompt.resolve(false);
            setLeavePrompt(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>离开工作台？</AlertDialogTitle>
            <AlertDialogDescription>
              {leavePrompt?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                leavePrompt?.resolve(false);
                setLeavePrompt(null);
              }}
            >
              继续留在工作台
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                leavePrompt?.resolve(true);
                setLeavePrompt(null);
              }}
            >
              确认离开
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const value = useContext(UploadContext);
  if (!value) throw new Error('useUploads must be used inside UploadProvider');
  return value;
}
