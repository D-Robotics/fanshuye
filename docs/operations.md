# 运维手册

## 配置与发布

根 `.env` 只用于本地开发，而且不会被服务端自动读取。生产环境必须由部署平台直接注入 `.env.example` 和 `apps/server/.env.example` 中的配置；至少为 `DATABASE_URL`、`SESSION_SECRET`、`ALLOWED_ORIGINS` 和独立的 `METRICS_TOKEN` 提供环境专属值。密钥不得进入镜像、安装包、命令行参数或日志。`NODE_ENV=production` 会强制 PostgreSQL TLS 证书校验，生产数据库必须提供受系统信任链验证的证书；默认本地 Compose 数据库不提供 TLS。

### 发布门禁

在干净检出的预发布工作区执行：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
pnpm verify:server-bundle
pnpm scope:check
openspec validate build-fanshuye-desktop-mvp --type change --strict

# 必须验证构建产物本身，而不只是开发入口。
pnpm --filter @fanshuye/server start
```

最后一条命令需要有效的服务端环境变量和可访问的数据库，应由进程管理器保持运行，再从另一终端执行下面的健康与认证冒烟。任何静态检查、测试、构建、产物启动或冒烟失败都阻断发布；不得用 `tsx watch` 代替构建产物验证。

### 服务端优先发布

1. 发布前创建并校验 PostgreSQL custom-format 备份，并在隔离恢复库完成最近一次恢复演练。
2. 在预发布环境使用与候选服务端相同的环境变量执行 `pnpm db:migrate`；迁移必须向后兼容。生产环境不运行 `pnpm db:seed`。
3. 部署包含锁文件、生产依赖与 `apps/server/dist` 的候选版本，以进程管理器执行 `pnpm --filter @fanshuye/server start`，并配置正常退出、重启和日志采集。
4. 验证 `GET /health` 返回 `status: "ok"` 和 `database: "ready"`。当前服务没有 `/ready` 路由。
5. 使用专用、最小权限、已验证邮箱的测试账号读取工作区快照，核对 `schemaVersion` 和核心读路径；随后注销测试会话。
6. 服务端 API 和同步事件至少兼容前一个桌面发布周期；服务端冒烟通过后，才发布依赖新能力的桌面客户端。需要删除旧字段时，先经过一个完整客户端发布周期。
7. 生产环境不自动执行破坏性 down migration；回滚优先回退应用、关闭新入口，并从隔离恢复库验证备份后再决定数据恢复。

健康、登录与快照冒烟示例（不要输出 `$login`、令牌或密码）：

```powershell
$serviceUrl = ($env:SMOKE_SERVICE_URL).TrimEnd('/')
$health = Invoke-RestMethod -Method Get -Uri "$serviceUrl/health"
if ($health.status -ne 'ok' -or $health.database -ne 'ready') {
  throw "Service health check failed"
}

$login = Invoke-RestMethod -Method Post -Uri "$serviceUrl/v1/auth/login" `
  -ContentType 'application/json' `
  -Body (@{ email = $env:SMOKE_EMAIL; password = $env:SMOKE_PASSWORD } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
try {
  $workspaces = Invoke-RestMethod -Method Get -Uri "$serviceUrl/v1/workspaces" -Headers $headers
  if ($workspaces.workspaces.Count -lt 1) { throw 'Smoke account has no workspace' }
  $workspaceId = $workspaces.workspaces[0].id
  $snapshot = Invoke-RestMethod -Method Get `
    -Uri "$serviceUrl/v1/workspaces/$workspaceId/sync/snapshot" -Headers $headers
  if ($snapshot.schemaVersion -ne [int]$env:EXPECTED_SCHEMA_VERSION) {
    throw "Unexpected snapshot schema version"
  }
} finally {
  Invoke-WebRequest -Method Post -Uri "$serviceUrl/v1/auth/logout" -Headers $headers `
    -ContentType 'application/json' -Body '{}' | Out-Null
}
```

桌面安装包构建、签名、产物哈希和 Windows 验收见 [Windows 原生验收矩阵](./windows-validation.md)。

## 备份

生产备份示例（不要把含凭据的数据库 URL 写入日志）：

```powershell
$backupFile = ".\fanshuye-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
pg_dump --format=custom --no-owner --no-privileges --file $backupFile --dbname $env:DATABASE_URL
pg_restore --list $backupFile | Select-Object -First 20
Get-FileHash -Algorithm SHA256 $backupFile
```

备份成功必须同时满足：`pg_dump` 返回零、`pg_restore --list` 可读、归档哈希已记录且备份被复制到独立故障域。推荐结合托管 PostgreSQL 的时间点恢复，并记录最近一次成功演练的恢复时间目标和数据恢复点目标。

本地 Compose 可执行演练不依赖宿主机安装 PostgreSQL 客户端：

```powershell
docker compose up -d --wait postgres
.\scripts\postgres-backup-restore-drill.ps1
```

脚本只创建名称带 `fanshuye_drill_` 的唯一临时数据库，使用 custom-format `pg_dump`/`pg_restore`，比较源库和恢复库的数据指纹，最后删除临时数据库和容器内归档。名称碰撞时脚本拒绝运行，不会覆盖既有数据库。2026-08-26 的实际演练记录见 [PostgreSQL 备份恢复演练证据](./evidence/postgres-backup-restore-drill-2026-08-26.md)。

## 恢复

1. 创建全新的隔离数据库，禁止直接覆盖在线生产库。
2. 用 `pg_restore --exit-on-error --no-owner --no-privileges --dbname <隔离库> <归档>` 恢复。
3. 运行数据库一致性检查和应用迁移状态检查，比较工作区、成员、任务、依赖、事件的数量及关键数据指纹。
4. 让候选服务端连接隔离恢复库，验证 `GET /health`、登录、快照、任务命令和增量恢复；不得让验证流量写入生产库。
5. 只有恢复内容与备份清单一致且应用冒烟测试通过后，才制定切流方案；记录恢复耗时、备份时间点、归档哈希和审批人。

## 故障排查

- 配置报告 `DATABASE_URL` 或 `SESSION_SECRET` 未定义：根 `.env` 没有自动加载；按 README 将受信任的简单 `KEY=VALUE` 文件导入当前 PowerShell，或由部署平台直接注入变量。
- 生产环境报告 PostgreSQL 不支持 SSL 或证书校验失败：不要关闭证书校验；确认连接的是启用 TLS 且证书链受信任的生产数据库。本地 Compose 冒烟使用 `NODE_ENV=development`。
- `/health` 返回 503：先用数据库客户端执行 `SELECT 1`，再检查 `DATABASE_URL`、DNS、防火墙、TLS、连接数和迁移状态；不要继续发布桌面端。
- 端口被占用：执行 `Get-NetTCPConnection -State Listen -LocalPort 4310` 确认占用进程，修改环境专属 `PORT`，并同步更新允许来源及客户端 API/WS URL；不要直接终止未知进程。
- 迁移报告 `citext`/`pgcrypto` 不存在或权限不足：让数据库管理员在目标数据库预配扩展，确认应用账号可使用但不必拥有生产超级用户权限。测试库的隔离步骤见服务端 README。
- 构建成功但 `pnpm --filter @fanshuye/server start` 报模块缺失：候选产物不完整，检查 `apps/server/dist`、锁文件和生产依赖，重新构建并阻断发布；不得回退为开发 watcher。
- Tauri 报 `cargo metadata`、链接器或 SDK 缺失：按 Windows 验收手册安装并验证 Rust MSVC toolchain、Visual Studio C++ Build Tools、Windows SDK 和 WebView2，再重开 Developer PowerShell。
- 命令失败：按关联 ID 检查权限、版本冲突和幂等结果。
- 实时不同步：检查 WebSocket、客户端游标和增量接口；不得直接清空服务端事件。
- 本地缓存损坏：保留诊断副本并重建 SQLite 投影，不能把缓存写回服务端。
- 依赖查询超时：检查图规模和递归上限；MVP 不临时切换为 Neo4j 双写。

## 指标与告警

为监控系统配置独立随机的 `METRICS_TOKEN`，通过
`Authorization: Bearer <METRICS_TOKEN>` 抓取 `GET /internal/metrics`。未配置时端点关闭并返回
404；令牌不得复用用户会话、出现在 URL 或写入日志。指标为进程内 Prometheus 文本格式，重启后计数归零，
多实例部署时应由监控系统按实例抓取并聚合。

- `fanshuye_commands_total` 和 `fanshuye_command_duration_seconds`：所有 `/v1` HTTP 写请求的成功、失败与延迟。
- `fanshuye_conflicts_total`：只按 `VERSION_CONFLICT`、`CLAIM_CONFLICT` 两个固定错误码计数。
- `fanshuye_sync_snapshot_required_total`：游标过旧或超前导致的 `SNAPSHOT_REQUIRED`。
- `fanshuye_sync_snapshot_requests_total`：通过工作区授权后的完整快照重建请求。
- `fanshuye_websocket_connections`：当前进程已授权在线连接数。
- `fanshuye_dependency_query_duration_seconds`：按固定查询类型与成功/失败统计依赖读延迟。

建议先对命令失败率、版本/认领冲突突增、`SNAPSHOT_REQUIRED` 持续增长、依赖查询 P95 接近
`DEPENDENCY_QUERY_TIMEOUT_MS` 以及在线连接异常归零告警。所有标签都是有限枚举，禁止添加工作区、用户、
任务、命令 ID、原始 URL、外部引用或错误消息等高基数或敏感字段。
