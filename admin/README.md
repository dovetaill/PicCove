# PicCove Web 工作台 (`admin`)

PicCove（图湾）统一前台与管理后台前端工程，基于 **React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + ReUI (Metronic Demo 1)** 构建。

## 本地开发

确保后端 API（默认监听 `http://127.0.0.1:3001`）与测试数据库已启动，然后在非 root 开发账号下执行：

```bash
npm ci
npm run dev
```

Vite 开发服务器默认将 `/api` 与 `/i`（及 `/s` 分享路径）代理至 `http://127.0.0.1:3001`。

## 类型检查与生产构建

```bash
npm run build
```

完整架构、部署与发版说明请参见仓库根目录 [README.md](../README.md) 与 [docs/OPERATIONS.md](../docs/OPERATIONS.md)。
