// Offline production-build Chromium interaction checks. Never point this at a deployed application.
// PICCOVE_UI_FIXTURE contains admin/dist and browser/chrome-linux64 (or chrome/chrome).
// PICCOVE_PLAYWRIGHT points to an existing Playwright module. Every API is mocked.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(
  dir && dir.startsWith('/'),
  'PICCOVE_UI_FIXTURE must be an absolute disposable fixture directory',
);
const playwrightEntry =
  process.env.PICCOVE_PLAYWRIGHT || `${dir}/node_modules/playwright/index.mjs`;
const { chromium } = await import(pathToFileURL(playwrightEntry));
const chromeBin = await access(`${dir}/browser/chrome-linux64/chrome`).then(
  () => `${dir}/browser/chrome-linux64/chrome`,
  () => `${dir}/chrome/chrome`,
);

let browser;
try {
  browser = await chromium.launch({
    executablePath: chromeBin,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, HOME: dir, TMPDIR: dir },
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.copiedText = text;
        },
      },
    }),
  );
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('PAGEERROR', e.message);
  });

  const pic = (id, extra = {}) => ({
    id,
    user_id: 'u',
    album_id: null,
    original_name: `${id}.png`,
    size_bytes: 30,
    width: 10,
    height: 10,
    url: `http://piccove.test/i/${id}`,
    thumbnail_url:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    deleted_at: null,
    is_public: true,
    moderation_status: 'passed',
    moderation_hold: false,
    ...extra,
  });

  let images = [pic('a'), pic('b'), pic('dead', { deleted_at: '2026-01-01' })];
  const holds = [];
  let resultImage = pic('a', { duplicate: true });
  let starts = 0;
  let enabled = false;
  const calls = [];
  let deleteFail = false;
  let uploadStatus = 200;
  const uploadUrls = [];
  let paged = false;
  let lastPageImage = true;
  let holdAlbums = false;
  let releaseAlbums;
  const albumId = 'abcdefab-1234-4567-890a-abcdefabcdef';
  const imageQueryAlbums = [];

  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'piccove.test') return route.abort();
    const path = u.pathname;
    if (path.startsWith('/api/v1/')) {
      const apiPath = path.slice(7);
      const method = route.request().method();
      calls.push([method, apiPath]);
      const json = (data, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      if (apiPath === '/me')
        return json({
          user: {
            id: 'u',
            username: 'tester',
            is_admin: true,
            disabled: false,
            quota_bytes: 100000,
          },
          used_bytes: 60,
        });
      if (apiPath === '/admin/overview')
        return json({
          users_total: 1,
          users_disabled: 0,
          users_banned: 0,
          images_total: images.length,
          images_public: images.filter((i) => i.is_public).length,
          used_bytes: 60,
          registration_open: false,
          reviews_pending: 0,
          jobs_active: 0,
        });
      if (apiPath === '/settings')
        return json({ registration_open: false, contact_url: null });
      if (apiPath === '/albums') {
        if (holdAlbums) {
          releaseAlbums = () => json([{ id: albumId, name: '目标相册' }]);
          return;
        }
        return json([{ id: albumId, name: '目标相册' }]);
      }
      if (apiPath === '/images' && method === 'GET') {
        if (u.searchParams.has('content_hash'))
          return json({ items: [], has_more: false });
        if (u.searchParams.has('ids'))
          return json({
            items: (paged
              ? [pic('first'), ...(lastPageImage ? [pic('last')] : [])]
              : images
            ).filter((item) =>
              u.searchParams.get('ids').split(',').includes(item.id),
            ),
            has_more: false,
          });
        imageQueryAlbums.push(u.searchParams.get('album_id'));
        return json(
          paged
            ? {
                items:
                  u.searchParams.get('page') === '2'
                    ? lastPageImage
                      ? [pic('last')]
                      : []
                    : [pic('first')],
                has_more: u.searchParams.get('page') !== '2',
              }
            : { items: images, has_more: false },
        );
      }
      if (apiPath === '/images' && method === 'POST') {
        uploadUrls.push(u.searchParams.get('album_id'));
        holds.push(() => {
          if (
            uploadStatus === 200 &&
            !images.some((item) => item.id === resultImage.id)
          ) {
            images.push(resultImage);
          }
          return json(
            uploadStatus === 200 ? resultImage : { error: '模拟上传失败' },
            uploadStatus,
          );
        });
        return;
      }
      if (apiPath === '/images/a' && method === 'PATCH') return json({});
      if (apiPath === '/images/b' && method === 'PATCH')
        return json({ error: '模拟移动失败' }, 500);
      if (apiPath.startsWith('/images/') && method === 'DELETE') {
        images = images.filter((i) => apiPath !== `/images/${i.id}`);
        if (apiPath === '/images/last') lastPageImage = false;
        return json(
          deleteFail ? { error: '模拟文件清理失败' } : {},
          deleteFail ? 500 : 200,
        );
      }
      if (apiPath === '/me/security')
        return json({
          totp_enabled: enabled,
          passkeys: [{ id: 'key', name: '设备' }],
        });
      if (apiPath === '/me/passkeys/start')
        return json({ error: '模拟取消Passkey创建' }, 400);
      if (apiPath === '/me/password') {
        assert.equal(route.request().postDataJSON().password, '中文密码abcd');
        return json({ error: '测试已收到多字节密码' }, 400);
      }
      if (apiPath === '/me/totp/start')
        return json({ secret: `SECRET${++starts}`, uri: 'otpauth://test' });
      if (apiPath === '/me/totp/confirm')
        return json({ error: '绑定已过期，请重新开始' }, 400);
      if (apiPath === '/me/passkeys/remove' || apiPath === '/me/username')
        return json({});
      throw Error(`unexpected API ${method} ${apiPath}`);
    }
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({
      contentType: file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
      body: await readFile(`${dir}/admin/dist/${file}`),
    });
  });

  await page.goto('http://piccove.test/app');
  await page.getByRole('heading', { name: '我的图片库' }).waitFor();
  await page.getByRole('button', { name: '复制 a.png 链接' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '复制 dead.png 链接' }).isDisabled(),
    true,
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log('PASS mobile action hit targets and deleted-image copy disabled');

  await page.getByRole('checkbox', { name: '选择本页' }).click();
  await page.getByRole('button', { name: '复制外链', exact: true }).click();
  await page.getByRole('dialog').getByText('已跳过 1 张私有或受限图片。').waitFor();
  assert(
    !(await page
      .getByRole('dialog')
      .getByRole('textbox')
      .inputValue()
      .then((value) => value.includes('/i/dead'))),
  );
  await page.keyboard.press('Escape');

  await page.getByRole('checkbox', { name: '选择 dead.png', exact: true }).click();
  await page.getByRole('button', { name: '移动到相册', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: '目标相册' }).click();
  await page.getByRole('option', { name: '目标相册', exact: true }).click();
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  await page.getByText(/已完成 1 张，剩余 1 张未完成/).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(
    await page.getByRole('checkbox', { name: '选择 a.png', exact: true }).getAttribute('aria-checked'),
    'false',
  );
  assert.equal(
    await page.getByRole('checkbox', { name: '选择 b.png', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await page.getByRole('checkbox', { name: '选择 b.png', exact: true }).click();
  console.log('PASS partial batch move selection and feedback');

  const file = {
    name: 'duplicate.png',
    mimeType: 'image/png',
    buffer: Buffer.from('test'),
  };
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles([file, { ...file, name: 'second.png' }]);

  await page.getByRole('button', { name: '打开上传任务中心' }).waitFor();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog').getByRole('link', { name: '账号与安全', exact: true }).click();
  await page.getByRole('heading', { name: '账号与安全' }).waitFor();
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByText('上传任务中心').waitFor();
  assert.equal(await sheet.locator('li').count(), 2);
  assert.equal(
    await sheet.getByRole('progressbar', { name: '当前图片传输进度' }).isVisible(),
    true,
  );
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog').getByRole('link', { name: '图片库', exact: true }).click();
  await page.getByRole('heading', { name: '我的图片库' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '追加图片', exact: true }).isDisabled(),
    false,
  );
  console.log('PASS in-app navigation preserves in-flight queue and allows appending');

  await page
    .locator('[aria-label="图片上传区域，支持拖放或直接粘贴"]')
    .dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(['extra'], 'extra.png', { type: 'image/png' }));
        return d;
      }),
    });
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  assert.equal(await sheet.locator('li').count(), 3);
  await sheet.getByRole('button', { name: '移除待上传 extra.png', exact: true }).click();
  assert.equal(await sheet.locator('li').count(), 2);

  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, 'upload request must arrive');
  await holds.shift()();
  await sheet.getByRole('button', { name: '复制上传结果 duplicate.png', exact: true }).click();
  await page.getByText('直链已复制', { exact: true }).waitFor();
  await sheet.getByRole('button', { name: '复制本次链接', exact: true }).click();
  await page.getByRole('textbox', { name: '批量图片链接' }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  console.log('PASS append/remove waiting item and duplicate links before batch completes');

  resultImage = pic('a');
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, 'upload request must arrive');
  await holds.shift()();
  await page.getByText('图片上传完成', { exact: true }).waitFor();

  deleteFail = true;
  await page.getByRole('button', { name: '更多操作 a.png', exact: true }).click();
  await page.getByRole('menuitem', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除' }).click();
  await page.getByText('模拟文件清理失败', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '打开上传任务中心' }).count(), 0);
  await page.keyboard.press('Escape');
  console.log('PASS failed delete removes all duplicate upload result links');

  resultImage = pic('private', { is_public: false });
  images.push(resultImage);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ ...file, name: 'private.png' });
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, 'upload request must arrive');
  await holds.shift()();

  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  await sheet.getByRole('button', { name: '复制上传结果 private.png', exact: true }).click();
  const privateLinks = page.getByRole('dialog').filter({ hasText: '复制图片外链' });
  assert.equal(await privateLinks.getByRole('textbox').inputValue(), '');
  assert(await privateLinks.getByRole('button', { name: '复制全部链接' }).isDisabled());
  await privateLinks.getByText(/这是私有图片/).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  deleteFail = false;
  await page.getByRole('button', { name: '更多操作 private.png', exact: true }).click();
  await page.getByRole('menuitem', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除' }).click();
  await page.getByText('图片已永久删除', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '打开上传任务中心' }).count(), 0);
  console.log('PASS private upload view/copy restriction and successful delete queue cleanup');

  // Failed uploads retain the album selected for their original submission.
  await page.getByRole('combobox', { name: '上传到相册' }).click();
  await page.getByRole('option', { name: '目标相册', exact: true }).click();
  uploadStatus = 500;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ ...file, name: 'retry.png' });
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();

  await page.getByRole('combobox', { name: '上传到相册' }).click();
  await page.getByRole('option', { name: '不放入相册', exact: true }).click();
  uploadStatus = 200;
  resultImage = pic('retry');
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  await sheet.getByRole('button', { name: '重试未完成（1）' }).click();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  assert.equal(uploadUrls.at(-1), albumId);
  await holds.shift()();
  await sheet.getByRole('button', { name: '复制上传结果 retry.png', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS failed upload retry retains original album after filter changes');

  // Rate limits pause remaining files and enforce cooldown.
  await page.clock.install();
  uploadStatus = 429;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles([
      { ...file, name: 'limited.png' },
      { ...file, name: 'waiting.png' },
    ]);
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();
  await page.getByRole('button', { name: '打开上传任务中心' }).click();
  assert.equal(holds.length, 0);
  assert.equal(
    await sheet.getByRole('button', { name: '请稍候重试' }).isDisabled(),
    true,
  );
  const uploadsBefore = uploadUrls.length;
  await page.clock.fastForward(59_000);
  assert.equal(uploadUrls.length, uploadsBefore);
  assert.equal(
    await sheet.getByRole('button', { name: '请稍候重试' }).isDisabled(),
    true,
  );
  await page.clock.fastForward(1_100);
  uploadStatus = 200;
  resultImage = pic('limited');
  await sheet.getByRole('button', { name: '重试未完成（2）' }).click();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  resultImage = pic('waiting');
  await holds.shift()();
  await sheet.getByRole('button', { name: '复制上传结果 waiting.png', exact: true }).waitFor();
  assert.equal(uploadUrls.length, uploadsBefore + 2);
  await sheet.getByRole('button', { name: '清空记录' }).click();
  await page.keyboard.press('Escape');
  console.log('PASS 429 pauses remaining files, enforces cooldown and retries both');

  // A short landscape viewport must keep the complete QR dialog usable.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('button', { name: '更多操作 b.png', exact: true }).click();
  await page.getByRole('menuitem', { name: '二维码分享', exact: true }).click();
  const qr = page.getByRole('dialog');
  await qr.waitFor();
  const qrBox = await qr.boundingBox();
  assert(qrBox.y >= 0 && qrBox.y + qrBox.height <= 390);
  await qr.getByRole('button', { name: '下载 SVG' }).scrollIntoViewIfNeeded();
  await qr.getByRole('button', { name: '下载 SVG' }).click({ trial: true });
  await qr.getByRole('button', { name: 'Close', exact: true }).scrollIntoViewIfNeeded();
  await qr.getByRole('button', { name: 'Close', exact: true }).click();
  await qr.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log('PASS landscape QR dialog scrolls and close button remains reachable');

  // Deleting the only image on page two returns to the previous nonempty page.
  paged = true;
  await page.reload();
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByRole('button', { name: '更多操作 last.png', exact: true }).click();
  await page.getByRole('menuitem', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除' }).click();
  await page.getByRole('button', { name: '复制 first.png 链接' }).waitFor();
  await page.getByText('第 1', { exact: false }).waitFor();
  console.log('PASS empty final page after deletion automatically returns to previous page');

  holdAlbums = true;
  const albumRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/v1/albums'),
  );
  await page.goto(
    'http://piccove.test/app?album=00000000-0000-0000-0000-000000000001',
  );
  await albumRequest;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ ...file, name: 'loading-album.png' });
  await page.getByText('正在读取相册信息，请稍候', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '打开上传任务中心' }).count(), 0);
  holdAlbums = false;
  await releaseAlbums();
  await page.getByRole('alert').filter({ hasText: '所选相册不存在或无权访问' }).waitFor();

  const uploadsBeforeMissingAlbum = uploadUrls.length;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ ...file, name: 'missing-album.png' });
  await page.getByText('目标相册不存在，请重新选择上传相册', { exact: true }).waitFor();
  assert.equal(uploadUrls.length, uploadsBeforeMissingAlbum);
  await page.getByRole('combobox', { name: '上传到相册' }).click();
  await page.getByRole('option', { name: '不放入相册', exact: true }).click();
  assert.equal(
    new URL(page.url()).searchParams.get('album'),
    '00000000-0000-0000-0000-000000000001',
  );
  assert(
    await page
      .getByRole('combobox', { name: '上传到相册' })
      .textContent()
      .then((text) => text.includes('不放入相册')),
  );
  console.log('PASS missing album blocks upload and allows selecting another destination');

  await page.goto(`http://piccove.test/app?album=${albumId.toUpperCase()}`);
  await page
    .getByRole('combobox', { name: '上传到相册' })
    .filter({ hasText: '目标相册' })
    .waitFor();
  await page.getByRole('button', { name: '复制 first.png 链接' }).waitFor();
  assert.equal(imageQueryAlbums.at(-1), albumId);

  const queriesBeforeInvalidAlbum = imageQueryAlbums.length;
  await page.goto(`http://piccove.test/app?album=${albumId}%23extra`);
  await page.getByRole('alert').filter({ hasText: '所选相册不存在或无权访问' }).waitFor();
  assert.equal(imageQueryAlbums.length, queriesBeforeInvalidAlbum);

  await page.goto('http://piccove.test/app/account');
  await page.getByRole('button', { name: '修改用户名' }).waitFor();
  const countPosts = () => calls.filter(([m]) => m === 'POST').length;
  let before = countPosts();
  await page.getByRole('button', { name: '修改用户名' }).click();
  const userDlg = page.getByRole('dialog');
  await userDlg.getByRole('button', { name: '保存用户名' }).click();
  assert.equal(countPosts(), before);
  assert.equal(
    await userDlg
      .locator('[name=current_password]')
      .evaluate((e) => e.validity.valueMissing),
    true,
  );
  await userDlg.locator('[name=current_password]').fill('password12345');
  await userDlg.locator('[name=username]').fill('invalid name');
  await userDlg.getByRole('button', { name: '保存用户名' }).click();
  assert.equal(countPosts(), before);
  await userDlg.locator('[name=username]').fill('valid_name');
  await userDlg.getByRole('button', { name: '保存用户名' }).click();
  await page.getByText('登录用户名已更新', { exact: true }).waitFor();
  assert(calls.some(([, path]) => path === '/me/username'));

  await page.getByRole('button', { name: '删除 Passkey 设备' }).click();
  const rmPkDlg = page.getByRole('dialog');
  await rmPkDlg.locator('[name=current_password]').fill('password12345');
  await rmPkDlg.getByRole('button', { name: '确认移除' }).click();
  await page.getByText('Passkey 已移除', { exact: true }).waitFor();
  assert(calls.some(([, p]) => p === '/me/passkeys/remove'));

  await page.getByRole('button', { name: '绑定验证器' }).click();
  const totpDlg = page.getByRole('dialog');
  await totpDlg.locator('[name=current_password]').fill('password12345');
  await totpDlg.getByRole('button', { name: '下一步：生成密钥' }).click();
  await totpDlg.getByText('SECRET1', { exact: true }).waitFor();
  await totpDlg.getByRole('button', { name: '重新生成密钥' }).click();
  await totpDlg.getByText('SECRET2', { exact: true }).waitFor();
  await totpDlg.locator('[name=code]').fill('123456');
  await totpDlg.getByRole('button', { name: '确认开启二步验证' }).click();
  await page.getByText('绑定已过期，请重新开始', { exact: true }).waitFor();
  await totpDlg.getByRole('button', { name: '重新生成密钥' }).click();
  await totpDlg.getByText('SECRET3', { exact: true }).waitFor();
  await totpDlg.getByRole('button', { name: '取消', exact: true }).click();
  await totpDlg.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '添加 Passkey' }).click();
  const addPkDlg = page.getByRole('dialog');
  await addPkDlg.locator('[name=name]').fill('我的设备');
  await addPkDlg.locator('[name=current_password]').fill('password12345');
  await addPkDlg.getByRole('button', { name: '开始绑定' }).click();
  await page.getByText('模拟取消Passkey创建', { exact: true }).waitFor();
  await addPkDlg.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('button', { name: '修改密码' }).click();
  const pwdDlg = page.getByRole('dialog');
  await pwdDlg.locator('[name=current_password]').fill('password12345');
  await pwdDlg.locator('[name=password]').pressSequentially('中文密码abcd');
  await pwdDlg.locator('[name=confirm]').pressSequentially('中文密码abcd');
  await pwdDlg.getByRole('button', { name: '确认更新密码' }).click();
  await page.getByText('测试已收到多字节密码', { exact: true }).waitFor();
  assert(calls.some(([method, path]) => method === 'POST' && path === '/me/password'));
  await pwdDlg.getByRole('button', { name: '取消', exact: true }).click();

  enabled = true;
  await page.reload();
  await page.getByRole('button', { name: '修改用户名' }).click();
  await userDlg.locator('[name=current_password]').fill('password12345');
  before = countPosts();
  await userDlg.getByRole('button', { name: '保存用户名' }).click();
  assert.equal(countPosts(), before);
  assert.equal(
    await userDlg.locator('[name=code]').evaluate((e) => e.validity.valueMissing),
    true,
  );
  console.log('PASS per-action security dialogs, QR TOTP restart/cancel, UTF-8 password byte length and 2FA proof');
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
}
