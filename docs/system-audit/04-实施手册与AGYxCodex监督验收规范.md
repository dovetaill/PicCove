# 04 · 实施手册与 AGY × Codex 协作监督规范

> **执行前提**：在您审阅文档并确认实施范围前，我们不会改动任何业务代码。一旦您确认启动，我们将严格按本手册的文件级清单、验证门禁与反过度防御监督流程推进。

---

## 一、各阶段文件级实施清单

### Stage 1：安全止血、锁解耦与运维加固
- **后端核心（`apps/api`）**：
  - `apps/api/src/main.rs`：
    - 将 `AppState.uploads: Mutex<()>` 拆分为短临界区存储变更锁与按用户对账锁；移除 `serve_image` 对全局锁的依赖；`upload_image` 先在有界超时内完成流读取、单次哈希计算与图片解码，再进临界区；修复 `store_image` 写盘失败残留记录问题。
    - 新增 `client_ip()`（受 `PICCOVE_TRUST_PROXY` 控制识别 `X-Real-IP`）；将 `validate_credentials` 前置于 `rate()`；拆分 `login:ip`、`login:user`（仅失败计次）与 `passkey-start:ip`；修复 `rate()` 冲突过期时间不更新问题。
    - `bootstrap` 待清理文件循环改为逐项容错记录 `tracing::warn!`，不阻断 HTTP 监听。
    - `update_visibility` 补齐 `current.disabled` 校验；`update_user` 仅在禁用或改密时递增 `security_version`；统一 `list_images`（无 `ids` 时）、`admin_overview` 的 `deleted_at IS NULL` 统计口径。
  - `apps/api/src/thumbnails.rs` & `apps/api/src/storage.rs`：移除 `thumbnails::serve` 中的 `state.uploads` 锁，并发删图导致的读取 `NotFound` 映射为 `404`。
  - `apps/api/src/ai.rs`：合并生图落盘激活与 `ai_messages` 完成更新至同一事务；修复生成失败回写的 `let _ =` 吞错；`enqueue_review` 允许 `'failed'` 记录重传重审；`review_decision` 保留已有违规分类；`authorize_image` 保留 5xx 数据库错误。
  - `apps/api/src/ctl/mod.rs` & `ctl/web.rs`：
    - `backup()` 移至停写后核查外盘、纳入 `compose.override.yml`、确保清理异常仍恢复原运行容器；
    - `update()` 预构建镜像后再停服切换，`health()` 增加数据库连通检查，切换成功后旧文件/旧镜像清理失败不再反停新服务；
    - 安装与 `web-manager` 启动时核验安装目录及各级祖先目录的 root 归属与非他人可写权限。
- **部署与工作流（`deploy` / `.github`）**：
  - `deploy/nginx.conf` & `deploy/compose.yml`：透传 `X-Real-IP` 并为容器内 API 默认注入 `PICCOVE_TRUST_PROXY=true`。
  - `.github/workflows/ci.yml` & `release.yml`：移除 `smoke.py | tee` 管道写法，改为直接重定向日志文件并在失败时输出尾部诊断。

### Stage 2：删繁就简与仓库/发行包大瘦身
- **打包与清理**：
  - `scripts/release.py` + `tests/test_release.py`：`stage/docs/` 改为精确白名单拷贝（排除 `DEPLOY-tu.jpggg.com.md`、`ui-redesign/`、`system-audit/`、`ARCHITECTURE.md`、`CODEX_PROMPT.md`）。
  - `apps/api/src/management.rs` + `main.rs` + `tests/api_smoke.py`：移除 `/api/v1/admin/storage` 旧路由，冒烟测试切换至 `/api/v1/storage-locations`。
  - 删除冗余文件：`admin/documentation.html`、`admin/nginx.conf`、`apps/web/`、`docs/CODEX_PROMPT.md`、`artifacts/ui-review/*`（并更新 `.gitignore`）；精简 `infra/compose.yml`（移除 `redis`）；更新 `admin/README.md`、`README.md`、`docs/ANDROID.md` 过时说明。
  - `admin/src/components/ui/` & `admin/public/media/app/`：删除确认零引用的模板组件与模板演示 SVG，提供 PicCove 品牌 SVG Favicon。
  - `admin/src/features/admin/`：提取 `system-service-card.tsx` 供 `overview-page.tsx` 与 `settings-page.tsx` 共用，并为审核模型区补齐已拉取模型数量显示。

### Stage 3：性能跃升与多端交互打磨
- **前端与网关性能**：
  - `deploy/nginx.conf`：启用文本与矢量静态资源 `gzip` 压缩。
  - `admin/src/App.tsx` & `vite.config.ts`：路由级 `React.lazy` 按需加载，移除 `chunkSizeWarningLimit: 3000`。
  - `admin/src/features/auth/public-pages.tsx`：已登录访问 `/login` 自动跳 `/app`；非安全上下文或纯 IP 访问默认展开“密码登录”。
- **API 缓存、批量操作与状态修复**：
  - `main.rs` & `thumbnails.rs`：支持鉴权通过后的强 `ETag` 与 `If-None-Match -> 304 Not Modified`（`Cache-Control: private, no-cache`）；敏感接口显式 `no-store`；新增 `POST /api/v1/images/batch`（最多 48 项批量移动/设可见性/删除）；全局复用单个 `reqwest::Client`。
  - `gallery-page.tsx` / `all-images-page.tsx` / `reviews-page.tsx` / `upload-manager.tsx` / `upload-center-sheet.tsx`：接入批量写接口；修复 `DELETE` 异常误删历史与审核详情静默吞错；React Query 私有查询键带上 `user.id`；修复 `paste` 监听依赖数组；上传中心按批次复制链接并支持“清除已完成”。
- **AI 会话与 Android 客户端**：
  - `apps/api/migrations/0010_ai_conversation_archive.sql` + `ai.rs` + `ai-studio-page.tsx`：支持会话重命名与归档删除；放宽非当前参考图的历史删图限制；消除 `review_worker` 积压时的 2 秒固定休眠；修正前端轮询重复失效。
  - `apps/android/app/src/main/java/app/piccove/android/{ApiClient,MainActivity}.java`：列表改读 `/api/v1/images/{id}/thumbnail`、分享改用 `photo.optString("url")`、展示审核限制状态、上传直带 `album_id`、改名/移动改为局部 `PATCH`。

### Stage 4：四大高价值新功能（按您确认的子项实施）
- `apps/api/migrations/0011_tokens_shares_recovery.sql`（按启用项精确建表/加列）：
  - **4A（2FA 恢复码与重置）**：`security.rs` + `main.rs` + `ctl/mod.rs` + `account-page.tsx` + `users-page.tsx`
  - **4B（API Token 与 PicGo 接入）**：`tokens.rs`（或内聚于 `security.rs`）+ `protect_origin` Bearer 豁免 + `account-page.tsx` Token 管理与 PicGo 配置复制弹窗
  - **4C（可选剥离 EXIF/GPS）**：`exif.rs`（轻量无损元数据段清理）+ `store_image` `source_hash` 对账兼容 + 上传栏开关
  - **4D（单图临时受控分享）**：`shares.rs`（`/api/v1/images/{id}/shares` 与公开访问 `/s/{token}`）+ `deploy/nginx.conf` `/s/` 转发 + `image-detail-sheet.tsx` / `links-dialog.tsx` 临时分享面板

---

## 二、AGY 指挥监督 Codex 的反过度防御执行规范

在后续编码实施阶段，采用 **“AGY 主导核心架构/前端交互/终审把关 + Codex 分包明确边界的后端模块与测试补充”** 协同模式。每次向 Codex 派发编码任务及合入前，AGY 严格执行以下监督清单：

### 1. 下发指令四条硬约束
1. **最小完整改动**：只改当前 Stage 授权的文件与契约，禁止顺手发明未授权的配置项、Wrapper 层或通用框架。
2. **单一事实源**：客户端 IP 解析、软删除 SQL 条件、批量鉴权、前端系统控制面板只准有一处实现，禁止多处复制粘贴各自维护白名单。
3. **严禁静默吞错与猜测性回退**：禁止任何 `let _ =` 吞数据库/IO 错误、禁止空 `catch {}` 伪造假数据、禁止元数据剥离失败时静默保存未脱敏原图。
4. **不堆叠破坏性冗余校验**：不在前端手写与后端规则打架的复杂正则或 `setCustomValidity`，不在管理员 AI 地址上擅自封锁内网网关。

### 2. 合入前 AGY 强制逐行复审与独立验收门禁
Codex 每次运行完毕后，AGY 绝不轻信其自评报告，必须亲自执行：
1. **逐文件 `git diff` 审查**：剔除任何过度防御分支、重复查询或冗余提示文案。
2. **隔离环境全链路自动化验收**（仅在 `/var/tmp` 任务独占目录与临时容器运行，严禁触碰 `/opt/piccove` 生产实例与生产数据库）：
   - Rust：`cargo fmt --check`、`cargo test --locked`、`x86_64-unknown-linux-musl` 静态构建零警告通过；
   - Web：`npm run build`（含全量 `tsc` 严格检查）、`tests/web.test.mts`、`tests/upload.test.mjs` 及 Chromium 端到端交互套件通过；
   - 集成与冒烟：`tests/api_smoke.py`、`tests/albums_http.py`、`tests/storage_http.py`、`tests/ai_http.py`（验证慢连接上传不再阻塞其他用户原图/缩略图读取、代理 IP 限流隔离、备份包含 `compose.override.yml`、升级清理失败不停新服务等新增回归用例）；
   - Android（若启用 Stage 3 安卓项）：单元测试与 Lint 检查通过。
3. **零残留清理核查**：确认临时编译 `target`、`.pyc`、`__pycache__`、临时容器与测试端口 100% 释放，仓库工作区干净整洁后再向您汇报验收结果。
