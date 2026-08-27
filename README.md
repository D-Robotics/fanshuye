# 番薯叶

番薯叶是面向开发团队的桌面任务态势工具。一棵番薯树代表团队的活跃任务；叶片的位置表达行动等级，大小表达重要度，轮廓与图标表达认领、工作流和阻塞状态。负责人不会以头像常驻在叶片上，而是在悬停卡片和详情中以文字显示。

## MVP 范围

- Windows 11 优先的 Tauri 2 桌面客户端。
- TypeScript 模块化单体服务端和 PostgreSQL 权威数据源。
- 人工任务状态、唯一负责人、多个协作人和原子认领。
- `BLOCKS` 任务依赖 DAG；Neo4j 不属于 MVP。
- REST 命令、WebSocket 增量通知和 SQLite 只读缓存。
- 版本冲突、幂等命令、审计事件和工作区隔离。
- 不包含 Agent、自动进度、Git 集成或离线写入。

## 本地开发

要求：Node.js 22、pnpm 11，以及 Docker Desktop 或可访问的 PostgreSQL 17。只有原生桌面开发和打包需要 Rust stable、MSVC 与 Windows SDK；纯 Web UI 不需要 Rust。

根 `.env` 是配置模板的工作副本，Node 服务不会自动读取它。首次启动在仓库根目录执行：

```powershell
Copy-Item .env.example .env
# 按本机情况修改 .env，至少替换 DATABASE_URL 与 SESSION_SECRET。
Get-Content -LiteralPath .env |
  Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
  ForEach-Object {
    $key, $value = $_ -split '=', 2
    Set-Item -LiteralPath "Env:$key" -Value $value
  }

docker compose up -d --wait postgres
pnpm install
pnpm db:migrate
pnpm db:seed
```

每个新的 PowerShell 窗口都要重新导入 `.env`。在第一个已导入配置的窗口启动服务端：

```powershell
pnpm --filter @fanshuye/server dev
```

在第二个窗口重新执行上面的 `Get-Content ... ForEach-Object` 配置导入片段，再启动纯 Web UI：

```powershell
pnpm --filter @fanshuye/desktop dev:web
```

打开 `http://localhost:1420/`；`Invoke-RestMethod http://127.0.0.1:4310/health` 应返回 `status: "ok"` 和 `database: "ready"`。根命令 `pnpm dev` 会启动原生 Tauri，而不是纯 Web UI，因此需要 Rust、MSVC、Windows SDK 和 WebView2 环境。原生开发使用：

```powershell
pnpm --filter @fanshuye/desktop dev
```

不要让开发迁移或种子连接生产数据库。`NODE_ENV=production` 会启用 PostgreSQL TLS 证书校验；默认本地 Compose PostgreSQL 不提供 TLS，不能用来模拟生产数据库。服务端完整配置项见 [`apps/server/.env.example`](apps/server/.env.example)，运维与部署流程见 [`docs/operations.md`](docs/operations.md)。

## 验证

```powershell
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
pnpm verify:server-bundle
pnpm scope:check
openspec validate build-fanshuye-desktop-mvp --type change --strict
```

`pnpm build` 构建 Web UI 与服务端 JavaScript；它不构建 Windows 安装包。真实 PostgreSQL 集成测试的隔离库准备方式见 [`apps/server/README.md`](apps/server/README.md)，Windows 原生开发、打包、签名与验收见 [`docs/windows-validation.md`](docs/windows-validation.md)。任何一项命令失败都应视为发布阻断。

架构与运维细节见 [docs/architecture.md](docs/architecture.md) 和 [docs/operations.md](docs/operations.md)。规范源位于 `openspec/changes/build-fanshuye-desktop-mvp/`。
