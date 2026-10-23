import assert from 'node:assert/strict';
import { uploadImage, UploadError } from '../admin/src/piccove/upload.ts';

let request;
globalThis.XMLHttpRequest = class {
  upload = {};
  open(method, url) { this.method = method; this.url = url; }
  send(body) { this.body = body; request = this; }
  abort() { this.onabort(); this.onloadend(); }
};
const body = new FormData();
const progress = [];
const result = uploadImage('/images?album_id=test', body, (value) => progress.push(value));
assert.equal(request.method, 'POST');
assert.equal(request.url, '/api/v1/images?album_id=test');
assert.equal(request.body, body);
assert.equal(request.responseType, 'json');
request.upload.onprogress({ lengthComputable: false, loaded: 1, total: 0 });
request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
assert.deepEqual(progress, [25]);
request.upload.onload();
assert.deepEqual(progress, [25, 100]);
let settled = false;
result.then(() => { settled = true; });
await Promise.resolve();
assert.equal(settled, false, 'Transmission complete must not mean saved successfully');
request.status = 200;
request.response = { duplicate: true };
request.onload();
assert.deepEqual(await result, { duplicate: true });
for (const [status, response, expected] of [[201, { id: 'new' }, null], [413, null, /413/], [400, { error: '无效图片' }, /无效图片/]]) {
  const pending = uploadImage('/images', body, () => {});
  request.status = status;
  request.response = response;
  request.onload();
  if (expected) await assert.rejects(pending, expected);
  else assert.deepEqual(await pending, response);
}
for (const event of ['onerror', 'onabort', 'ontimeout']) {
  const pending = uploadImage('/images', body, () => {});
  request[event]();
  await assert.rejects(pending);
}
console.log('Upload checks passed: byte progress, processing phase, duplicate response, HTTP/network/abort failures.');

const limited = uploadImage('/images', body, () => {});
request.status = 429;
request.response = { error: '限速' };
request.onload();
await assert.rejects(limited, (error) => error instanceof UploadError && error.status === 429);
const controller = new AbortController();
const aborted = uploadImage('/images', body, () => {}, controller.signal);
assert.equal(request.timeout, 120000);
controller.abort();
await assert.rejects(aborted, /上传已中止/);
console.log('Upload timeout, HTTP status and signal cancellation checks passed.');
