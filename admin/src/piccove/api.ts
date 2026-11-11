import { useQuery } from '@tanstack/react-query';

export type User = {
  id: string;
  username: string;
  is_admin: boolean;
  disabled: boolean;
  quota_bytes: number;
  violation_count: number;
  moderation_exempt: boolean;
  content_ban: "auto" | "manual" | null;
};
export type Account = { user: User; used_bytes: number };
export type Picture = {
  id: string;
  user_id: string;
  album_id: string | null;
  original_name: string;
  size_bytes: number;
  width: number;
  height: number;
  url: string;
  thumbnail_url: string;
  deleted_at: string | null;
  is_public: boolean;
  moderation_status: string;
  moderation_reason: string;
  moderation_hold: boolean;
};
export type Album = {
  id: string;
  name: string;
  description: string | null;
  image_count?: number;
  cover_id?: string | null;
};
export type Settings = {
  registration_open: boolean;
  contact_url: string | null;
};
export type Page<T> = { items: T[]; has_more: boolean };
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers:
      body && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error || `请求失败 (${response.status})`,
      response.status,
    );
  }
  return response.headers.get('content-type')?.includes('application/json')
    ? response.json()
    : (undefined as T);
}
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api<Account>('/me').catch((error) => {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }),
    retry: false,
    staleTime: 0,
  });
}
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/settings'),
  });
}
export function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
export function sharingProblem(image: Picture): string | null {
  if (image.deleted_at) return '图片已删除，链接已失效';
  if (['blocked', 'review'].includes(image.moderation_status))
    return '图片被审核限制，暂不能公开分享';
  if (image.moderation_hold && ['pending', 'running', 'failed'].includes(image.moderation_status))
    return '图片尚未通过审核，暂不能公开分享';
  if (!image.is_public) return '这是私有图片，如需公开分享，请先在安卓端设为公开';
  return null;
}
export async function latestPictures(pictures: Picture[], all = false, signal?: AbortSignal) {
  const request = new AbortController();
  const abort = () => request.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  const ids = [...new Set(pictures.map((item) => item.id))];
  const current = new Map<string, Picture>();
  try {
    for (let index = 0; index < ids.length; index += 48) {
      const page = await api<Page<Picture>>(`/images?all=${all}&ids=${ids.slice(index, index + 48).join(',')}`, 'GET', undefined, request.signal);
      page.items.forEach((item) => current.set(item.id, item));
    }
    return pictures.map((item) => current.get(item.id) || { ...item, deleted_at: item.deleted_at || new Date().toISOString() });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
export function imageLink(image: Picture, format: string): string {
  if (format === 'bbcode')
    return `[img]${image.url.replace(/[\[\]]/g, (c) => (c === '[' ? '%5B' : '%5D'))}[/img]`;
  if (format === 'markdown' || format === 'markdown-thumbnail') {
    const alt = image.original_name
      .replace(/[\r\n]/g, ' ')
      .replace(/[\\[\]]/g, '\\$&');
    const url = (value: string) =>
      value.replace(/[\s()\\<>]/g, (c) =>
        encodeURIComponent(c).replace(/\(/g, '%28').replace(/\)/g, '%29'),
      );
    const preview = `![${alt}](${url(format === 'markdown-thumbnail' ? image.thumbnail_url || image.url : image.url)})`;
    return format === 'markdown-thumbnail'
      ? `[${preview}](${url(image.url)})`
      : preview;
  }
  if (format === 'html' || format === 'html-thumbnail') {
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (char) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[char]!,
      );
    const img = `<img src="${escape(format === 'html-thumbnail' ? image.thumbnail_url || image.url : image.url)}" alt="${escape(image.original_name)}" />`;
    return format === 'html-thumbnail'
      ? `<a href="${escape(image.url)}">${img}</a>`
      : img;
  }
  return image.url;
}
