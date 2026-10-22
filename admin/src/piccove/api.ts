import { useQuery } from '@tanstack/react-query';
export type User = {
  id: string;
  username: string;
  is_admin: boolean;
  disabled: boolean;
  quota_bytes: number;
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
  deleted_at: string | null;
  is_public: boolean;
};
export type Album = { id: string; name: string };
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
  if (format === 'markdown')
    return `![${image.original_name.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&')}](${image.url})`;
  if (format === 'html') {
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
    return `<img src="${escape(image.url)}" alt="${escape(image.original_name)}" />`;
  }
  return image.url;
}
