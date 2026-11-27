import { useQuery } from '@tanstack/react-query';

export type User = {
  id: string;
  username: string;
  is_admin: boolean;
  disabled: boolean;
  quota_bytes: number;
  violation_count: number;
  moderation_exempt: boolean;
  content_ban: 'auto' | 'manual' | null;
  totp_enabled?: boolean;
  created_at?: string;
};

export type Account = {
  user: User;
  used_bytes: number;
};

export type Picture = {
  id: string;
  user_id: string;
  username?: string;
  album_id: string | null;
  original_name: string;
  content_type?: string;
  size_bytes: number;
  width: number;
  height: number;
  created_at?: string;
  url: string;
  thumbnail_url: string;
  deleted_at: string | null;
  is_public: boolean;
  moderation_status: string;
  moderation_reason: string;
  moderation_hold: boolean;
  duplicate?: boolean;
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
  private_images?: boolean;
};

export type Page<T> = {
  items: T[];
  has_more: boolean;
  total?: number;
};

export type AdminOverview = {
  users_total: number;
  users_disabled: number;
  users_banned: number;
  images_total: number;
  images_public: number;
  used_bytes: number;
  registration_open: boolean;
  reviews_pending: number;
  jobs_active: number;
};

export type ReviewItem = {
  id: string;
  username: string;
  status: string;
  reason: string;
  categories: string[];
  counted: boolean;
  attempts: number;
  image_id: string | null;
  created_at: string;
};

export type AiProvider = {
  base_url: string;
  key: string;
  model: string;
};

export type AiConfig = {
  generation: AiProvider;
  generation_mode: 'images' | 'responses';
  moderation: AiProvider;
  image_model: string;
  moderation_enabled: boolean;
  before_publish: boolean;
  daily_limit: number;
  concurrent_limit: number;
  ban_threshold: number;
  generation_key_set?: boolean;
  moderation_key_set?: boolean;
};

export type AiStatus = {
  enabled: boolean;
  used: number;
  daily_limit: number;
  unlimited: boolean;
};

export type AiConversation = {
  id: string;
  title: string;
};

export type AiMessage = {
  id: string;
  prompt: string;
  text: string;
  reference_id: string | null;
  image_id: string | null;
  image_status: string | null;
  image_reason: string | null;
  reference_status: string | null;
  status: string;
  error: string;
};

export type StorageLocation = {
  id: string;
  path: string;
  default: boolean;
  count: number;
  used_bytes: number;
  available_bytes: number | null;
  error: string | null;
};

export type FileJob = {
  id: string;
  kind: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  created_at?: string;
};

export type FileJobItem = {
  id: string;
  source_key: string;
  status: string;
  error: string | null;
};

export type ImportCandidate = {
  key: string;
  size: number;
  signature: string;
};

export type SystemStatus = {
  version: string;
  manager: { state: string; message?: string } | null;
  manager_error: string | null;
};

export type ReleaseCheck = {
  latest: string;
  update_available: boolean;
  url: string;
};

export type ApiTokenItem = {
  id: string;
  name: string;
  default_album_id: string | null;
  default_public: boolean;
  last_used_at: string | null;
  created_at: string;
};

export type CreatedApiToken = ApiTokenItem & {
  token: string;
};

export type ImageShareItem = {
  id: string;
  url: string;
  expires_at: string;
  created_at: string;
};

export type BatchImageResult = {
  processed: number;
  skipped: number;
};

export const LINK_FORMATS = [
  ['url', '图片地址（直链）'],
  ['markdown', 'Markdown 外链'],
  ['html', 'HTML 外链'],
  ['bbcode', 'BBCode 外链'],
  ['markdown-thumbnail', 'Markdown 缩略图链接'],
  ['html-thumbnail', 'HTML 缩略图链接'],
] as const;

export const REVIEW_LABELS: Record<string, string> = {
  unreviewed: '未审核',
  exempt: '免审',
  pending: '待审核',
  running: '审核中',
  passed: '已通过',
  blocked: '违规拦截',
  review: '待复核',
  failed: '审核失败',
};

export function reviewBadgeVariant(
  status?: string | null,
): 'success' | 'warning' | 'destructive' | 'info' | 'secondary' {
  switch (status) {
    case 'passed':
      return 'success';
    case 'exempt':
      return 'info';
    case 'pending':
    case 'running':
    case 'review':
      return 'warning';
    case 'blocked':
    case 'failed':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown, fallback = '操作失败'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const effectiveSignal =
    signal ??
    (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(30_000)
      : undefined);
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    signal: effectiveSignal,
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
    refetchOnWindowFocus: true,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/settings'),
  });
}

export function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function sharingProblem(image: Picture): string | null {
  if (image.deleted_at) return '图片已删除，外链已失效';
  if (['blocked', 'review'].includes(image.moderation_status))
    return '图片受审核限制，暂不能公开分享';
  if (
    image.moderation_hold &&
    ['pending', 'running', 'failed'].includes(image.moderation_status)
  )
    return '图片尚未通过审核，暂不能公开分享';
  if (!image.is_public) return '这是私有图片，设为公开后即可分享外链';
  return null;
}

export async function latestPictures(
  pictures: Picture[],
  all = false,
  signal?: AbortSignal,
): Promise<Picture[]> {
  const request = new AbortController();
  const abort = () => request.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  const ids = [...new Set(pictures.map((item) => item.id))];
  const current = new Map<string, Picture>();
  try {
    for (let index = 0; index < ids.length; index += 48) {
      const page = await api<Page<Picture>>(
        `/images?all=${all}&ids=${ids.slice(index, index + 48).join(',')}`,
        'GET',
        undefined,
        request.signal,
      );
      page.items.forEach((item) => current.set(item.id, item));
    }
    return pictures.map(
      (item) =>
        current.get(item.id) || {
          ...item,
          deleted_at: item.deleted_at || new Date().toISOString(),
        },
    );
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
