import assert from 'node:assert/strict';
import { decode, encode } from '../admin/src/piccove/passkey';
import { api, imageLink, size, type Picture } from '../admin/src/piccove/api';
const picture = {
  url: 'https://img.example/i/id',
  thumbnail_url: 'https://img.example/api/v1/images/id/thumbnail',
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
assert.equal(imageLink(picture, 'bbcode'), '[img]https://img.example/i/id[/img]');
assert.equal(imageLink(picture, 'markdown-thumbnail'), `[${imageLink({ ...picture, url: picture.thumbnail_url }, 'markdown')}](${picture.url})`);
assert.equal(imageLink(picture, 'html-thumbnail'), `<a href="${picture.url}">${imageLink({ ...picture, url: picture.thumbnail_url }, 'html')}</a>`);
assert.equal(imageLink({ ...picture, thumbnail_url: '' }, 'markdown-thumbnail'), `[${imageLink(picture, 'markdown')}](${picture.url})`);
const special = { ...picture, url: 'https://img.example/a(b) c', thumbnail_url: 'https://img.example/t(x)' };
assert.ok(imageLink(special, 'markdown-thumbnail').includes('https://img.example/t%28x%29'));
assert.ok(imageLink(special, 'markdown-thumbnail').endsWith('(https://img.example/a%28b%29%20c)'));
assert.equal(imageLink({ ...picture, url: 'https://img.example/[x]' }, 'bbcode'), '[img]https://img.example/%5Bx%5D[/img]');
assert.ok(imageLink({ ...picture, url: 'https://img.example/?x="&y=1' }, 'html-thumbnail').startsWith('<a href="https://img.example/?x=&quot;&amp;y=1">'));
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
const credentialBytes = new Uint8Array([0, 127, 128, 255]);
assert.deepEqual(decode(encode(credentialBytes.buffer)), credentialBytes);
console.log('web helpers: 18 assertions passed');
