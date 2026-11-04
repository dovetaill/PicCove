// Offline production build: PICCOVE_UI_FIXTURE has admin/dist and browser/chrome-linux64.
// PICCOVE_PLAYWRIGHT points to an existing module. Run non-root with task-owned TMPDIR.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(dir?.startsWith('/'));
const { chromium } = await import(pathToFileURL(process.env.PICCOVE_PLAYWRIGHT));
const browser = await chromium.launch({
  executablePath: `${dir}/browser/chrome-linux64/chrome`,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text) => {
      if (window.denyClipboard) throw Error('Clipboard denied');
      window.copiedText = text;
    } },
  }));
  const picture = (id, extra = {}) => ({ id, user_id: 'u', original_name: `${id}.png`, url: `http://piccove.test/i/${id}`, thumbnail_url: `http://piccove.test/i/${id}`, is_public: true, size_bytes: 100, width: 10, height: 10, ...extra });
  const images = [picture('a'), picture('b'), picture('private', { is_public: false }), picture('deleted', { deleted_at: '2026-01-01' })];
  let uploadIndex = 0;
  let sent = [];
  let messages = [];
  let enabled = true;
  let failMessage = false;
  let resultStatus = 'completed';
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'piccove.test') return route.abort();
    const path = u.pathname;
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.startsWith('/api/v1')) {
      const api = path.slice(7);
      if (api === '/me') return json({ user: { id: 'u', username: 'tester', is_admin: true, quota_bytes: 100000 }, used_bytes: 100 });
      if (api === '/settings') return json({ registration_open: false });
      if (api === '/albums') return json([]);
      if (api === '/images' && method === 'GET') return json({ items: images, has_more: false });
      if (api === '/images' && method === 'POST') {
        if (u.searchParams.has('private')) return json(picture('reference', { is_public: false }));
        const results = [picture('first'), picture('private', { is_public: false, duplicate: true }), null, picture('last')];
        const result = results[uploadIndex++];
        return json(result || { error: '模拟失败' }, result ? 200 : 400);
      }
      if (api === '/ai/status') return json({ enabled, unlimited: true, used: 0, daily_limit: 20 });
      if (api === '/ai/conversations') return method === 'POST' ? json({ id: 'chat' }) : json({ items: sent.length ? [{ id: 'chat', title: sent[0].prompt }] : [], has_more: false });
      if (api === '/ai/conversations/chat') {
        if (method === 'POST') {
          if (failMessage) return json({ error: '模拟生成失败，请重试' }, 503);
          const body = route.request().postDataJSON();
          sent.push(body);
          messages.push({ id: String(sent.length), ...body, text: resultStatus === 'completed' ? '已生成图片' : null, image_id: resultStatus === 'completed' ? 'generated' : null, status: resultStatus });
          return json({});
        }
        return json(messages);
      }
      throw Error(`Unexpected API ${method} ${api}`);
    }
    if (path.startsWith('/i/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#e7eeeb"/></svg>' });
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`${dir}/admin/dist/${file}`) });
  });
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const file = (name) => ({ name: `${name}.png`, mimeType: 'image/png', buffer: Buffer.from('fixture') });
  await page.goto('http://piccove.test/app');
  await page.getByRole('checkbox', { name: '选择本页' }).check();
  const batch = page.locator('.cove-batch-links').last();
  const direct = [images[0].url, images[1].url].join('\n');
  assert.equal(await batch.getByRole('textbox').inputValue(), direct);
  await batch.getByText('已跳过 2 张私有或待清理图片，公开状态保持不变。').waitFor();
  await batch.getByRole('button', { name: '复制全部链接' }).click();
  assert.equal(await page.evaluate(() => window.copiedText), direct);
  await batch.getByRole('combobox').click();
  await page.getByRole('option', { name: 'HTML 外链', exact: true }).click();
  assert.equal(await batch.getByRole('textbox').inputValue(), '<img src="http://piccove.test/i/a" alt="a.png" />\n<img src="http://piccove.test/i/b" alt="b.png" />');
  await batch.getByRole('button', { name: '复制全部链接' }).click();
  assert.equal(await page.evaluate(() => window.copiedText), await batch.getByRole('textbox').inputValue());
  for (const [label, expected] of [
    ['BBCode 外链', '[img]http://piccove.test/i/a[/img]\n[img]http://piccove.test/i/b[/img]'],
    ['Markdown 缩略图链接', '[![a.png](http://piccove.test/i/a)](http://piccove.test/i/a)\n[![b.png](http://piccove.test/i/b)](http://piccove.test/i/b)'],
    ['HTML 缩略图链接', '<a href="http://piccove.test/i/a"><img src="http://piccove.test/i/a" alt="a.png" /></a>\n<a href="http://piccove.test/i/b"><img src="http://piccove.test/i/b" alt="b.png" /></a>'],
  ]) {
    await batch.getByRole('combobox').click();
    await page.getByRole('option', { name: label, exact: true }).click();
    assert.equal(await batch.getByRole('textbox').inputValue(), expected);
  }
  await page.evaluate(() => { window.denyClipboard = true; });
  await batch.getByRole('button', { name: '复制全部链接' }).click();
  await page.getByText('未能复制到剪贴板，你可以选中文字手动复制', { exact: true }).waitFor();
  await batch.getByRole('textbox').focus();
  assert(await batch.getByRole('textbox').evaluate((el) => el.readOnly && el.selectionStart === 0 && el.selectionEnd === el.value.length));
  await page.evaluate(() => { window.denyClipboard = false; });
  for (const name of ['a.png', 'b.png']) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).uncheck();
  assert.equal(await batch.getByRole('textbox').inputValue(), '');
  assert(await batch.getByRole('button', { name: '复制全部链接' }).isDisabled());
  for (const name of ['private.png', 'deleted.png']) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '选择 a.png', exact: true }).check();
  await page.getByRole('button', { name: '查看 / 复制外链', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByRole('textbox').count(), 6);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: '选择 a.png', exact: true }).uncheck();
  assert.equal(await page.locator('.cove-batch-links').count(), 0);
  await page.locator('input[type=file]').first().setInputFiles(['first', 'private', 'failed', 'last'].map(file));
  const uploaded = page.getByRole('region', { name: '上传队列' });
  await uploaded.getByRole('heading', { name: '上传结果' }).waitFor();
  assert.equal(await uploaded.getByRole('textbox', { name: '批量图片链接' }).inputValue(), 'http://piccove.test/i/first\nhttp://piccove.test/i/last');
  await uploaded.getByRole('button', { name: '复制全部链接' }).click();
  assert.equal(await page.evaluate(() => window.copiedText), 'http://piccove.test/i/first\nhttp://piccove.test/i/last');
  await uploaded.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Markdown 外链', exact: true }).click();
  assert.equal(await uploaded.getByRole('textbox').inputValue(), '![first.png](http://piccove.test/i/first)\n![last.png](http://piccove.test/i/last)');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: `${dir}/batch-mobile.png`, fullPage: true });
  console.log('PASS selected/uploaded batch URLs, HTML/Markdown, clipboard, partial failure, private/deleted guards');

  await page.goto('http://piccove.test/app/ai');
  await page.getByRole('heading', { name: '今天想创作什么？' }).waitFor();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow();
    const heading = await page.locator('.cove-chat-heading').boundingBox();
    const header = await page.locator('.cove-workheader').boundingBox();
    assert(heading.y >= header.y + header.height);
    const composer = await page.locator('.cove-chat-composer').boundingBox();
    assert(composer.y + composer.height < 900);
    await page.screenshot({ path: `${dir}/chat-empty-${width}.png` });
  }
  const prompt = page.getByRole('textbox', { name: '描述图片或修改要求' });
  await prompt.fill('   ');
  await prompt.press('Enter');
  assert.equal(sent.length, 0);
  await prompt.fill('海边的白色小屋');
  await prompt.press('Shift+Enter');
  assert.equal(sent.length, 0);
  await prompt.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(sent.length, 0);
  assert.equal(await prompt.evaluate((el) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }), false, 'IME confirmation must not be intercepted as send');
  await page.getByLabel('参考图片', { exact: true }).setInputFiles(file('reference'));
  await page.locator('.cove-chat-reference').waitFor();
  failMessage = true;
  await prompt.press('Enter');
  await page.getByText('模拟生成失败，请重试', { exact: true }).waitFor();
  assert.equal(sent.length, 0);
  assert.equal((await prompt.inputValue()).trim(), '海边的白色小屋');
  assert.equal(await page.locator('.cove-chat-reference').count(), 1);
  failMessage = false;
  await prompt.press('Enter');
  await page.getByText('已生成图片', { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reference_id, 'reference');
  assert.equal(await prompt.inputValue(), '');
  assert.equal(await page.locator('.cove-chat-reference').count(), 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow();
    await page.screenshot({ path: `${dir}/chat-message-${width}.png` });
  }
  resultStatus = 'running';
  await prompt.fill('继续修改屋顶');
  await prompt.press('Enter');
  await page.locator('.cove-chat-progress').waitFor();
  await prompt.fill('生成期间不能重复发送');
  await prompt.press('Enter');
  assert.equal(sent.length, 2);
  assert(await page.getByRole('button', { name: '正在生成…', exact: true }).isDisabled());
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('heading', { name: '今天想创作什么？' }).waitFor();
  assert.equal(await page.locator('.cove-chat-history').isVisible(), false);
  enabled = false;
  await page.reload();
  await page.getByText('尚未配置生图服务。', { exact: false }).waitFor();
  await prompt.fill('不能发送');
  await prompt.press('Enter');
  assert.equal(sent.length, 2);
  assert.deepEqual(errors, []);
  console.log('PASS desktop/mobile chat geometry, new chat/history, reference upload, Enter/IME guards, disabled provider');
} finally {
  await browser.close();
}
