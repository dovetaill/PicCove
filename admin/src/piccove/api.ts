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
export type Album = { id: string; name: string; description: string | null };
export type Settings = {
  registration_open: boolean;
  contact_url: string | null;
};
export type Page<T> = { items: T[]; has_more: boolean };
class ApiError extends Error {
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
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
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
