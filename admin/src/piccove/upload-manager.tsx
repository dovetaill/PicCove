import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Picture } from './api';
import { uploadImage, UploadError } from './upload';

export type UploadItem = {
  id: string;
  file: File;
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
};

const UploadContext = createContext<UploadContextValue | null>(null);

function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const location = useLocation();
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const queueRef = useRef<UploadItem[]>([]);
  const busyRef = useRef(false);
  const mounted = useRef(true);

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
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(update: (items: UploadItem[]) => UploadItem[]) {
    if (!mounted.current) return;
    const next = update(queueRef.current);
    queueRef.current = next;
    setQueue(next);
  }
  async function process(ids: string[], signal: AbortSignal) {
    const errors: string[] = [];
    let paused = false;
    for (const itemId of ids) {
      const item = queueRef.current.find((row) => row.id === itemId);
      if (!mounted.current || signal.aborted) break;
      if (!item) continue;
      update((items) =>
        items.map((row) =>
          row.id === itemId
            ? { ...row, status: '上传中', progress: 0, error: undefined }
            : row,
        ),
      );
      try {
        if (!item.file.size || item.file.size > 10 * 1024 * 1024)
          throw new Error('图片不能为空，单张大小不能超过 10 MiB');
        const body = new FormData();
        body.append('file', item.file);
        const result = await uploadImage(
          `/images${item.targetAlbum !== 'all' ? `?album_id=${item.targetAlbum}` : ''}`,
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
              ),
            ),
          signal,
        );
        update((items) =>
          items.map((row) =>
            row.id === itemId
              ? {
                  ...row,
                  status: result.duplicate ? '已存在' : '完成',
                  image: result,
                }
              : row,
          ),
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : '操作失败';
        update((items) =>
          items.map((row) =>
            row.id === itemId ? { ...row, status: '失败', error: text } : row,
          ),
        );
        if (signal.aborted) break;
        errors.push(`${item.file.name}：${text}`);
        if (error instanceof UploadError && [429, 503].includes(error.status)) {
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
      setBusy(false);
      busyRef.current = false;
      await Promise.all([
        client.invalidateQueries({ queryKey: ['images'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
      ]);
      if (paused)
        toast.error('上传已暂停，未完成的图片还在列表中。稍后可以点击重试。');
      else if (errors.length)
        toast.error('有图片未上传成功，请在上传结果中查看原因并重试。');
      else toast.success('图片上传完成');
    }
  }
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function start(ids: string[]) {
    busyRef.current = true;
    setBusy(true);
    controller.current = new AbortController();
    void process(ids, controller.current.signal);
  }
  function upload(files: FileList | File[], targetAlbum: string) {
    if (!files.length) return;
    if (retryAfter > Date.now()) {
      toast.info('上传请求过于频繁，请稍后再试');
      return;
    }
    if (busyRef.current) {
      toast.info('正在处理，请稍等片刻再添加图片');
      return;
    }
    const items = Array.from(files).map((file) => ({
      id: id(),
      file,
      targetAlbum,
      status: '等待',
      progress: 0,
    }));
    queueRef.current = items;
    setQueue(items);
    setRetryAfter(0);
    start(items.map((item) => item.id));
  }
  function retryFailed() {
    if (busyRef.current) return;
    if (retryAfter > Date.now()) {
      toast.info('上传请求过于频繁，请稍后再试');
      return;
    }
    const ids = queueRef.current
      .filter((item) => ['失败', '等待重试'].includes(item.status))
      .map((item) => item.id);
    if (ids.length) start(ids);
  }
  function clearQueue() {
    if (!busyRef.current) {
      queueRef.current = [];
      setQueue([]);
    }
  }
  function removeImage(imageId: string) {
    update((items) => items.filter((item) => item.image?.id !== imageId));
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
