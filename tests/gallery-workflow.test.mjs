// Offline production build, disposable fixture and browser; no deployed API is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(dir?.startsWith('/'));
const { chromium } = await import(pathToFileURL(process.env.PICCOVE_PLAYWRIGHT));
const browser = await chromium.launch({ executablePath: `${dir}/browser/chrome-linux64/chrome`, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copiedText = text; } } }));
  const albumId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const picture = (id, extra = {}) => ({ id, user_id: 'u', album_id: null, original_name: `${id}.png`, size_bytes: 100, width: 20, height: 20, url: `http://piccove.test/i/${id}`, thumbnail_url: `http://piccove.test/i/${id}`, is_public: true, moderation_status: 'passed', moderation_hold: false, deleted_at: null, ...extra });
  const images = [picture('one'), picture('two'), picture('three')];
  const albums = [{ id: albumId, name: '旅行', description: '旅途照片' }];
  let creates = 0;
  let failedMove = false;
  let failSettings = false;
  const moves = [];
  const uploads = [];
  const holds = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'piccove.test') return route.abort();
    const path = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/thumbnail') || path.startsWith('/i/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#93b9ae"/></svg>' });
    if (path.startsWith('/api/v1/')) {
      const api = path.slice(7);
      if (api === '/me') return json({ user: { id: 'u', username: 'tester', is_admin: false, quota_bytes: 1000000 }, used_bytes: 300 });
      if (api === '/auth/logout') return json({});
      if (api === '/settings') return failSettings ? json({ error: '注册设置暂不可用' }, 503) : json({ registration_open: false });
      if (api === '/albums') {
        if (method === 'POST') {
          creates++;
          const created = { id: newId, ...route.request().postDataJSON() };
          albums.push(created);
          return json(created, 201);
        }
        return json(albums.map((album) => {
          const contents = images.filter((item) => item.album_id === album.id);
          return { ...album, image_count: contents.length, cover_id: contents[0]?.id || null };
        }));
      }
      if (api.startsWith('/albums/') && method === 'DELETE') {
        const id = api.split('/').at(-1);
        albums.splice(albums.findIndex((item) => item.id === id), 1);
        images.forEach((item) => { if (item.album_id === id) item.album_id = null; });
        return route.fulfill({ status: 204 });
      }
      if (api === '/images' && method === 'GET') {
        if (url.searchParams.has('ids')) return json({ items: images.filter((item) => url.searchParams.get('ids').split(',').includes(item.id)), has_more: false });
        const filtered = images.filter((item) => !url.searchParams.has('album_id') || item.album_id === url.searchParams.get('album_id'));
        const offset = (Number(url.searchParams.get('page') || 1) - 1) * 2;
        return json({ items: filtered.slice(offset, offset + 2), has_more: filtered.length > offset + 2 });
      }
      if (api.startsWith('/images/') && method === 'PATCH') {
        const id = api.split('/').at(-1);
        const body = route.request().postDataJSON();
        moves.push([id, body]);
        if (id === 'two' && !failedMove) { failedMove = true; return json({ error: '暂时无法移动' }, 503); }
        Object.assign(images.find((item) => item.id === id), body);
        return route.fulfill({ status: 204 });
      }
      if (api === '/images' && method === 'POST') {
        const name = route.request().postDataBuffer().toString().match(/filename="([^"]+)"/)[1];
        uploads.push({ name, album: url.searchParams.get('album_id') });
        holds.push(async (status = 201) => {
          const result = picture(name.replace('.png', ''), { original_name: name, album_id: url.searchParams.get('album_id') });
          if (status === 201) images.unshift(result);
          await json(status === 201 ? result : { error: '模拟上传失败' }, status);
        });
        return;
      }
      throw Error(`Unexpected API ${method} ${api}`);
    }
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`${dir}/admin/dist/${file}`) });
  });
  const release = async (status = 201) => {
    for (let i = 0; !holds.length && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    assert(holds.length, 'Upload must reach the mock API');
    await holds.shift()(status);
  };
  const file = (name) => ({ name: `${name}.png`, mimeType: 'image/png', buffer: Buffer.from('fixture') });
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.goto('http://piccove.test/app');
  assert.equal(await page.getByRole('button', { name: '移动到相册', exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: '选择本页' }).click();
  await page.getByRole('button', { name: '移动到相册', exact: true }).click();
  await page.getByRole('button', { name: '新建相册并移入' }).click();
  await page.getByLabel('名称', { exact: true }).fill('博客配图');
  await page.getByRole('button', { name: '创建相册', exact: true }).click();
  await page.getByText(/已完成 1 张，剩余 1 张未完成/).waitFor();
  assert.equal(creates, 1);
  assert.equal(await page.getByRole('checkbox', { name: '选择 one.png', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByRole('checkbox', { name: '选择 two.png', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: '移动到相册', exact: true }).click();
  await page.getByRole('combobox', { name: '目标相册', exact: true }).filter({ hasText: '博客配图' }).waitFor();
  await page.getByRole('button', { name: '确认移动' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(creates, 1);
  assert.deepEqual(moves.map(([id]) => id), ['one', 'two', 'two']);
  assert(images.slice(0, 2).every((item) => item.album_id === newId));
  assert.equal(images[0].url, 'http://piccove.test/i/one');
  console.log('PASS create from selection, partial move failure and retry without duplicate creation');

  await page.getByRole('link', { name: '相册', exact: true }).click();
  await page.getByText('2 张', { exact: true }).waitFor();
  const cover = page.getByRole('link', { name: '打开相册 博客配图', exact: true }).locator('img');
  await cover.waitFor();
  assert.equal(await cover.getAttribute('src'), '/api/v1/images/one/thumbnail');
  await page.getByRole('link', { name: '打开相册 旅行', exact: true }).click();
  await page.getByRole('heading', { name: '旅行', exact: true }).waitFor();
  await page.getByRole('button', { name: '从图库移入' }).first().click();
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByRole('checkbox', { name: '选择 three.png', exact: true }).click();
  await page.getByRole('button', { name: '移入当前相册' }).click();
  await page.getByRole('heading', { name: '旅行', exact: true }).waitFor();
  assert.equal(images.find((item) => item.id === 'three').album_id, albumId);
  await page.getByRole('checkbox', { name: '选择 three.png', exact: true }).click();
  await page.getByRole('button', { name: '移出相册', exact: true }).click();
  await page.getByRole('heading', { name: '此相册还没有图片' }).waitFor();
  assert.equal(images.find((item) => item.id === 'three').album_id, null);
  console.log('PASS cover/count, empty-album import across pages and removal preserves image/link');

  await page.locator('input[type=file]').first().setInputFiles([file('first'), file('remove')]);
  await page.getByRole('button', { name: '打开上传任务中心' }).waitFor();
  await page.locator('input[type=file]').first().setInputFiles(file('later'));
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  const sheet = page.getByRole('dialog');
  assert.equal(await sheet.locator('li').count(), 3);
  await sheet.getByRole('button', { name: '移除待上传 remove.png' }).click();
  await sheet.getByRole('button', { name: '暂停后续（1）' }).click();
  await release();
  await sheet.getByRole('button', { name: '重试未完成（1）' }).waitFor();
  assert.equal(uploads.length, 1);
  assert(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }));
  await page.keyboard.press('Escape');

  // Leave guard via logout AlertDialog
  await page.getByRole('button', { name: '账号菜单' }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '继续留在工作台' }).click();
  assert.equal(new URL(page.url()).pathname, '/app');

  await page.getByRole('link', { name: '相册', exact: true }).click();
  await page.goto('http://piccove.test/app');
  await page.locator('input[type=file]').first().setInputFiles(file('failed'));
  await release(500);
  await page.locator('input[type=file]').first().setInputFiles(file('next'));
  await release();
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  assert.equal(await sheet.locator('li').count(), 4);
  await sheet.getByRole('button', { name: '重试未完成（2）' }).click();
  await release();
  await release();
  await sheet.getByText('成功 4').waitFor();
  assert.deepEqual(uploads.map((item) => item.name), ['first.png', 'failed.png', 'next.png', 'later.png', 'failed.png']);
  assert.equal(uploads.find((item) => item.name === 'later.png').album, albumId);
  assert.equal(uploads.at(-1).album, null);
  assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), false);

  await sheet.getByRole('button', { name: '复制本次链接' }).click();
  const linksDlg = page.getByRole('dialog').filter({ hasText: '复制图片外链' });
  await linksDlg.getByRole('textbox').waitFor();
  await linksDlg.getByRole('button', { name: '复制全部链接' }).click();
  assert.equal((await page.evaluate(() => window.copiedText)).split('\n').length, 4);
  await page.keyboard.press('Escape');
  await sheet.getByRole('button', { name: '清空记录' }).click();
  await page.keyboard.press('Escape');
  console.log('PASS upload append, pending removal, stop/resume, failed-item retention, original destinations and leave guard');

  await page.getByRole('checkbox', { name: '选择本页' }).click();
  await page.getByRole('button', { name: '复制外链', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').waitFor();
  const pasteFiles = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['fixture'], 'pasted.png', { type: 'image/png' }));
    return data;
  });
  const beforePaste = uploads.length;
  await page.getByRole('dialog').getByRole('textbox').dispatchEvent('paste', { clipboardData: pasteFiles });
  assert.equal(uploads.length, beforePaste);
  await page.keyboard.press('Escape');
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  const pasted = await page.evaluate((data) => {
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, pasteFiles);
  assert(pasted, 'Page-level paste must be handled');
  await release();
  await page.getByText('图片上传完成', { exact: true }).waitFor();
  assert.equal(uploads.at(-1).name, 'pasted.png');
  assert.equal(uploads.length, beforePaste + 1);
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  await sheet.getByRole('button', { name: '清空记录' }).click();
  await page.keyboard.press('Escape');
  console.log('PASS page-level image paste without stealing input/dialog paste');

  images.splice(0, images.length, picture('blocked', { moderation_status: 'blocked' }), picture('held', { moderation_status: 'pending', moderation_hold: true }));
  await page.reload();
  await page.getByRole('checkbox', { name: '选择本页' }).click();
  await page.getByRole('button', { name: '复制外链', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('textbox').inputValue(), '');
  assert(await page.getByRole('dialog').getByRole('button', { name: '复制全部链接' }).isDisabled());
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多操作 blocked.png' }).click();
  assert.equal(await page.getByRole('menuitem', { name: '二维码分享' }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow();
    const target = await page.getByRole('checkbox', { name: '选择 blocked.png' }).boundingBox();
    assert(target.width >= 44 && target.height >= 44);
    await page.screenshot({ path: `${dir}/gallery-workflow-${width}.png`, fullPage: true });
  }
  console.log('PASS restricted-link and QR guards, desktop/mobile layout and 44x44 selection targets');

  failSettings = true;
  await page.goto('http://piccove.test/login');
  await page.getByRole('tab', { name: '密码登录' }).click();
  await page.getByLabel('密码', { exact: true }).fill('password12345');
  assert(await page.getByRole('button', { name: '登录工作台', exact: true }).isVisible());
  await page.goto('http://piccove.test/register');
  await page.getByRole('alert').filter({ hasText: '无法获取注册配置' }).waitFor();
  assert.equal(await page.locator('form').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS settings failure preserves login while registration remains guarded');
} finally {
  await browser.close();
  console.log('Workflow browser closed; no listener was started.');
}
