// Offline Chromium interaction checks. Never point this at a deployed application.
// Run as a non-root user with HOME and TMPDIR inside a task-owned directory:
// PICCOVE_UI_FIXTURE=/absolute/disposable/fixture node tests/gallery-usability.test.mjs
// The fixture must contain chrome/chrome, node_modules/playwright, app.js,
// base.css (existing built Tailwind CSS), and src/piccove/style.css (current source).
// Bundle current App.tsx with React DOM, JSX automatic runtime and @ -> src aliases.
// For this offline fixture only: alias next-themes to an inert light-theme provider;
// alias sonner toast.success/error/info to append messages to window.__toasts,
// with Toaster returning null. This tests business components and native validation,
// not theme/toast rendering or an exact-lock production build. Every API is mocked.
// The test owns its ephemeral loopback server/browser and closes both in finally.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
assert.notEqual(process.getuid(), 0);
const dir = process.env.PICCOVE_UI_FIXTURE;
assert(
  dir && dir.startsWith("/"),
  "PICCOVE_UI_FIXTURE must be an absolute disposable fixture directory",
);
const { chromium } = await import(
  pathToFileURL(`${dir}/node_modules/playwright/index.mjs`)
);
const server = createServer(async (req, res) => {
  const file =
    req.url === "/app.js"
      ? "app.js"
      : req.url === "/base.css"
        ? "base.css"
        : req.url === "/style.css"
          ? "src/piccove/style.css"
          : null;
  res.setHeader(
    "Content-Type",
    file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html",
  );
  res.end(
    file
      ? await readFile(`${dir}/${file}`)
      : '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(
  JSON.stringify({
    pid: process.pid,
    pgid: Number(
      (await readFile(`/proc/${process.pid}/stat`, "utf8"))
        .split(") ")[1]
        .split(" ")[2],
    ),
    uid: process.getuid(),
    port,
    dir,
  }),
);
let browser;
try {
  browser = await chromium.launch({
    executablePath: `${dir}/chrome/chrome`,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: { ...process.env, HOME: dir, TMPDIR: dir },
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("PAGEERROR", e.message);
  });
  const pic = (id, extra = {}) => ({
    id,
    user_id: "u",
    album_id: null,
    original_name: `${id}.png`,
    size_bytes: 30,
    width: 10,
    height: 10,
    url: `http://127.0.0.1:${port}/i/${id}`,
    thumbnail_url:
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    deleted_at: null,
    is_public: true,
    ...extra,
  });
  let images = [pic("a"), pic("b"), pic("dead", { deleted_at: "2026-01-01" })];
  let holds = [];
  let resultImage = pic("a", { duplicate: true });
  let starts = 0;
  let enabled = false;
  const calls = [];
  let deleteFail = false;
  let uploadStatus = 200;
  const uploadUrls = [];
  let paged = false;
  let lastPageImage = true;
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "127.0.0.1") return route.abort();
    if (!u.pathname.startsWith("/api/")) return route.continue();
    const path = u.pathname.slice(7),
      method = route.request().method();
    calls.push([method, path]);
    const json = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (path === "/me")
      return json({
        user: {
          id: "u",
          username: "tester",
          is_admin: true,
          disabled: false,
          quota_bytes: 100000,
        },
        used_bytes: 60,
      });
    if (path === "/settings")
      return json({ registration_open: false, contact_url: null });
    if (path === "/albums") return json([{ id: "album", name: "目标相册" }]);
    if (path === "/images" && method === "GET")
      return json(
        paged
          ? {
              items:
                u.searchParams.get("page") === "2"
                  ? lastPageImage
                    ? [pic("last")]
                    : []
                  : [pic("first")],
              has_more: u.searchParams.get("page") !== "2",
            }
          : { items: images, has_more: false },
      );
    if (path === "/images" && method === "POST") {
      uploadUrls.push(u.searchParams.get("album_id"));
      holds.push(() =>
        json(
          uploadStatus === 200 ? resultImage : { error: "模拟上传失败" },
          uploadStatus,
        ),
      );
      return;
    }
    if (path === "/images/a" && method === "PATCH") return json({});
    if (path === "/images/b" && method === "PATCH")
      return json({ error: "模拟移动失败" }, 500);
    if (path.startsWith("/images/") && method === "DELETE") {
      images = images.filter((i) => path !== `/images/${i.id}`);
      if (path === "/images/last") lastPageImage = false;
      return json(
        deleteFail ? { error: "模拟文件清理失败" } : {},
        deleteFail ? 500 : 200,
      );
    }
    if (path === "/me/security")
      return json({
        totp_enabled: enabled,
        passkeys: [{ id: "key", name: "设备" }],
      });
    if (path === "/me/passkeys/start")
      return json({ error: "模拟取消Passkey创建" }, 400);
    if (path === "/me/totp/start")
      return json({ secret: `SECRET${++starts}`, uri: "otpauth://test" });
    if (path === "/me/totp/confirm")
      return json({ error: "绑定已过期，请重新开始" }, 400);
    if (path === "/me/passkeys/remove" || path === "/me/username")
      return json({});
    throw Error(`unexpected API ${method} ${path}`);
  });
  await page.goto(`http://127.0.0.1:${port}/app`);
  await page.getByRole("heading", { name: "我的图片库" }).waitFor();
  await page.locator(".cove-image").first().waitFor();
  assert.equal(
    await page.getByRole("button", { name: "复制 dead.png 链接" }).isDisabled(),
    true,
  );
  for (const b of await page
    .locator(".cove-image")
    .first()
    .locator("button")
    .all()) {
    await b.click({ trial: true });
    const box = await b.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390);
  }
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log("PASS mobile action hit targets and deleted-image copy disabled");
  await page.getByRole("checkbox", { name: "选择本页" }).check();
  await page
    .locator(".cove-batch")
    .getByRole("button", { name: "复制链接" })
    .click();
  await page.waitForFunction(() =>
    window.__toasts?.some((s) => s.includes("待清理")),
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("checkbox", { name: "选择 dead.png", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await page.waitForFunction(() =>
    window.__toasts?.some((s) => s.includes("已移动 1 张，剩余 1 张")),
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择 a.png", exact: true })
      .isChecked(),
    false,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择 b.png", exact: true })
      .isChecked(),
    true,
  );
  console.log("PASS partial batch move selection and feedback");
  const file = {
    name: "duplicate.png",
    mimeType: "image/png",
    buffer: Buffer.from("test"),
  };
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([file, { ...file, name: "second.png" }]);
  await page.waitForFunction(
    () =>
      document.querySelector(".cove-upload-queue progress") ||
      document.querySelector('[aria-label="上传队列"] progress'),
  );
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await page.locator("form.cove-security").waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "图片上传中，请勿刷新" })
    .click();
  await page.getByRole("heading", { name: "我的图片库" }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: "上传队列" }).locator("li").count(),
    2,
  );
  assert.equal(
    await page.locator(".cove-drop button").first().isDisabled(),
    true,
  );
  console.log(
    "PASS in-app navigation preserves in-flight queue and blocks another batch",
  );
  assert.equal(
    await page.locator(".cove-upload-details").evaluate((e) => e.open),
    false,
  );
  assert.equal(
    await page
      .getByRole("progressbar", { name: "当前图片传输进度" })
      .isVisible(),
    true,
  );
  await page.locator(".cove-drop").dispatchEvent("drop", {
    dataTransfer: await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["extra"], "extra.png", { type: "image/png" }));
      return d;
    }),
  });
  await page.waitForFunction(() =>
    window.__toasts?.includes("正在处理，请稍等片刻再添加图片"),
  );
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, "upload request must arrive");
  await holds.shift()();
  const queue = page.getByRole("region", { name: "上传队列" });
  async function openQueueDetails() {
    const details = queue.locator("details");
    if (!(await details.evaluate((e) => e.open)))
      await details.locator("summary").click();
  }
  await openQueueDetails();
  await queue.getByRole("link", { name: "查看原图：a.png" }).waitFor();
  await queue.getByRole("button", { name: "复制链接" }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByRole("dialog").locator("textarea").count(), 6);
  await page.keyboard.press("Escape");
  console.log(
    "PASS busy drop feedback and per-file duplicate links before batch completes",
  );
  resultImage = pic("a");
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, "upload request must arrive");
  await holds.shift()();
  await page.waitForFunction(() => window.__toasts?.includes("图片上传完成"));
  deleteFail = true;
  await page.getByRole("button", { name: "删除 a.png", exact: true }).click();
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await page.waitForFunction(() =>
    window.__toasts?.includes("模拟文件清理失败"),
  );
  assert.equal(await queue.getByRole("link").count(), 0);
  await page.keyboard.press("Escape");
  console.log("PASS failed delete removes all duplicate upload result links");
  resultImage = pic("private", { is_public: false });
  images.push(resultImage);
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ ...file, name: "private.png" });
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length, "upload request must arrive");
  await holds.shift()();
  await openQueueDetails();
  await queue.getByRole("link", { name: "查看原图：private.png" }).waitFor();
  assert.equal(
    await queue.getByRole("button", { name: "复制链接" }).isDisabled(),
    true,
  );
  assert.equal(
    await queue.getByRole("link").getAttribute("href"),
    resultImage.url,
  );
  deleteFail = false;
  await page
    .getByRole("button", { name: "删除 private.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await page.waitForFunction(() => window.__toasts?.includes("图片已删除"));
  assert.equal(await queue.getByRole("link").count(), 0);
  console.log(
    "PASS private upload view/copy restriction and successful delete queue cleanup",
  );
  // Failed uploads retain the album selected for their original submission.
  await page.getByRole("combobox", { name: "筛选相册" }).click();
  await page.getByRole("option", { name: "目标相册", exact: true }).click();
  uploadStatus = 500;
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ ...file, name: "retry.png" });
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();
  await queue.getByRole("button", { name: "重试未完成项" }).waitFor();
  assert.equal(await queue.getByRole("alert").isVisible(), true);
  await page.getByRole("combobox", { name: "筛选相册" }).click();
  await page.getByRole("option", { name: "全部相册", exact: true }).click();
  uploadStatus = 200;
  resultImage = pic("retry");
  await queue.getByRole("button", { name: "重试未完成项" }).click();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  assert.equal(uploadUrls.at(-1), "album");
  await holds.shift()();
  await openQueueDetails();
  await queue.getByRole("link", { name: "查看原图：retry.png" }).waitFor();
  console.log(
    "PASS failed upload retry retains original album after filter changes",
  );
  // Rate limits pause remaining files and enforce cooldown; no real waiting is needed.
  await page.clock.install();
  uploadStatus = 429;
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      { ...file, name: "limited.png" },
      { ...file, name: "waiting.png" },
    ]);
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();
  await queue.getByRole("heading", { name: "上传已暂停" }).waitFor();
  assert.equal(holds.length, 0);
  assert.equal(
    await queue.getByRole("button", { name: "请稍候再重试" }).isDisabled(),
    true,
  );
  const uploadsBefore = uploadUrls.length;
  await page.clock.fastForward(59_000);
  assert.equal(uploadUrls.length, uploadsBefore);
  assert.equal(
    await queue.getByRole("button", { name: "请稍候再重试" }).isDisabled(),
    true,
  );
  await page.clock.fastForward(1_100);
  uploadStatus = 200;
  resultImage = pic("limited");
  await queue.getByRole("button", { name: "重试未完成项" }).click();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  await holds.shift()();
  for (let n = 0; !holds.length && n < 500; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(holds.length);
  resultImage = pic("waiting");
  await holds.shift()();
  await openQueueDetails();
  await queue.getByRole("link", { name: "查看原图：waiting.png" }).waitFor();
  assert.equal(uploadUrls.length, uploadsBefore + 2);
  console.log(
    "PASS 429 pauses remaining files, enforces cooldown and retries both",
  );
  // A short landscape viewport must keep the complete QR dialog usable.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "分享 b.png 二维码" }).click();
  const qr = page.getByRole("dialog");
  await qr.waitFor();
  const qrBox = await qr.boundingBox();
  assert(qrBox.y >= 0 && qrBox.y + qrBox.height <= 390);
  await qr
    .getByRole("button", { name: "下载二维码 SVG" })
    .scrollIntoViewIfNeeded();
  await qr
    .getByRole("button", { name: "下载二维码 SVG" })
    .click({ trial: true });
  assert(await qr.evaluate((e) => e.scrollHeight > e.clientHeight));
  const svgBox = await qr.locator("svg").first().boundingBox();
  assert.equal(svgBox.width, 256);
  assert.equal(svgBox.height, 256);
  await qr
    .getByRole("button", { name: "Close", exact: true })
    .scrollIntoViewIfNeeded();
  await qr.getByRole("button", { name: "Close", exact: true }).click();
  await qr.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log(
    "PASS landscape QR dialog scrolls and close button remains reachable",
  );
  // Deleting the only image on page two returns to the previous nonempty page.
  paged = true;
  await page.reload();
  await page.getByRole("button", { name: "下一页" }).click();
  await page
    .getByRole("button", { name: "删除 last.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await page.getByRole("button", { name: "复制 first.png 链接" }).waitFor();
  await page.getByText("第 1 页", { exact: true }).waitFor();
  console.log(
    "PASS empty final page after deletion automatically returns to previous page",
  );
  await page.goto(`http://127.0.0.1:${port}/app/account`);
  const form = page.locator("form.cove-security");
  await form.waitFor();
  const countPosts = () => calls.filter(([m]) => m === "POST").length;
  let before = countPosts();
  await form.getByRole("button", { name: "保存用户名" }).click();
  assert.equal(countPosts(), before);
  assert.equal(
    await form
      .locator("[name=current_password]")
      .evaluate((e) => e.validity.valueMissing),
    true,
  );
  await form.locator("[name=current_password]").fill("password12345");
  await form.locator("[name=username]").fill("invalid name");
  await form
    .getByRole("button", { name: "删除 Passkey 设备", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.__toasts?.includes("账号安全设置已更新"),
  );
  assert(calls.some(([m, p]) => p === "/me/passkeys/remove"));
  await form.locator("[name=current_password]").fill("password12345");
  await form.getByRole("button", { name: "绑定验证器", exact: true }).click();
  await form.getByText("SECRET1", { exact: true }).waitFor();
  await form.locator("[name=username]").fill("valid_name");
  await form.getByRole("button", { name: "保存用户名" }).click();
  await page.waitForFunction(
    () => !document.querySelector("button[value=username]").disabled,
  );
  assert(calls.some(([m, p]) => p === "/me/username"));
  await form.locator("[name=current_password]").fill("password12345");
  await form.getByRole("button", { name: "重新绑定", exact: true }).click();
  await form.getByText("SECRET2", { exact: true }).waitFor();
  await form.locator("[name=code]").fill("123456");
  const usernameCalls = calls.filter(([, p]) => p === "/me/username").length;
  await form.locator("[name=name]").fill("我的设备");
  await form.locator("[name=name]").press("Enter");
  await page.waitForFunction(() =>
    window.__toasts?.includes("模拟取消Passkey创建"),
  );
  assert.equal(
    calls.filter(([, p]) => p === "/me/username").length,
    usernameCalls,
  );
  assert(calls.some(([, p]) => p === "/me/passkeys/start"));
  const beforeIme = calls.length;
  await form.locator("[name=name]").dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await form.locator("[name=code]").dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  assert.equal(calls.length, beforeIme);
  await form.locator("[name=code]").press("Enter");
  await page.waitForFunction(() =>
    window.__toasts?.includes("绑定已过期，请重新开始"),
  );
  await form.getByRole("button", { name: "重新绑定", exact: true }).click();
  await form.getByText("SECRET3", { exact: true }).waitFor();
  await form.getByRole("button", { name: "取消绑定", exact: true }).click();
  await form.getByRole("button", { name: "绑定验证器", exact: true }).waitFor();
  assert.equal(await form.locator("[name=code]").count(), 0);
  console.log(
    "PASS Passkey-name Enter, TOTP Enter and IME guard target only the intended action",
  );
  enabled = true;
  await page.reload();
  await form.waitFor();
  await form.locator("[name=current_password]").fill("password12345");
  before = countPosts();
  await form.getByRole("button", { name: "保存用户名" }).click();
  assert.equal(countPosts(), before);
  assert.equal(
    await form.locator("[name=code]").evaluate((e) => e.validity.valueMissing),
    true,
  );
  console.log(
    "PASS account action-local native validation, empty password/TOTP rejection, expired TOTP restart and cancel",
  );
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
  console.log("Browser and test listener closed");
}
