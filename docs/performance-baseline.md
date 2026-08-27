# 性能基线

OpenSpec 10.6 使用两个可重复执行的测试，确保悬浮树只处理聚合后的可见叶片，并确保 PostgreSQL 依赖遍历不会无界增长。

## 数据规模与通过阈值

| 检查                | 固定数据                                              | 通过阈值                                                       |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| UI 聚合与 SVG 布局  | 1,000 个总任务、100 个活跃任务、最多 15 个可见叶片    | p95 ≤ 8 ms，单样本最大值 < 16.67 ms                            |
| PostgreSQL 影响子图 | 1,000 个任务、100 个活跃任务、999 条边和 6 层三叉 DAG | p95 ≤ 250 ms；子图最多 50 个节点；配置查询最多 64 个节点       |
| PostgreSQL 超时保护 | 同一仓储设置 500 ms `statement_timeout`               | `pg_sleep(2)` 被 PostgreSQL 以 `57014` 取消，且不超过 1,500 ms |

这些阈值是 MVP 的回归警戒线，不等同于生产容量承诺。UI p95 留出超过一半的 60 Hz 帧预算给 React 提交、绘制和桌面合成；依赖查询阈值低于服务端 500 ms 的硬超时。

## 执行

先启动本地 PostgreSQL，然后运行：

```powershell
docker compose up -d postgres
pnpm db:migrate
pnpm perf:baseline
```

默认使用本地 Compose 地址 `postgresql://fanshuye:fanshuye@127.0.0.1:5432/fanshuye`。也可以显式指定隔离测试实例：

```powershell
$env:PERF_DATABASE_URL = 'postgresql://user:password@127.0.0.1:5432/fanshuye_test'
pnpm perf:baseline
```

脚本默认拒绝远程数据库。只有明确提供专用测试实例时，才可设置 `PERF_ALLOW_REMOTE_DATABASE=1`。

## 隔离与清理

PostgreSQL 测试为每次运行创建 `fanshuye_perf_<随机 UUID>` schema，在该 schema 内应用完整迁移并生成测试数据。测试结束（包括断言失败）会关闭 scoped pool、执行 `DROP SCHEMA ... CASCADE`，再用 `to_regnamespace` 验证 schema 已删除。输出中的 `PERF_POSTGRES_CLEANUP_JSON` 是清理证据。

测试不会写入 `public` 业务表。若进程被操作系统强制终止，可用下列只读查询查找遗留 schema，再由数据库管理员确认并清理：

```sql
SELECT nspname FROM pg_namespace WHERE nspname LIKE 'fanshuye_perf_%';
```

## 输出与复核

两项测试分别输出单行 `PERF_UI_JSON` 与 `PERF_POSTGRES_JSON`，包含输入规模、样本数、p50、p95、最大耗时、阈值和限制命中结果。将一次正式运行的原始数值、机器信息和命令保存到 `docs/evidence/performance-baseline-YYYY-MM-DD.md`，用于后续版本对比。
