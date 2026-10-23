# PicCove 一键打包、发版和运维

```bash
bash piccove.sh
```

这是日常唯一入口。在源码目录管理发行和本机安装；安装后进入 `/opt/piccove` 运行同名脚本管理服务。无参数显示中文菜单，不会自动执行操作。

| 菜单 | 实际操作 |
| --- | --- |
| 安装 | 校验本地包 SHA-256、检查归档路径、解压到新目录，生成配置并启动容器 |
| 启动／停止／重启 | 控制当前安装的 Compose 服务；停止保留容器与数据，重启仅应用和网页 |
| 状态／日志／健康 | 服务状态、最近 100 行日志、本机 API 健康检查 |
| 备份 | 暂停应用写入，同时备份数据库、原图、配置与版本；恢复原本运行的应用 |
| 升级 | 校验更高版本包，先备份并保持应用停写，更新后启动并等待健康 |
| 本地打包 | 普通账号构建 Linux API 与 Web，清理临时缓存，只保留发行包 |
| 版本 | 查看或同步 Cargo/npm 版本；修改后需自行检查并提交 |
| GitHub 发版 | 确认后创建当前版本 tag，原子推送 main 与 tag，触发现有 Actions |

## 目录

```text
release-output/
├── server/v0.1.0/             # Linux API + Web 包、SHA256SUMS、release.json
└── android/                  # 独立 Android APK，不参与 GitHub 构建
```

旧 `android-preview/server` 是安卓联调时对配套服务端包的临时命名，并不是安卓服务端架构。本轮已移动到 `server/v0.1.0`，保持包内容和校验值不变；旧 `release-output/v0.1.0` 若存在则保留为历史产物，不自动选择或覆盖。

新构建包会自带 `piccove.sh`。统一入口安装旧的本地包时会补入运维入口，无需重新编译应用。

## 常用显式命令

菜单会询问路径，不需要记下面所有参数。非交互场景可使用：

```bash
bash piccove.sh build
bash piccove.sh version --set 0.1.1
# 检查版本修改并完成中文 Git 提交后：
bash piccove.sh release --yes

bash piccove.sh install --archive release-output/server/v0.1.0/piccove-v0.1.0-linux-x86_64.tar.gz
bash piccove.sh status
bash piccove.sh health
bash piccove.sh logs
bash piccove.sh restart
bash piccove.sh backup --backup /var/backups/piccove/本次备份目录
bash piccove.sh upgrade --archive /path/to/新版.tar.gz --backup /var/backups/piccove/升级前备份目录
```

源码目录默认操作 `/opt/piccove`；安装目录中的脚本默认操作自身目录。多实例用 `--directory` 指定，不能共享同一个 Compose 项目名。安装时可传 `--project`、`--origin`、`--port`，默认分别为 `piccove-tu`、`https://tu.imggg.com`、`18081`。

## 安全边界和失败处理

- 本地包必须来自可信来源，且旁边有匹配的 `SHA256SUMS`。校验和保证文件一致，不代替来源信任或签名；脚本不下载未知来源，也不 `curl | bash`。
- 安装目录已存在时拒绝覆盖。失败后保留现场，修正原因后在该目录执行 `bash install.sh --resume`。
- 运维检查 Compose 项目是否属于该安装目录，并使用独占锁防止同一入口并发运行。不要同时手工运行 Compose 修改服务。
- 备份目录权限 0700，凭据副本 0600；备份含数据库密码，妥善保管。完整备份才写出 SHA256SUMS，失败产物保留用于排错，不可直接恢复。恢复流程见 [BACKUP.md](BACKUP.md)，暂不提供自动覆盖正式数据的恢复按钮。
- 升级期间不恢复写入；失败时停止 API／网页并保留数据库、图片和备份，不自动回退二进制。升级只接受更高版本；旧 API 忽略私有图片权限，不能直接降级。
- 发版要求 main、干净工作区、版本一致及新 tag。不会自动提交、自动加版本、部署生产或修改 Nginx。GitHub 仍只构建 Linux 服务端和 Web；没有 Android／Windows 构建。
- 该入口不安装 Docker、Rust、Node、系统软件或证书，不修改现有文件权限。DNS、HTTPS 仍按 [域名部署说明](DEPLOY-tu.imggg.com.md) 完成；本机健康正常不代表公网已经上线。
