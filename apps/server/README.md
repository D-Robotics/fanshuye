# 番薯叶服务端

这是 PostgreSQL 单一事实源上的 TypeScript 模块化单体。它提供身份与会话、团队工作区、任务语义命令、依赖 DAG、追加审计、快照/增量同步和经过授权的 WebSocket 通知。

## 本地启动

在仓库根目录启动 `compose.yaml` 中的 PostgreSQL，并把配置导出到当前进程。服务端不会自动读取根 `.env`；仅复制文件不足以启动。下面的导入片段适用于仓库提供的简单 `KEY=VALUE` 示例格式，不要用它解析含引号、多行值或命令替换的任意文件：

```powershell
Copy-Item .env.example .env
# 修改 .env 后，将它导入当前 PowerShell；每个新窗口都要重新执行。
Get-Content -LiteralPath .env |
  Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
  ForEach-Object {
    $key, $value = $_ -split '=', 2
    Set-Item -LiteralPath "Env:$key" -Value $value
  }

docker compose up -d --wait postgres
pnpm db:migrate
pnpm db:seed
pnpm --filter @fanshuye/server dev
```

`GET /health` 同时检查进程和数据库。开发种子包含无人负责、进行中、待评审、人工阻塞、依赖阻塞、逾期及完成任务。种子仅允许在非生产环境运行。

`DATABASE_URL` 和至少 32 字符的 `SESSION_SECRET` 是必需配置。生产平台应直接注入环境变量和密钥，不应依赖仓库中的 `.env`；`NODE_ENV=production` 要求 PostgreSQL 提供可由系统信任链验证的 TLS 证书。默认 Compose 数据库不提供 TLS，只用于开发和测试。

配置独立的 32 字符以上 `METRICS_TOKEN` 后，监控系统可以携带
`Authorization: Bearer <METRICS_TOKEN>` 抓取 `GET /internal/metrics`。未配置令牌时该端点返回
404；它不接受用户登录令牌或 URL 查询参数中的凭据。指标只有固定的结果、冲突类型和依赖查询类型标签，
不包含用户、工作区、任务、命令 ID、URL 或错误文本。

## 一致性边界

- 每个写命令包含 UUID `commandId`；现有任务修改还包含 `expectedVersion`。
- `processed_commands` 重放已提交结果；失败命令不写成功审计。
- 认领使用负责人、状态和版本条件更新；负责人、状态、版本、事件及工作区游标同事务提交。
- 添加依赖先锁定工作区图版本，再以递归 CTE 检查可达性；查询设置超时和最大节点数。
- WebSocket 只做提交后的低延迟通知，断线恢复使用增量事件或完整快照。
- WebView 客户端用 `fanshuye.v1` 和 `bearer.<access-token>` 两个 WebSocket 子协议完成握手鉴权；服务端日志会脱敏该请求头。
- PostgreSQL 是任务和依赖的唯一写入事实源。MVP 没有 Agent、自动进度、Git 平台连接、Neo4j、消息队列或离线写入。

## 测试

```powershell
pnpm --filter @fanshuye/server typecheck
pnpm --filter @fanshuye/server test:run
pnpm --filter @fanshuye/server build
```

真实 PostgreSQL 套件会在测试库中并行创建并清理唯一 schema。测试库必须与开发/生产库隔离，名称必须明确包含 `test`，并预先把 `pgcrypto` 与 `citext` 扩展安装到 `public`；否则并行 schema 可能看不到另一个 schema 中安装的 `citext` 类型。本地 Compose 可按下列方式创建一次性数据库并保证清理：

```powershell
$testDatabase = "fanshuye_test_$([guid]::NewGuid().ToString('N'))"
docker compose exec -T postgres createdb -U fanshuye $testDatabase
try {
  docker compose exec -T postgres psql -U fanshuye -d $testDatabase -v ON_ERROR_STOP=1 -c `
    "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;"
  $env:TEST_DATABASE_URL = "postgres://fanshuye:fanshuye@127.0.0.1:5432/$testDatabase"
  pnpm --filter @fanshuye/server test:postgres
} finally {
  Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
  docker compose exec -T postgres dropdb --if-exists --force -U fanshuye $testDatabase
}
```

不要将生产数据库地址用于 `TEST_DATABASE_URL`。若使用托管 PostgreSQL，先由数据库管理员在专用测试库预配扩展；不要为了运行测试提升应用账号的生产权限。
