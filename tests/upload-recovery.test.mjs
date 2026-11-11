// Current production build + real browser storage, all HTTP requests intercepted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
const { chromium } = await import(pathToFileURL(process.env.PICCOVE_PLAYWRIGHT));
const browser = await chromium.launch({ executablePath: `${dir}/browser/chrome-linux64/chrome`, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';
  const albumId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let owner = alice, mode = 'auto', commitHeld = false, failLookup = false, failLogout = false, failMe = false;
  let dismiss = false, prompts = 0, nextId = 1;
  const images = [], posts = [], holds = [], lookups = [], errors = [];
  const albums = [{ id: albumId, name: '旅行', description: '' }];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => { prompts++; if (dismiss) await dialog.dismiss(); else await dialog.accept(); });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => {
    if (window.denyCopy) throw Error('Clipboard denied'); window.copiedText = value;
  } } }));
  const picture = (name, album = null) => ({ id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, user_id: owner, album_id: album,
    original_name: name, size_bytes: name.length, width: 10, height: 10, is_public: true, deleted_at: null, moderation_status: 'passed', moderation_hold: false,
    url: `https://piccove.test/i/${name}`, thumbnail_url: `https://piccove.test/i/${name}` });
  const hashes = new Map();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url()), path = u.pathname, method = route.request().method();
    if (u.hostname !== 'piccove.test') return route.abort();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.startsWith('/i/') || path.endsWith('/thumbnail')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="#93b9ae"/></svg>' });
    if (path.startsWith('/api/v1/')) {
      const api = path.slice(7);
      if (api === '/me') return failMe ? json({ error: '暂时离线' }, 503) : json({ user: { id: owner, username: 'tester', is_admin: false, quota_bytes: 1000000 }, used_bytes: 100 });
      if (api === '/settings') return json({ registration_open: false });
      if (api === '/auth/login') return json({});
      if (api === '/auth/logout') return failLogout ? json({ error: '退出失败' }, 503) : json({});
      if (api === '/albums') return json(albums);
      if (api === '/images') {
        if (u.searchParams.has('expected_user_id') && u.searchParams.get('expected_user_id') !== owner) return json({ error: '账号已切换，请重新打开工作台' }, 409);
        if (method === 'GET') {
          let found = images.filter((item) => item.user_id === owner);
          const ids = u.searchParams.get('ids'), hash = u.searchParams.get('content_hash');
          if (ids) found = found.filter((item) => ids.split(',').includes(item.id));
          if (hash) { lookups.push(hash); if (failLookup) return json({ error: '仍在处理' }, 503); found = found.filter((item) => hashes.get(hash) === item.id && !item.deleted_at); }
          if (u.searchParams.has('album_id')) found = found.filter((item) => item.album_id === u.searchParams.get('album_id'));
          return json({ items: found, has_more: false });
        }
        const body = route.request().postDataBuffer().toString();
        const name = body.match(/filename="([^"]+)"/)[1];
        assert(body.includes(`\r\n\r\n${name}\r\n`), 'Restored file bytes must survive reload');
        posts.push({ name, album: u.searchParams.get('album_id'), owner: u.searchParams.get('expected_user_id') });
        const hash = createHash('sha256').update(name).digest('hex');
        const duplicate = images.find((item) => item.id === hashes.get(hash));
        const result = duplicate ? { ...duplicate, duplicate: true } : picture(name, u.searchParams.get('album_id'));
        const commit = () => { if (!images.some((item) => item.id === result.id)) images.unshift(result); hashes.set(hash, result.id); };
        if (mode === 'hold') { if (commitHeld) commit(); holds.push(async () => { commit(); await json(result, 201); }); return; }
        commit(); return json(result, duplicate ? 200 : 201);
      }
      if (api.startsWith('/images/') && method === 'PATCH') { Object.assign(images.find((item) => item.id === api.split('/').at(-1)), route.request().postDataJSON()); return route.fulfill({ status: 204 }); }
      throw Error(`Unexpected request ${method} ${api}`);
    }
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`${dir}/admin/dist/${file}`) });
  });
  const file = (name) => ({ name, mimeType: 'image/png', buffer: Buffer.from(name) });
  const queue = page.getByRole('region', { name: '上传队列' });
  const ready = () => page.getByRole('button', { name: '选择图片', exact: true }).waitFor();
  const finished = () => queue.getByRole('heading', { name: '上传结果' }).waitFor();
  const waitPosts = async (count) => { for (let n = 0; posts.length < count && n < 300; n++) await new Promise((r) => setTimeout(r, 10)); assert.equal(posts.length, count); };
  const clear = async () => { await queue.getByRole('button', { name: '清除上传记录' }).click(); await queue.waitFor({ state: 'hidden' }); };
  await page.goto('https://piccove.test/login');
  await page.getByRole('button', { name: '改用密码＋二步验证' }).click();
  await page.getByLabel('用户名', { exact: true }).fill('tester');
  await page.getByLabel('密码', { exact: true }).fill('password12345');
  await page.getByRole('button', { name: '使用密码登录', exact: true }).click(); await ready();
  mode = 'hold';
  await page.locator('input[type=file]').first().setInputFiles([file('first.png'), file('second.png')]); await waitPosts(1);
  dismiss = true; await page.goBack();
  await page.waitForFunction(() => location.pathname === '/app');
  assert.equal(await queue.locator('li').count(), 2); assert(prompts > 0);
  dismiss = false; await page.goBack(); await page.getByRole('heading', { name: '欢迎回到图湾' }).waitFor();
  await page.goForward(); await ready(); assert.equal(await queue.locator('li').count(), 2);
  await page.reload(); await ready(); assert.equal(await queue.locator('li').count(), 2); assert.equal(posts.length, 1);
  mode = 'auto'; await queue.getByRole('button', { name: '重试未完成项' }).click(); await finished();
  assert.equal(posts.length, 3); assert(lookups.length > 0); await clear();
  console.log('PASS back cancel/confirm and refresh restore files; explicit resume reconciles before retry');

  mode = 'hold'; commitHeld = true; holds.length = 0;
  await page.locator('input[type=file]').first().setInputFiles(file('lost-response.png')); await waitPosts(4);
  await page.reload(); await ready(); failLookup = true;
  await queue.getByRole('button', { name: '重试未完成项' }).click();
  await queue.getByRole('alert').filter({ hasText: '暂时无法核对' }).waitFor(); assert.equal(posts.length, 4);
  failLookup = false; mode = 'auto';
  await queue.getByRole('button', { name: '重试未完成项' }).click(); await finished(); assert.equal(posts.length, 4);
  await clear(); console.log('PASS lost response finds committed image without reposting; lookup failure retains recovery');

  mode = 'hold'; commitHeld = false; holds.length = 0;
  await page.locator('input[type=file]').first().setInputFiles(file('alice-only.png')); await waitPosts(5);
  owner = bob; await page.reload(); await ready(); assert.equal(await queue.count(), 0);
  owner = alice; await page.reload(); await ready(); assert.equal(await queue.locator('li').count(), 1);
  owner = bob; mode = 'auto'; await queue.getByRole('button', { name: '重试未完成项' }).click();
  await queue.waitFor({ state: 'hidden' }); assert.equal(posts.length, 5);
  owner = alice; await page.reload(); await ready(); await clear();
  console.log('PASS persisted queues and outgoing uploads remain scoped to the original account');

  mode = 'hold'; holds.length = 0; failLogout = true;
  await page.locator('input[type=file]').first().setInputFiles(file('logout-fails.png')); await waitPosts(6);
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByText('退出失败', { exact: true }).waitFor();
  await queue.getByRole('button', { name: '重试未完成项' }).waitFor();
  mode = 'auto'; await queue.getByRole('button', { name: '重试未完成项' }).click(); await finished(); await clear(); failLogout = false;
  console.log('PASS failed logout leaves a resumable queue');

  await page.getByRole('checkbox', { name: '选择 first.png', exact: true }).check();
  await page.getByRole('combobox', { name: '上传到相册' }).click(); await page.getByRole('option', { name: '旅行', exact: true }).click();
  assert.equal(new URL(page.url()).search, ''); assert(await page.getByRole('checkbox', { name: '选择 first.png', exact: true }).isChecked());
  await page.locator('input[type=file]').first().setInputFiles(file('first.png')); await finished();
  await queue.getByText('重复图片保留原名称、公开状态和相册。展开上传明细可查看原位置，或移入目标相册。').waitFor();
  assert.equal(images.find((item) => item.original_name === 'first.png').album_id, null);
  await queue.locator('summary').click(); await queue.getByRole('button', { name: '移入「旅行」' }).click();
  await page.getByText('已移入目标相册，原图和外链已保留', { exact: true }).waitFor();
  assert.equal(images.find((item) => item.original_name === 'first.png').album_id, albumId);
  console.log('PASS upload destination preserves selection; duplicate keeps location until explicit move');

  const first = images.find((item) => item.original_name === 'first.png'); first.moderation_status = 'pending'; first.moderation_hold = true;
  await clear(); await page.locator('input[type=file]').first().setInputFiles(file('first.png')); await finished();
  albums.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '空相册', description: '' });
  await page.getByRole('link', { name: '相册', exact: true }).click(); await page.getByRole('link', { name: '打开相册 空相册', exact: true }).click();
  await queue.getByRole('button', { name: '复制本次链接' }).click();
  await page.getByRole('textbox', { name: '批量图片链接' }).waitFor();
  assert(await page.getByRole('button', { name: '复制全部链接' }).isDisabled());
  await page.getByRole('combobox', { name: '批量链接格式' }).click();
  await page.getByRole('option', { name: 'HTML 外链', exact: true }).click();
  first.moderation_status = 'passed';
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="批量图片链接"]')?.value.startsWith('<img'));
  assert.equal(await page.getByRole('textbox', { name: '批量图片链接' }).inputValue(), `<img src="${first.url}" alt="first.png" />`);
  await page.keyboard.press('Escape'); await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.denyCopy = true; });
  await queue.locator('summary').click(); await queue.getByRole('button', { name: '复制上传结果 first.png' }).click();
  await page.getByRole('textbox', { name: '批量图片链接' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '批量图片链接' }).inputValue(), first.url);
  await page.keyboard.press('Escape'); await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  console.log('PASS sharing refreshes off-page moderation and clipboard failure opens selectable links');

  albums[0].name = 'W'.repeat(100); albums[0].description = 'Z'.repeat(500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`https://piccove.test/app?album=${albumId}`); await ready();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.goto('https://piccove.test/app/albums'); await page.getByRole('button', { name: '创建相册', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.setViewportSize({ width: 390, height: 320 });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '创建相册', exact: true }).scrollIntoViewIfNeeded();
  const save = await dialog.getByRole('button', { name: '创建相册', exact: true }).boundingBox(); assert(save.y >= 0 && save.y + save.height <= 320);
  await dialog.getByRole('button', { name: 'Close' }).scrollIntoViewIfNeeded();
  const close = await dialog.getByRole('button', { name: 'Close' }).boundingBox(); assert(close.y >= 0 && close.y + close.height <= 320);
  console.log('PASS long names wrap at 390px and all album dialog actions remain reachable at 390x320');

  const broken = await browser.newPage();
  await broken.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw Error('Storage unavailable'); } }));
  // Reuse only mocked responses, never connect to a deployed host.
  await broken.route('**/*', async (route) => {
    const u = new URL(route.request().url()); if (u.hostname !== 'piccove.test') return route.abort();
    if (u.pathname === '/api/v1/me') return route.fulfill({ json: { user: { id: bob, username: 'tester', is_admin: false, quota_bytes: 10000 }, used_bytes: 0 } });
    if (u.pathname === '/api/v1/albums') return route.fulfill({ json: [] });
    if (u.pathname === '/api/v1/images') return route.fulfill({ json: route.request().method() === 'POST' ? picture('fallback.png') : { items: [], has_more: false } });
    const file = u.pathname.startsWith('/assets/') ? u.pathname.slice(1) : 'index.html';
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`${dir}/admin/dist/${file}`) });
  });
  await broken.goto('https://piccove.test/app'); await broken.getByRole('alert').filter({ hasText: '无法读取本地上传记录' }).waitFor();
  await broken.getByRole('button', { name: '选择图片', exact: true }).waitFor();
  await broken.locator('input[type=file]').first().setInputFiles(file('fallback.png'));
  await broken.getByRole('heading', { name: '上传结果' }).waitFor(); await broken.close();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Escape'); await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  await page.goto('https://piccove.test/app'); await ready(); await clear();
  mode = 'hold'; holds.length = 0;
  await page.addInitScript(() => { IDBObjectStore.prototype.add = function () { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.reload(); await ready();
  const beforeQuota = posts.length;
  await page.locator('input[type=file]').first().setInputFiles(file('quota-fallback.png')); await waitPosts(beforeQuota + 1);
  await page.getByRole('alert').filter({ hasText: '本地上传记录未能保存' }).waitFor();
  dismiss = true; const leave = page.waitForEvent('dialog'); await page.locator('.cove-brand').click();
  assert((await leave).message().includes('本地保存不可用')); assert.equal(new URL(page.url()).pathname, '/app'); dismiss = false;
  failMe = true; const meFailure = page.waitForResponse((response) => response.url().endsWith('/api/v1/me') && response.status() === 503);
  await page.evaluate(() => {
    let visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    window.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible'; window.dispatchEvent(new Event('visibilitychange'));
  }); await (await meFailure).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await queue.count(), 1); assert(await page.getByRole('heading', { name: '正在上传', exact: true }).isVisible());
  failMe = false; await holds.shift()(); await finished();
  assert.deepEqual(errors, []);
  console.log('PASS local read/write failures preserve normal upload, leaving warns truthfully, background account failures do not abort upload');
} finally { await browser.close(); console.log('Recovery browser closed; no listening port was started.'); }
