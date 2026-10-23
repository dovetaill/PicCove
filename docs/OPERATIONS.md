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

## Web 存储、版本与升级

后台「系统设置」显示 API 当前运行版本，可从 GitHub 检测最新稳定版本。新上传的原图和外链使用 UTC 日期路径 `YYYY/MM/DD/UUID.扩展名`；旧 `/i/UUID` 链接继续有效，日期链接仍执行私有图片权限校验。

后台「存储位置」列出目录、图片数量、容量和可用空间。先登记目录，再设为默认；登记仅允许 `PICCOVE_STORAGE_ROOTS` 内已经存在、可写、无符号链接的目录，存储之间及存储与导入目录不能重叠。切换默认位置立即作用于新上传，每张图片保留自己的存储位置。不会自动创建所选目录、修改现有目录权限或属主。

Docker 内只能选择已经映射给 API 的目录。接入其他磁盘时，在安装目录的 `compose.override.yml` 中增加挂载，例如：

```yaml
services:
  api:
    environment:
      PICCOVE_STORAGE_ROOTS: /data/uploads:/storage
      PICCOVE_IMPORT_DIR: /imports
    volumes:
      - type: bind
        source: /mnt/pictures/piccove
        target: /storage/pictures
        bind:
          create_host_path: false
      - type: bind
        source: /mnt/incoming/piccove
        target: /imports
        read_only: true
        bind:
          create_host_path: false
```

由运维先确认该磁盘已挂载、目录存在，并核对 API 容器实际 UID/GID 与目录访问权限；当前发行镜像使用 `10001:10001`。应用 Compose 配置后，在 Web 登记 `/storage/pictures`。不需要 SFTP 导入时省略 `PICCOVE_IMPORT_DIR` 和 `/imports` 挂载。允许根目录使用冒号分隔，未设置时只允许 `UPLOAD_DIR`。不要把宿主机根目录或 Docker socket 挂载给 API。升级保留独立的 `compose.override.yml`。备份和恢复也必须包含全部旧、新存储目录；存在默认 `/data/uploads` 之外的图片时，原 `piccovectl backup` 会拒绝生成不完整备份，此时需独立备份数据库和所有图片目录。

Web 升级/重启通过宿主机 `piccovectl web-manager` 执行。API 只读挂载独立控制卷 `/run/piccove`，通过 Unix socket 提交固定的状态查询、升级、重启操作，不接收 shell、路径或任意命令。只有已登录管理员且 Origin 校验通过才能提交操作。管理进程从实际 API 容器读取 UID/GID，仅给新建 socket 配置对应组权限，不修改图片目录权限。

首次启用需要先安装包含此功能的发行包，再在宿主机配置管理服务（默认安装路径示例；自定义安装需相应修改 unit 的两个路径，多实例需独立 unit）：

```sh
# 先核对目标 unit 尚不存在，已有服务应审查后合并配置，勿直接覆盖。
sudo cp /opt/piccove/deploy/piccove-web-manager.service /etc/systemd/system/piccove-web-manager.service
sudo systemctl daemon-reload
sudo systemctl enable --now piccove-web-manager.service
```

之后可完全在 Web 检测版本、确认「升级并重启」或单独重启。任务状态保存在安装目录 `.piccove-web-operation.json`，刷新页面后仍可查询；重复运行的管理进程和并发操作会被拒绝。没有管理服务时版本检查仍可使用，操作按钮禁用并说明原因。

升级复用原有下载、SHA256、发行清单、版本校验和 Compose 健康检查，不自动备份、不自动降级。升级或重启期间网页短暂不可用；升级失败可能停止 API/Web，此时 Web 无法显示最终错误，需在宿主机检查：

```sh
sudo journalctl -u piccove-web-manager.service -n 100
sudo piccovectl status
```

按既有失败处理流程检查 `.piccove-update-pending.json`，不要绕过记录重新启动旧版。升级成功后刷新网页加载新前端。管理服务自身的协议或启动参数发生变化时，也需按对应发行说明更新 unit 并重启管理服务。


### 目录身份与挂载故障

登记时保存目录的设备号和 inode。上传、读取、删除、迁移及清理都会重新核对，目录被替换或挂载丢失时拒绝访问，避免向替代目录写入。文件操作逐级使用目录句柄并拒绝符号链接、跨设备子目录；这不是对宿主机 root 的隔离，宿主机管理员仍能直接修改文件。原图目录必须只交给受信任的运维和 API 写入，SFTP 用户只使用独立的导入目录。

首次启用本功能前，应挂载全部历史图片目录，启动会登记其身份。此后不会在重启时自动接受新身份；基础 `UPLOAD_DIR` 身份变化会在写入锁文件前阻止启动。运行中的目录异常会在后台显示错误，恢复原挂载后重试即可。不能通过重新登记或改权限来绕过目录身份不匹配。

### 迁移与旧副本清理

1. 登记目标存储，检查空间；后台选择源和目标并创建迁移任务。
2. 若源为默认存储，任务创建时将新上传切换到目标；迁移覆盖创建任务时源目录中的现有图片。
3. 按图复制，校验 SHA256 并同步文件后切换数据库位置；图片 ID、相对路径、外链和私有状态不变。目标已有相同内容可续作，内容不同则失败，绝不覆盖。
4. 任务和逐项结果保存在数据库；刷新页面不丢失，服务重启会恢复未完成项。失败项在修复磁盘、容量或冲突后点击重试。不要直接搬走源文件。
5. 迁移完成后可单独点击「清理旧副本」。每项再次校验当前目标和源文件身份，任一不符就保留源文件并记录失败；只删除任务记录的文件，不递归删除目录。原图删除也会清理迁移记录中的可核验副本。

初版按单文件顺序执行任务，复用上传互斥锁协调配额、删除和迁移。单张最大 10 MiB，迁移/缩略图处理时其他请求可能短暂等待。尚不提供任务取消、自动删除迁移历史或大规模并行搬迁。

### SFTP 待导入目录

应用不启动 FTP/SFTP 服务，也不提供服务器文件编辑器。使用现有 SFTP 账号把文件上传到宿主机待导入目录，API 以只读方式挂载该目录。配置目录时需核对双方实际 UID/GID 和读取权限，不得为方便而递归修改磁盘权限。

传输时使用 `.part` 后缀或隐藏临时文件，传输完成后原子改名为 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`。后台点击扫描，选择用户、相册和公开状态；默认私有。目录结构展示为相对文件名，不自动创建用户或相册。每批最多 1000 个候选文件，扫描最多 5000 个目录项、32 层子目录；超出时应拆分导入目录。符号链接、未完成扩展名及超过 10 MiB 的候选不会导入。

扫描后改变的文件会被拒绝，需要重新扫描创建任务。实际导入执行图片解码、大小、磁盘余量、用户状态、相册归属和配额检查。逐项失败不阻断其他文件；失败重试仍会执行原检查。相同用户、相同源路径、相同内容的已入库图片不会重复创建，也不会被重复请求改成公开。任务恢复同样避免重复入库。已经从图床删除的图片可重新导入。

**导入源文件始终保留**，图床中的删除不删除 `/imports` 文件。管理员确认导入结果后，可使用原 SFTP 工具清理传入文件。图片格式和内容由后端验证，不信任后缀名。

### 缩略图与上传队列

图片库按需加载最长边 480 像素的 PNG 缩略图，缓存存放在该图片所在存储的 `.thumbnails` 下。原图不改写；GIF 缩略图为静态预览，打开原图仍保留动画。私有缩略图必须通过与原图一致的登录及归属检查，不由 Nginx 直接公开缓存目录。迁移后在目标按需重建缓存，清理旧副本或删除原图会清理相关缓存。

上传区支持拖拽、粘贴和文件夹选择，展示逐项结果与已处理数量，失败项可单独重试；进度为文件完成数量，不是字节传输百分比。文件夹中的图片上传到当前所选相册，不自动建立目录对应的子相册。页面刷新不会保留浏览器 File 对象及本地上传队列。

### 自定义存储备份与恢复

`piccovectl backup` 仍只覆盖 `/data/uploads`，有其他位置原图时会拒绝生成不完整备份。完整备份需在停止 API（同时停止迁移/导入工作线程）后，备份 PostgreSQL、全部登记存储目录、`.env` 与 `compose.override.yml`；导入源目录按需另备。手工复制的旧副本不能替代数据库备份。

恢复时先停 API，验证备份校验和、恢复数据库和全部目录，核对实际服务身份、挂载映射、文件属主及权限。恢复到新磁盘/新目录后设备号和 inode 会变化，必须由运维明确重新确认身份；应用不会静默重绑。对**已恢复并逐项核对的具体目录**，在容器视角读取 `stat -c '%d:%i' /具体存储目录`，核对 `storage_locations` 中对应 `id/path` 后只更新该记录的 `identity`，不得清空整张表或批量接受未知目录。保持原容器路径，数据库中的 `storage_root` 与外链即可保持原值。

恢复后先检查公开和私有原图、缩略图及大图完整下载，再允许上传和继续任务。涉及迁移中的旧副本时，恢复会改变文件身份，旧清理任务可能安全失败；必须重新核对文件，不能绕过校验强行清理。跨服务器恢复仍需执行上述人工验收，本次实现没有自动多磁盘备份工具。
