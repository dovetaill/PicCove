# GitHub Release 安装、升级与 Rust 运维

服务器使用编译好的 `piccovectl`；无需 Python、Rust 或 Node.js。仅支持 Linux x86_64，需预装 Docker Engine、Compose v2、Buildx；引导下载还需 curl 和 sha256sum。网页继续由现有 Docker Compose 部署，不增加安卓或桌面发行任务。

## 首次安装

```sh
curl -fsSL https://raw.githubusercontent.com/dovetaill/PicCove/main/scripts/install-server.sh | sudo sh -s -- install --origin https://img.example.com --non-interactive
```

默认安装到 `/opt/piccove`，本机监听 `127.0.0.1:18081`，Compose 项目名 `piccove-tu`。安装后创建 `/usr/local/bin/piccovectl` 链接。初始管理员为 `admin`，随机密码保存在安装目录 `.env`（0600），不会输出到日志。登录后可修改用户名、密码，设置二步验证和 Passkey。

域名、HTTPS 与宿主机反向代理仍按 [部署说明](DEPLOY-tu.jpggg.com.md) 配置。安装器不修改宿主机 Nginx、文件权限或防火墙。`--origin` 是实际访问地址，无路径和末尾斜杠；本地试用可用 `http://127.0.0.1:18081`。

自定义实例可指定 `--directory /绝对路径 --project 独立项目名 --port 独立端口`。自定义目录使用 `/安装目录/bin/piccovectl --directory /安装目录`，或在该目录执行 `sh piccove.sh`。现有安装目录拒绝重复安装。

## 升级和日常管理

```sh
sudo piccovectl                         # 中文菜单
sudo piccovectl status
sudo piccovectl health                  # API、网页、JS/CSS 完整传输
sudo piccovectl logs                    # 最近 100 行
sudo piccovectl restart
sudo piccovectl stop --non-interactive
sudo piccovectl start
sudo piccovectl update --non-interactive
```

`update`（别名 `upgrade`）默认下载最新稳定 GitHub Release；可用 `--version X.Y.Z` 固定版本。旧安装还没有 `piccovectl` 时，用引导命令升级：

```sh
curl -fsSL https://raw.githubusercontent.com/dovetaill/PicCove/main/scripts/install-server.sh | sudo sh -s -- update --non-interactive
```

升级原地更新程序，保留 `.env`、数据库和原图卷。**不自动备份，不保留历史程序版本。** 新版通过健康和资源检查后，删除旧清单中已废弃且内容未变的程序文件，以及本次替换后不再被任何容器或标签引用的旧 API／Web 镜像。下载目录和独占构建缓存随操作清理；不会执行全局 Docker prune，也不会删除手动备份、用户指定的本地包或 GitHub 上的历史 Release。

从旧版迁移时，旧版无完整文件清单，只清理确认归属的 `web/assets` 旧资源。同时删除与 v0.1.3 原版哈希一致的两份旧 Python 运维脚本；其他未知或修改过的文件保留，避免误删用户内容。仍有容器或标签引用的镜像会保留并提示。

无需联网下载时，可提供可信本地包和同目录的 `SHA256SUMS`：

```sh
sudo piccovectl update --archive /path/to/piccove-vX.Y.Z-linux-x86_64.tar.gz --non-interactive
```

SHA-256 用于验证传输与内容一致性，来源信任仍依赖 GitHub 仓库及 HTTPS。程序拒绝降级、同版本不同提交、符号链接／穿越归档、非程序路径和非本安装拥有的 Compose 项目。运维锁避免同一安装同时运行变更；不要同时手工操作 Compose。

## 手动备份与失败处理

```sh
sudo piccovectl backup --backup /var/backups/piccove/本次新目录
```

备份暂停 API／网页写入，将数据库、原图、`.env`、Compose 与版本信息保存到新目录（0700），随后恢复原本运行的应用。只有完整成功才生成 `SHA256SUMS`。备份含凭据，请妥善保管并另存异机；恢复步骤见 [BACKUP.md](BACKUP.md)。手动备份不会被升级清理。

升级失败时尝试停止 API／网页，保留 `.piccove-update-pending.json` 和数据供排查，不自动回滚。记录未处理前禁止再次覆盖或启动。检查日志，核对包版本、数据库迁移和失败阶段后再修复；不要直接删记录强行启动，也不要只回退二进制。清理失败同样会报错，不宣称升级完成。

首次安装失败则保留新目录和配置；排除原因后可在目录中执行 `docker compose build api web`、`docker compose up -d --wait`，再用 `bin/piccovectl --directory "$PWD" health` 检查。不会重新生成数据库密码。

## 开发者发版

未提交工作区生成的包不允许安装；正式 Release 必须来自干净提交。源码中的 Python 只用于构建、版本同步、GitHub 发布和测试，不进入服务器发行包。

```sh
sh piccove.sh version --set X.Y.Z
# 检查并提交修改后：
sh piccove.sh release --yes
```

Actions 构建 API、Web 和 Rust CLI，校验安装与升级流程，通过后发布 `.tar.gz`、独立 `piccovectl-linux-x86_64`、`SHA256SUMS`、`release.json` 四个附件。发行包有逐文件校验清单。发版要求 main、干净工作区、版本一致和新 tag；不改动已有 Release。
