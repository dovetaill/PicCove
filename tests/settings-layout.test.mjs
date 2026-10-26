// Offline production-build fixture; all HTTP requests are intercepted.
// PICCOVE_UI_FIXTURE contains admin/dist and browser/chrome-linux64.
// PICCOVE_PLAYWRIGHT points to an existing Playwright module. No server or real API is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(dir?.startsWith('/'));
const { chromium } = await import(pathToFileURL(process.env.PICCOVE_PLAYWRIGHT));
const browser = await chromium.launch({
  executablePath: `${dir}/browser/chrome-linux64/chrome`,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  const longPath = '/storage/' + 'very-long-folder-name/'.repeat(8);
  let manager = null;
  let failModels = false;
  let aiConfig = { generation_mode: 'images', generation: { base_url: 'https://provider.test/v1', key: '', model: '' }, image_model: '', moderation: { base_url: '', key: '', model: '' }, moderation_enabled: false, before_publish: false, daily_limit: 20, concurrent_limit: 1, ban_threshold: 5, generation_key_set: true };
  let albums = [{ id: 'a', name: '旅行', description: '旅途中的照片' }];
  let reviews = [];
  let conversations = [];
  let messages = [];
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'piccove.test') return route.abort();
    const path = u.pathname;
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path.startsWith('/api/v1')) {
      const api = path.slice(7);
      const method = route.request().method();
      calls.push([method, api, route.request().postDataJSON()]);
      if (api.endsWith('/thumbnail')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#d8e8dc"/></svg>' });
      if (api === '/me') return json({ user: { id: 'u', username: 'admin', is_admin: true, quota_bytes: 1073741824 }, used_bytes: 0 });
      if (api === '/admin/ai') {
        if (method === 'PATCH') aiConfig = { ...aiConfig, ...route.request().postDataJSON() };
        return json(aiConfig);
      }
      if (api === '/admin/ai/models') return failModels ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '上游不支持模型列表' }) }) : json(['image-test', 'chat-test']);
      if (api === '/albums') {
        if (method === 'POST') albums.push({ id: 'new', ...route.request().postDataJSON() });
        return json(albums);
      }
      if (api === '/albums/a' && method === 'PATCH') { albums[0] = { ...albums[0], ...route.request().postDataJSON() }; return json({}); }
      if (api === '/admin/reviews') return json({ items: reviews, has_more: false });
      if (api === '/ai/status') return json({ enabled: true, unlimited: true, used: 0, daily_limit: 20 });
      if (api === '/ai/conversations') {
        if (method === 'POST') { conversations = [{ id: 'c', title: '测试图片' }]; return json({ id: 'c' }); }
        return json({ items: conversations, has_more: false });
      }
      if (api === '/ai/conversations/c') {
        if (method === 'POST') { messages = [{ id: 'm', prompt: route.request().postDataJSON().prompt, text: '已生成', status: 'completed' }]; return json({}); }
        return json(messages);
      }
      if (api === '/settings') return json({ registration_open: false });
      if (api === '/admin/system') return json({ version: '0.1.9', manager, manager_error: manager ? null : 'offline' });
      if (api === '/admin/system/check') return json({ latest: '0.1.10', update_available: true, url: 'https://example.com/release' });
      if (api === '/storage-locations' && method === 'GET') return json({ allowed_roots: ['/storage'], items: [
        { id: 'one', path: '/storage/pictures', default: true, count: 42, used_bytes: 1234567, available_bytes: 987654321, error: null },
        { id: 'two', path: longPath, default: false, count: 0, used_bytes: 0, available_bytes: null, error: null },
      ] });
      if (api === '/file-jobs') return json([{ id: 'j', kind: 'migration', status: 'completed', completed: 42, total: 42, failed: 0 }]);
      if (api === '/admin/users') return json({ items: [{ user: { id: 'u', username: 'admin' } }], has_more: false });
      if (api === '/import-candidates') return json({ enabled: true, items: [{ key: longPath + 'photo.png', size: 123, signature: 'test' }] });
      if (api === '/import-albums/u') return json([]);
      if (api === '/storage-locations' && method === 'POST') return json({});
      if (api === '/file-jobs/migrate' && method === 'POST') return json({});
      throw Error(`Unexpected API: ${method} ${api}`);
    }
    if (path.endsWith('/thumbnail')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#d8e8dc"/></svg>' });
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`${dir}/admin/dist/${file}`) });
  });
  await page.goto('http://piccove.test/app/admin/settings');
  await page.getByRole('button', { name: '保存 AI 设置' }).waitFor();
  assert.equal(await page.locator('.cove-settings-card:visible').count(), 1);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const screenshot = async (options) => {
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => scrollY === 0);
    await page.screenshot({ ...options, style: '[data-sonner-toaster] { visibility: hidden; }' });
  };
  assert(await noOverflow());
  await page.getByRole('button', { name: '收起导航' }).click();
  await page.mouse.move(900, 100);
  await page.waitForFunction(() => Math.round(document.querySelector('.cove-sidebar').getBoundingClientRect().width) === 80);
  assert(await page.getByRole('link', { name: '系统设置', exact: true }).isVisible());
  assert.equal(await page.locator('.cove-sidebar nav a svg').count(), 8);
  await page.locator('.cove-sidebar').hover();
  await page.waitForFunction(() => Math.round(document.querySelector('.cove-sidebar').getBoundingClientRect().width) === 280);
  await page.mouse.move(900, 100);
  await page.getByRole('link', { name: '系统设置', exact: true }).focus();
  await page.waitForFunction(() => Math.round(document.querySelector('.cove-sidebar').getBoundingClientRect().width) === 280);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => Math.round(document.querySelector('.cove-sidebar').getBoundingClientRect().width) === 80);
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '图片迁移' }).click();
  assert(new URL(page.url()).hash === '#settings-migration');
  assert(await page.getByRole('button', { name: '开始迁移' }).isDisabled());
  for (const name of ['原存储位置', '目标存储位置']) {
    await page.getByRole('combobox', { name }).click();
    await page.getByRole('option', { name: '/storage/pictures', exact: true }).click();
  }
  assert(await page.getByRole('button', { name: '开始迁移' }).isDisabled());
  await page.getByRole('combobox', { name: '目标存储位置' }).click();
  await page.getByRole('option', { name: longPath, exact: true }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: '开始迁移' }).click();
  assert(!calls.some(([m, p]) => m === 'POST' && p === '/file-jobs/migrate'));
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '存储位置', exact: true }).click();
  await page.getByLabel('添加存储位置', { exact: true }).fill('/storage/new');
  await page.getByRole('button', { name: '添加位置', exact: true }).click();
  await page.getByText('存储位置已添加', { exact: true }).waitFor();
  assert(calls.some(([m, p, body]) => m === 'POST' && p === '/storage-locations' && body.path === '/storage/new'));
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '版本与服务' }).click();
  assert(await page.getByRole('button', { name: '重启服务', exact: true }).isDisabled());
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('有新版本可用', { exact: false }).waitFor();
  assert(await page.getByRole('button', { name: '升级并重启', exact: true }).isDisabled());
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => scrollY === 0);
  await screenshot({ path: `${dir}/settings-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await noOverflow());
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: '系统设置', exact: true }).click();
  assert.equal(await page.locator('.cove-sidebar').isVisible(), false);
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '批量导入' }).click();
  await page.getByRole('button', { name: '扫描待导入图片' }).click();
  await page.getByText(longPath + 'photo.png', { exact: true }).waitFor();
  assert(await noOverflow());
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => scrollY === 0);
  await screenshot({ path: `${dir}/settings-mobile.png`, fullPage: true });
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '版本与服务' }).click();
  manager = { state: 'idle' };
  await page.reload();
  await page.getByText('已连接', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重启服务', exact: true }).isDisabled(), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const choose = (name) => page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name, exact: true }).click();
  await choose('AI 生图与审核');
  assert.equal(await page.getByLabel('对话模型', { exact: true }).count(), 0);
  const generation = page.getByRole('group', { name: '图片生成', exact: true });
  await generation.getByRole('button', { name: '拉取 / 刷新模型' }).click();
  await page.getByText('已获取 2 个模型，输入可搜索或手动填写').waitFor();
  assert.equal(await page.locator('#generation-models option').count(), 2);
  assert.equal(calls.find(([m, p]) => p === '/admin/ai/models')[2].key, '');
  await page.getByLabel('图片模型', { exact: true }).fill('image-test');
  await page.getByRole('button', { name: '保存 AI 设置' }).click();
  await page.getByText('AI 设置已保存', { exact: true }).waitFor();
  assert(calls.some(([m, p, body]) => m === 'PATCH' && p === '/admin/ai' && body.generation_mode === 'images' && body.generation.model === '' && body.image_model === 'image-test'));
  failModels = true;
  await generation.getByRole('button', { name: '拉取 / 刷新模型' }).click();
  await page.getByText('上游不支持模型列表。可以手动填写模型 ID。').waitFor();
  await page.getByLabel('图片模型', { exact: true }).fill('custom-image');
  await page.getByRole('combobox', { name: '生图方式' }).click();
  await page.getByRole('option', { name: '对话调用生图工具（兼容原配置）' }).click();
  await page.getByLabel('对话模型', { exact: true }).fill('chat-test');
  await page.getByRole('button', { name: '保存 AI 设置' }).click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled === false);
  assert(calls.some(([m, p, body]) => m === 'PATCH' && p === '/admin/ai' && body.generation_mode === 'responses' && body.generation.model === 'chat-test'));
  await page.getByRole('combobox', { name: '生图方式' }).click();
  await page.getByRole('option', { name: '独立生图（仅需图片模型）' }).click();
  await page.getByLabel('开启新增图片审核').check();
  const before = calls.filter(([m, p]) => m === 'PATCH' && p === '/admin/ai').length;
  await page.getByRole('button', { name: '保存 AI 设置' }).click();
  assert.equal(calls.filter(([m, p]) => m === 'PATCH' && p === '/admin/ai').length, before);
  await page.getByLabel('开启新增图片审核').uncheck();
  await page.getByRole('button', { name: '保存 AI 设置' }).click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled === false);
  assert.equal(calls.filter(([m, p]) => m === 'PATCH' && p === '/admin/ai').length, before + 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await noOverflow());
    for (const label of await page.locator('.cove-ai-config .cove-check').all()) {
      assert(await label.evaluate((el) => {
        const input = el.querySelector('input').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(el.lastChild);
        const text = range.getBoundingClientRect();
        return input.right <= text.left && input.top < text.bottom && text.top < input.bottom;
      }), 'Checkbox and label must share a line');
    }
    await screenshot({ path: `${dir}/ai-settings-${width}.png`, fullPage: true });
  }
  await page.goto('http://piccove.test/app/albums');
  await page.getByRole('link', { name: '旅行', exact: true }).waitFor();
  assert.equal(await page.locator('form').count(), 0);
  await page.getByRole('button', { name: '创建相册', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('新相册');
  await dialog.getByLabel('描述', { exact: true }).fill('示例描述');
  await dialog.getByRole('button', { name: '创建相册', exact: true }).click();
  await page.getByRole('link', { name: '新相册', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑相册 旅行', exact: true }).click();
  await dialog.getByLabel('名称', { exact: true }).fill('旅行照片');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('link', { name: '旅行照片', exact: true }).waitFor();
  assert(await noOverflow());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot({ path: `${dir}/albums.png`, fullPage: true });
  await page.goto('http://piccove.test/app/admin/reviews');
  await page.getByRole('heading', { name: '暂无审核记录' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).count(), 0);
  reviews = [{ id: 'r', username: 'tester', status: 'review', reason: '需要确认的图片', categories: [], counted: false, attempts: 1, image_id: 'image' }];
  await page.reload();
  await page.getByText('需要确认的图片', { exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await noOverflow());
    await screenshot({ path: `${dir}/reviews-${width}.png`, fullPage: true });
  }
  await page.goto('http://piccove.test/app/ai');
  await page.getByRole('heading', { name: '从一个画面开始' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '上页', exact: true }).count(), 0);
  await page.getByLabel('描述图片或修改要求').fill('测试图片');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await page.locator('.cove-chat-messages').getByText('已生成', { exact: false }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await noOverflow());
    const messagesBox = await page.locator('.cove-chat-messages').boundingBox();
    const composer = await page.locator('.cove-chat-composer').boundingBox();
    assert(messagesBox.y + messagesBox.height <= composer.y + 1);
    await screenshot({ path: `${dir}/chat-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS settings categories, model discovery/fallback, independent/Responses forms, checkbox alignment, album dialogs, review empty/list and chat layout; desktop/mobile; storage and migration guards');
} finally {
  await browser.close();
}
