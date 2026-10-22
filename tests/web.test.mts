import assert from 'node:assert/strict';
import { api, imageLink, size, type Picture } from '../admin/src/piccove/api';
const picture = {
  url: 'https://img.example/i/id',
  original_name: 'a[1] <"&>\nphoto',
} as Picture;
assert.equal(imageLink(picture, 'url'), picture.url);
assert.equal(
  imageLink(picture, 'markdown'),
  '![a\\[1\\] <"&> photo](https://img.example/i/id)',
);
assert.equal(
  imageLink(picture, 'html'),
  '<img src="https://img.example/i/id" alt="a[1] &lt;&quot;&amp;&gt;\nphoto" />',
);
assert.equal(size(1073741824), '1.00 GiB');
let options: RequestInit | undefined;
globalThis.fetch = async (_url, init) => {
  options = init;
  return new Response(null, { status: 201 });
};
assert.equal(
  await api('/admin/users', 'POST', { username: 'alice' }),
  undefined,
);
assert.equal(options?.credentials, 'same-origin');
assert.equal(options?.body, '{"username":"alice"}');
globalThis.fetch = async () =>
  new Response('{"error":"注册暂未开放"}', {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
await assert.rejects(api('/auth/register', 'POST', {}), /注册暂未开放/);
globalThis.fetch = async () =>
  new Response('{"registration_open":false}', {
    headers: { 'Content-Type': 'application/json' },
  });
assert.deepEqual(await api('/settings'), { registration_open: false });
console.log('web helpers: 9 assertions passed');
