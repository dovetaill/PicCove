# tu.jpggg.com 部署与使用

## 当前部署

- 访问地址：**https://tu.jpggg.com**，HTTP 自动跳转 HTTPS。
- A 记录指向本机 `66.45.226.118`；原先的 `tu.imggg.com` 是错误域名，已更正。
- 程序安装在 `/opt/piccove`，Compose 项目名 `piccove-tu`，仅监听 `127.0.0.1:18081`。
- PostgreSQL、API、Web 已启动并通过健康检查；数据库和原图保存在该项目的独立 Docker 卷中。
- 使用 GitHub Release 更新；实际版本记录在 `/opt/piccove/release.json`，禁止回退到不支持私有图片或二步验证的旧包。
- GitHub Actions 仅构建 Linux 服务端和 Web，不构建 Android 或 Windows。

## 首次使用

打开网站，管理员用户名为 `admin`。在服务器上用编辑器打开 `/opt/piccove/.env`，查看 `PICCOVE_ADMIN_PASSWORD` 初始密码；此文件权限为 `root:root 0600`，不要公开内容。

登录后修改密码。随后可清空 `.env` 中的初始化密码值，并在 `/opt/piccove` 执行 `docker compose up -d`；不要改动数据库密码。普通用户注册默认关闭，可由管理员开启。

Android App 的服务器地址也填写 `https://tu.jpggg.com`。

## 安装与日常运维

本机已经安装完成，不需要重复安装。打开运维菜单：

```bash
cd /opt/piccove
bash piccove.sh
```

菜单支持状态、日志、健康检查、备份、升级、启动、停止及重启。也可以使用：

```bash
bash piccove.sh status
bash piccove.sh health
bash piccove.sh logs
```

新服务器安装需要 Docker Engine、Compose、Buildx、curl 和 sha256sum，无需 Python、Rust 或 Node.js。使用 [GitHub Release 一键安装命令](OPERATIONS.md)，指定 `--origin https://tu.jpggg.com`；DNS、Nginx 和证书仍需单独配置。安装后通过 Rust `piccovectl` 管理。

备份、升级和发版说明见 [运维文档](OPERATIONS.md)。不要运行 `docker compose down -v`，该命令会删除数据库和原图。

## Nginx 与证书

- 站点配置：`/etc/nginx/conf.d/piccove-tu.jpggg.com.conf`，`root:root 0644`。
- ACME webroot：`/var/lib/piccove-acme`，`root:root 0755`。
- 证书：`/etc/piccove/letsencrypt/live/tu.jpggg.com/`，首次签发证书到期日为 2027-01-21。
- 独立续期任务：`piccove-cert-renew.timer`，每天检查两次，成功续期后向已核对可执行文件的 Nginx 主进程发送 HUP。
- 续期配置、重载脚本：`/etc/piccove/certbot.ini`、`/etc/piccove/reload-nginx.py`；日志目录：`/var/log/piccove-certbot`；工作目录：`/var/lib/piccove-certbot`。

证书使用独立配置目录和续期任务，禁用全局目录 hooks，避免运行既有全局 hook 中的 root `nginx -t`，也不修改其他站点的续期方式。

```bash
systemctl status piccove-cert-renew.timer
journalctl -u piccove-cert-renew.service
```

不要直接以 root 执行生产 `nginx -t/-T`：这些命令会初始化资源。配置验证应在非特权身份和独占目录执行，隔离五类临时目录、日志、PID、锁与证书测试副本，再平滑重载已确认的生产主进程。

## 本次验收

- 域名 HTTPS 证书验证、首页、API 健康检查通过；HTTP 返回 301 跳转。
- JS（458290 字节）和 CSS（168485 字节）经 HTTPS 完整下载，与安装文件逐字节一致。
- 管理员登录、认证资料读取和 Secure Cookie 检查通过；测试会话已注销。注册关闭、私有图片能力开启。
- Nginx 配置使用 UID/GID `62064:62064` 在独占目录验证；测试目录与证书副本已移除。
- 既有 Nginx 配置、临时目录、日志目录和 PID 文件的属主、属组、权限、inode、扩展属性保持一致。仅本站配置因修改、重命名及其父目录发生预期 ctime 变化；未修改既有生产权限。`.env` 修改域名后仍保持原属主、权限与 inode。
- 自动续期服务执行成功，本次证书未到续期时间，没有强制重复签发。本次未重复图片上传、Android 真机或浏览器交互测试。
