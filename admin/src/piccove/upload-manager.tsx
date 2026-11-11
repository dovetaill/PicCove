import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NavLink, useBlocker, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Page, type Picture } from './api';
import { uploadImage, UploadError } from './upload';
import { loadUploads, saveUpload, deleteUploads } from './upload-store';

export type UploadItem = {
  id: string;
  file?: File;
  name: string;
  queuedAt: number;
  hash?: string;
  uncertain?: boolean;
  targetAlbum: string;
  status: string;
  progress: number;
  error?: string;
  image?: Picture;
};

type UploadContextValue = {
  queue: UploadItem[];
  busy: boolean;
  retryAfter: number;
  upload: (files: FileList | File[], targetAlbum: string) => void;
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

function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function UploadProvider({ children, owner }: { children: ReactNode; owner: string }) {
  const client = useQueryClient();
  const location = useLocation();
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
  const blocker = useBlocker(({ nextLocation }) => !leaveAllowed.current &&
    (!ready || queueRef.current.some((item) => !item.image)) &&
    nextLocation.pathname !== '/app' && !nextLocation.pathname.startsWith('/app/'));

  useEffect(() => {
    let cancelled = false;
    void loadUploads(owner).then((items) => {
      if (cancelled) return;
      const restored = items.sort((a, b) => a.queuedAt - b.queuedAt).map((item) => item.image ? item : {
        ...item, status: '等待重试', progress: 0,
        uncertain: item.uncertain || ['上传中', '服务器处理中', '核对结果'].includes(item.status),
      });
      queueRef.current = restored;
      setQueue(restored);
    }).catch(() => {
      persistenceFailed.current = true;
      if (!cancelled) setStorageError('无法读取本地上传记录。仍可上传，但刷新恢复可能不可用。');
    }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [owner]);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void prepareLeave().then((allowed) => { if (allowed) blocker.proceed(); else blocker.reset(); });
  }, [blocker]);

  async function prepareLeave() {
    if (!ready) { toast.info('正在恢复上传记录，请稍候'); return false; }
    await writes.current;
    const failedBeforeLeaving = persistenceFailed.current;
    if (queueRef.current.some((item) => !item.image) && !window.confirm(failedBeforeLeaving
      ? '本地保存不可用，离开可能丢失未完成的上传。确认离开？'
      : '未完成的上传将暂停，返回工作台后可以继续。确认离开？')) return false;
    controller.current?.abort();
    await Promise.resolve();
    await writes.current;
    if (!failedBeforeLeaving && persistenceFailed.current && queueRef.current.some((item) => !item.image) &&
      !window.confirm('本地保存失败，离开可能丢失未完成的上传。仍要离开？')) return false;
    leaveAllowed.current = true;
    return true;
  }

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
      if (!queueRef.current.some((item) => !item.image)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  function update(update: (items: UploadItem[]) => UploadItem[], persist = true) {
    if (!mounted.current) return Promise.resolve();
    const before = queueRef.current;
    const next = update(queueRef.current);
    queueRef.current = next;
    setQueue(next);
    if (persist && !persistenceFailed.current) {
      const removed = before.filter((item) => !next.some((row) => row.id === item.id)).map((item) => item.id);
      const changed = next.filter((item) => !before.includes(item));
      writes.current = writes.current.then(async () => {
        if (persistenceFailed.current) return;
        if (removed.length) await deleteUploads(owner, removed);
        for (const item of changed) await saveUpload(owner, item, !before.some((row) => row.id === item.id));
      }).catch(() => {
        persistenceFailed.current = true;
        if (mounted.current) setStorageError('本地上传记录未能保存（空间不足或存储不可用）。本页仍可上传，离开可能丢失待传文件。');
      });
    }
    return writes.current;
  }
  async function process(signal: AbortSignal) {
    const errors: string[] = [];
    let paused = false;
    while (true) {
      const item = queueRef.current.find((row) => row.status === '等待');
      if (!mounted.current || signal.aborted) break;
      if (!item) break;
      const itemId = item.id;
      await update((items) =>
        items.map((row) =>
          row.id === itemId
            ? { ...row, status: item.uncertain ? '核对结果' : '上传中', progress: 0, error: undefined }
            : row,
        ),
      );
      try {
        if (!item.file?.size || item.file.size > 10 * 1024 * 1024)
          throw new Error('图片不能为空，单张大小不能超过 10 MiB');
        let hash = item.hash;
        if (!hash && globalThis.crypto?.subtle) {
          hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await item.file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        let existing: Picture | undefined;
        if (item.uncertain && hash) {
          const lookup = new AbortController();
          const timeout = setTimeout(() => lookup.abort(), 15000);
          const abort = () => lookup.abort();
          signal.addEventListener('abort', abort, { once: true });
          try {
            existing = (await api<Page<Picture>>(`/images?content_hash=${hash}&expected_user_id=${owner}`, 'GET', undefined, lookup.signal)).items[0];
          } catch {
            throw new Error('暂时无法核对上次上传结果，请稍后重试；本次未重新上传。');
          } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
        }
        if (signal.aborted || !mounted.current) break;
        await update((items) => items.map((row) => row.id === itemId ? { ...row, hash, uncertain: true, status: '上传中' } : row));
        if (signal.aborted || !mounted.current) break;
        const body = new FormData();
        body.append('file', item.file);
        // The existing server content-hash deduplication also protects retries on non-secure origins without Web Crypto.
        const result = existing ? { ...existing, duplicate: true } : await uploadImage(
          `/images?expected_user_id=${owner}${item.targetAlbum !== 'all' ? `&album_id=${item.targetAlbum}` : ''}`,
          body,
          (progress) =>
            update((items) =>
              items.map((row) =>
                row.id === itemId
                  ? {
                      ...row,
                      progress,
                      status: progress === 100 ? '服务器处理中' : '上传中',
                    }
                  : row,
              ), false,
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
            row.id === itemId ? { ...row, status: signal.aborted ? '等待重试' : '失败', error: text,
              uncertain: error instanceof UploadError && error.status >= 400 && error.status < 500 ? false : row.uncertain } : row,
          ),
        );
        if (signal.aborted) break;
        errors.push(`${item.name}：${text}`);
        if (error instanceof UploadError && [401, 409, 429, 503].includes(error.status)) {
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
      if (signal.aborted) await update((items) => items.map((item) => !item.image && ['等待', '上传中', '服务器处理中', '核对结果'].includes(item.status) ? { ...item, status: '等待重试' } : item));
      setBusy(false);
      busyRef.current = false;
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
        client.invalidateQueries({ queryKey: ['albums'] }),
      ]);
      if (!mounted.current || busyRef.current) return;
      if (paused || queueRef.current.some((item) => item.status === '等待重试'))
        toast.error('上传已暂停，未完成的图片还在列表中。稍后可以点击重试。');
      else if (errors.length)
        toast.error('有图片未上传成功，请在上传结果中查看原因并重试。');
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
  async function upload(files: FileList | File[], targetAlbum: string) {
    if (!files.length) return;
    if (!ready) { toast.info('正在恢复上传记录，请稍候'); return; }
    if (retryAfter > Date.now()) {
      toast.info('上传请求过于频繁，请稍后再试');
      return;
    }
    const queuedAt = Math.max(Date.now(), (queueRef.current[queueRef.current.length - 1]?.queuedAt || 0) + 1);
    const items = Array.from(files).map((file, index) => ({
      id: id(),
      file,
      name: file.webkitRelativePath || file.name,
      queuedAt: queuedAt + index,
      targetAlbum,
      status: '等待',
      progress: 0,
    }));
    await update((queue) => [...queue, ...items]);
    setRetryAfter(0);
    if (mounted.current && !leaveAllowed.current) start();
  }
  function retryFailed() {
    if (busyRef.current) return;
    if (retryAfter > Date.now()) {
      toast.info('上传请求过于频繁，请稍后再试');
      return;
    }
    update((items) => items.map((item) =>
      ['失败', '等待重试'].includes(item.status)
        ? { ...item, status: '等待', error: undefined }
        : item,
    ));
    if (queueRef.current.some((item) => item.status === '等待')) start();
  }
  async function clearQueue() {
    if (!busyRef.current) {
      const ids = queueRef.current.map((item) => item.id);
      writes.current = writes.current.then(() => deleteUploads(owner, ids)).then(() => {}).catch(() => {
        persistenceFailed.current = true;
        if (mounted.current) setStorageError('本地记录清除失败，本页已清除；刷新后记录可能再次出现。');
      });
      await writes.current;
      await update((items) => items.filter((item) => !ids.includes(item.id)), false);
    }
  }
  function removeImage(imageId: string) {
    update((items) => items.filter((item) => item.image?.id !== imageId));
  }
  function removePending(itemId: string) {
    update((items) => items.filter((item) =>
      item.id !== itemId || !['等待', '失败', '等待重试'].includes(item.status),
    ));
  }
  function stopWaiting() {
    update((items) => items.map((item) =>
      item.status === '等待' ? { ...item, status: '等待重试' } : item,
    ));
    toast.info('已停止后续上传，当前图片仍会完成保存。');
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
        resetLeave: () => { leaveAllowed.current = false; },
        updateImages: (images) => { void update((items) => items.map((item) => {
          const image = images.find((image) => image.id === item.image?.id);
          return image ? { ...item, image } : item;
        })); },
      }}
    >
      {!!queue.length && location.pathname !== '/app' && (
        <NavLink className="cove-upload-global-status" role="status" to="/app">
          {busy ? '正在上传，请保持页面打开 · 查看进度' : '查看本次上传结果'}
        </NavLink>
      )}
      {children}
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const value = useContext(UploadContext);
  if (!value) throw new Error('useUploads must be used inside UploadProvider');
  return value;
}
