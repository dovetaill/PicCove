// Offline fixture only, using the same bundled app/base CSS contract as gallery-usability.test.mjs.
// PICCOVE_UI_FIXTURE must contain app.js, base.css, style.css and chrome/chrome.
// PICCOVE_PLAYWRIGHT points to an existing Playwright module. No server or real API is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(dir?.startsWith('/'));
const { chromium } = await import(pathToFileURL(process.env.PICCOVE_PLAYWRIGHT));
const browser = await chromium.launch({
  executablePath: `${dir}/chrome/chrome`,
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
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'piccove.test') return route.abort();
    const path = u.pathname;
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path.startsWith('/api/v1')) {
      const api = path.slice(7);
      const method = route.request().method();
      calls.push([method, api, route.request().postDataJSON()]);
      if (api === '/me') return json({ user: { id: 'u', username: 'admin', is_admin: true, quota_bytes: 1073741824 }, used_bytes: 0 });
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
    const file = path === '/app.js' ? 'app.js' : path === '/base.css' ? 'base.css' : path === '/style.css' ? 'style.css' : null;
    return route.fulfill({ contentType: file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html', body: file ? await readFile(`${dir}/${file}`) : '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>' });
  });
  await page.goto('http://piccove.test/app/admin/settings');
  await page.getByText('/storage/pictures', { exact: true }).waitFor();
  assert.equal(await page.locator('.cove-settings-card').count(), 6);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert(await noOverflow());
  await page.getByRole('button', { name: '收起导航' }).click();
  await page.mouse.move(900, 100);
  await page.waitForFunction(() => Math.round(document.querySelector('.cove-sidebar').getBoundingClientRect().width) === 80);
  assert(await page.getByRole('link', { name: '系统设置', exact: true }).isVisible());
  assert.equal(await page.locator('.cove-sidebar nav a svg').count(), 6);
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
  await page.getByLabel('添加存储位置', { exact: true }).fill('/storage/new');
  await page.getByRole('button', { name: '添加位置', exact: true }).click();
  await page.waitForFunction(() => window.__toasts?.includes('存储位置已添加'));
  assert(calls.some(([m, p, body]) => m === 'POST' && p === '/storage-locations' && body.path === '/storage/new'));
  assert(await page.getByRole('button', { name: '重启服务', exact: true }).isDisabled());
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('有新版本可用', { exact: false }).waitFor();
  assert(await page.getByRole('button', { name: '升级并重启', exact: true }).isDisabled());
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: `${dir}/settings-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await noOverflow());
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: '系统设置', exact: true }).click();
  assert.equal(await page.locator('.cove-sidebar').isVisible(), false);
  await page.getByRole('button', { name: '扫描待导入图片' }).click();
  await page.getByText(longPath + 'photo.png', { exact: true }).waitFor();
  assert(await noOverflow());
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: `${dir}/settings-mobile.png`, fullPage: true });
  manager = { state: 'idle' };
  await page.reload();
  await page.getByText('已连接', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重启服务', exact: true }).isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log('PASS sidebar collapse/hover/keyboard/mobile; settings layout and long paths; storage submission, migration guard and service availability');
} finally {
  await browser.close();
}
