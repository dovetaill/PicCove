# tu.imggg.com 部署记录与安装步骤

## 当前状态

- 本机公网 IPv4：`66.45.226.118`。
- 域名应为 `https://tu.imggg.com`。
- GitHub Actions 只构建 Linux x86_64 服务端及 Web，不构建 Android 或 Windows PC。
- 已新增并加载 `/etc/nginx/conf.d/piccove-tu.imggg.com.conf`，仅匹配这个域名。
- 当前 HTTP 站点返回明确的 503 待配置提示，并预留 ACME 验证目录 `/var/lib/piccove-acme`。这不是程序故障，也不是已经上线。
- 检查时公共 DNS 将 `tu.imggg.com` 指向 `overdue.aliyun.com`（`170.33.12.185`），因此尚未申请证书、开启 HTTPS 或安装程序。
- PicCove 预定监听 `127.0.0.1:18081`；本机 8080 和 18080 已被其他服务占用，请勿覆盖。

## 1. 修正 DNS

在域名服务商控制台检查域名及解析状态。直连部署时删除 `tu` 的冲突 CNAME，添加：

| 类型 | 主机记录 | 值 |
| --- | --- | --- |
| A | tu | 66.45.226.118 |

若存在 AAAA，必须指向这台服务器可访问的 IPv6，否则移除错误记录。使用 CDN 时另行确认源站、HTTPS 和证书方案，不套用直连假设。

```bash
dig @1.1.1.1 tu.imggg.com A +short
dig @8.8.8.8 tu.imggg.com A +short
```

## 2. 安装程序

当前本机已有含安卓私有图片支持的测试发行包。它是本地构建包，不是已发布的 GitHub Release；不要误用旧的 `release-output/v0.1.0` 包。

现在不必逐条解压和启动，在源码目录执行：

```bash
cd /home/wwwroot/piccove
bash piccove.sh
```

选择「1 安装」，默认发行包为 `release-output/server/v0.1.0/piccove-v0.1.0-linux-x86_64.tar.gz`，安装目录 `/opt/piccove`、网站 `https://tu.imggg.com`、端口 `18081`。菜单会校验包、解压、生成配置并启动服务。需要有安装目录和 Docker 访问权限；当前服务器可用 root 执行安装，但源码编译仍须普通开发账号。

旧 `android-preview/server` 已迁出：服务端包与 Android APK 完全独立。此处的现有包仍为原本地构建包，内容与校验值没有改变，不冒充正式 GitHub Release。

需要 Docker Engine、Compose 和 Python 3.11+；发行包安装不需要 Rust 或 Node.js。首次安装拉取基础镜像，生成 `.env` 并启动 PostgreSQL、API 和网页。所有数据库／原图保存在该 Compose 项目的独立卷中。

管理员用户名是 `admin`。在服务器上用编辑器安全打开 `/opt/piccove/.env`，读取 `PICCOVE_ADMIN_PASSWORD`；不要把密码粘贴到公开聊天或日志。HTTPS 完成后登录并修改密码，再清空 `.env` 中的初始化密码值，执行 `sudo docker compose up -d`。

检查：

```bash
cd /opt/piccove
bash piccove.sh status
bash piccove.sh health
bash piccove.sh logs
```

安装失败时保留 `.env`，处理错误后运行 `sudo bash install.sh --resume`，不要重新生成数据库凭据。程序按 HTTPS Origin 配置，因此不能把直接访问本机 HTTP 端口作为浏览器登录验收。

## 3. 证书与正式 Nginx 配置

等待 DNS 正确指向本机且公网 80 端口可达，再通过已有 Certbot 的 **webroot** 方式申请 `tu.imggg.com` 证书，webroot 使用 `/var/lib/piccove-acme`。不要使用自动修改全站配置的 nginx 插件。证书账户、续期和 reload hook 应沿用并核对现有管理方式。

证书成功后，将该域名专用配置替换为下列内容；证书路径必须以实际签发结果为准，不能提前加载不存在的证书。

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name tu.imggg.com;
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/piccove-acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 301 https://tu.imggg.com$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name tu.imggg.com;
    ssl_certificate /etc/letsencrypt/live/tu.imggg.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tu.imggg.com/privkey.pem;
    client_max_body_size 11m;
    location / {
        proxy_pass http://127.0.0.1:18081;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_cache off;
    }
}
```

变更前记录相关配置和运行目录的属主、权限；使用独占目录和非特权身份做隔离检查，显式指定 Nginx 的五种 temp 路径、日志、PID 与锁路径。不要直接用 root 执行生产 `nginx -t/-T`。确认后仅 reload 现有主进程，不重启其他站点或修改其权限。

## 4. 上线验收与日常管理

打开 `https://tu.imggg.com`，按 README 自测清单检查登录、上传、完整原图和 JS/CSS 传输，以及注册开关。安卓 App 的服务器填写同一 HTTPS 地址。

```bash
cd /opt/piccove
bash piccove.sh logs
bash piccove.sh restart
# 停机保留容器与数据：
bash piccove.sh stop
```

不要执行 `docker compose down -v`，它会删数据库与原图。备份、升级和私有照片版本回退限制见 [README](../README.md) 与 [ANDROID.md](ANDROID.md)。

## 本次 Nginx 验证

新站点经 UID/GID `62062:62062` 在独占目录检查，验证时仅把监听端口改为未占用的高端口，五种临时目录、日志、PID、锁全部隔离。生产主进程通过 HUP 平滑加载，worker 仍为 `33:33`。本机 Host 请求完整返回预期 503 文本；尚无运行中的应用，因此没有声称网页／大资源或 HTTPS 已验收。

既有配置、Nginx 临时目录、日志目录与 PID 文件的数值属主、属组、权限、inode、ctime 和扩展属性前后核对：仅 `/etc/nginx/conf.d` 因新增配置文件发生预期 ctime 变化，其余记录一致；未修改既有权限。新增站点配置为 `root:root 0644`，ACME 目录为 `root:root 0755`。现有 Nginx 和其他服务保持运行。
