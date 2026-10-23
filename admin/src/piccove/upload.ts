import type { Picture } from './api';

export class UploadError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function uploadImage(
  path: string,
  body: FormData,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<Picture & { duplicate?: boolean }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/v1${path}`);
    const abort = () => request.abort();
    request.onloadend = () => signal?.removeEventListener('abort', abort);
    request.timeout = 120_000;
    request.ontimeout = () => reject(new UploadError('上传超时，请重试', 0));
    if (signal) {
      if (signal.aborted) return reject(new UploadError('上传已中止', 0));
      signal.addEventListener('abort', abort, { once: true });
    }
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(
          Math.min(99, Math.round((event.loaded / event.total) * 100)),
        );
    };
    request.upload.onload = () => onProgress(100);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300)
        resolve(request.response || {});
      else
        reject(
          new UploadError(
            request.response?.error || `上传失败 (${request.status})`,
            request.status,
          ),
        );
    };
    request.onerror = () => reject(new UploadError('网络连接失败，请重试', 0));
    request.onabort = () => reject(new UploadError('上传已中止', 0));
    request.send(body);
  });
}
