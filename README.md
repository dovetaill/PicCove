# PicCove / 图湾

让每一张图片，都有它的归处。

首版面向自用与邀请试用：账号登录、本地原图存储、公开外链、相册、批量图片管理、用户配额和可切换的普通用户注册。首页、用户工作台与管理员页面统一在 `admin` 工程中，复用购买的 Metronic React 模板组件。

## 目录

- `apps/api`：Rust / Axum / SQLx / PostgreSQL API。
- `admin`：React / TypeScript / Vite 前台与后台，运行入口为 `src/main.tsx`。
- `apps/web`：旧原型入口的迁移说明。
- `infra/compose.yml`：原有本地数据库开发配置，示例密码只适用于开发。
- `tests`：API 场景与前端逻辑验证。
- `docs/BACKUP.md`：一致性备份与隔离恢复流程。
- `docs/ROADMAP.md`：已确认首版范围与延期内容。

## 本地开发

需要 Rust 1.90+、Node.js 22+、PostgreSQL 16+。推荐以普通用户运行；不要在生产宿主机以 root 直接运行验证。先准备独立开发数据库，不要连接已有生产数据库。

```bash
# 首次启动前编辑配置，设置 DATABASE_URL、管理员初始密码、UPLOAD_DIR。
cd apps/api
cp .env.example .env
# 密码为 12–128 字节；.env 是 shell 文件，含特殊字符的值需正确加引号。
set -a
. ./.env
set +a
cargo run
```

首次启动自动执行迁移并创建管理员；之后配置中的初始密码不会重置已有密码。初始化后应从运行环境移除 `PICCOVE_ADMIN_PASSWORD`。旧原型图片会归属首次管理员，ID、存储键和外链路径保持不变；请在升级前备份数据库与文件。

另开终端：

```bash
cd admin
npm ci
npm run dev
```

访问 `http://127.0.0.1:5173`。Vite 将 `/api`、`/i` 代理至本机 API；浏览器使用 HttpOnly 会话 Cookie，不保存开发 Token。登录接口不再接受旧的 `PIXCOVE_ADMIN_TOKEN`。

## 行为与边界

- 注册默认关闭。管理员可开启自助注册或直接创建用户；关闭注册不影响已有用户。
- 新用户默认配额 1 GiB，单张最多 10 MiB；支持 JPEG、PNG、WebP、GIF。按文件真实内容检测格式并执行有内存／尺寸限制的解码，不重写原图。动画校验不等于逐帧内容审核。
- 普通用户只能管理自己的图库和相册；管理员可查看、删除全部图片，管理用户、配额与注册开关。
- 改密码、管理员重置密码或禁用账号会撤销已有会话。禁用账号不会下架图片；删除图片才停止提供外链。
- 图片均公开访问，禁止用于敏感资料。改展示名、移动相册不改变外链；删除相册保留图片。
- 删除先阻断图片访问，再清理文件和数据库记录；失败时显示待清理项，允许重试，重启也会清理。文件清理成功后才释放配额。无法撤回第三方已下载的副本。
- 低于 1 GiB 可用磁盘空间时暂停上传。单个 API 进程串行处理上传并锁定存储目录，暂不支持多实例共享本地存储。
- 注册、登录按实际连接来源 IP 限流，上传按用户限流。**经过反向代理时来源 IP 是代理地址，用户共享这部分限额**；适合当前小范围试用，大规模公开注册前需明确可信代理和防滥用方案。注册另有全局每小时 20 次限制。
- 不实现支付、对象存储、自动压缩、水印、私密图、迁移中心、回收站、SDK 和桌面／移动客户端。

## 部署入口

本次只提供代码与配置，没有部署或替换现有站点。`admin/dist` 是原有产物，未被本次验证覆盖，部署时必须重新构建。

`npm run build` 会检查实际入口及其依赖，再输出 `admin/dist`。原模板演示路由保留在源码中，但不是本产品入口；部分原模板文件缺失，未扩展修复这些演示页面。

生产环境应使用 HTTPS，设置 `CORS_ORIGIN` 为准确的前台 Origin（不带尾斜杠），配置 `PUBLIC_BASE_URL` 为长期使用的图片访问域名，`CONTACT_URL` 为真实的 `mailto:` 或 HTTPS 联系入口。`admin/nginx.conf` 提供同源 API 代理与 SPA 回退示例；需根据现有部署设置站点根目录和 TLS，不可直接覆盖生产配置。Cookie 的 Secure 标志由 HTTPS 前台 Origin 决定。

API 默认只监听 `127.0.0.1:3001`。非浏览器写请求也必须发送匹配的 `Origin` 头；仅允许可信前台 Origin，避免跨站 Cookie 写请求。图片响应不允许缓存，以保证服务端删除后不继续从配置缓存提供图片。

正式邀请用户前需要落实独立服务器备份、联系入口、实际域名及模板商业授权；PicCove 命名与域名尚未核查。

## 验证

在独立工作副本和非特权身份下运行，给 Cargo 使用任务独占的 target 目录，并在完成后清理。不要重用生产数据库或上传目录。

```bash
# apps/api，显式设置任务独占 CARGO_TARGET_DIR 后执行
cargo fmt --check
cargo check --locked
cargo test --locked
# admin
npm run build
# 在装好 admin 依赖的同一工作副本根目录
admin/node_modules/.bin/tsx tests/web.test.mts
```

`tests/api_smoke.py` 会创建用户与图片，只能用于可销毁的本地测试实例。需要显式设置 `PICCOVE_TEST_URL` 和 `PICCOVE_TEST_ADMIN_PASSWORD`，使用用户名 `admin` 的全新实例，再以普通身份执行 `python3 tests/api_smoke.py`。脚本覆盖鉴权、跨用户隔离、注册开关、格式／大小限制、完整图片传输、配额、相册、密码变更、禁用、删除与登录限流。备份恢复应另按 `docs/BACKUP.md` 验证。
