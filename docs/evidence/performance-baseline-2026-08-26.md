# OpenSpec 10.6 性能基线证据（2026-08-26）

## 结论

通过。基线使用 1,000 个总任务、100 个活跃任务和 999 条边的 6 层三叉依赖 DAG。悬浮树聚合/布局 p95 为 **0.302 ms**；PostgreSQL 影响子图查询 p95 为 **7.170 ms**。返回节点上限和 500 ms 数据库语句超时均由真实查询验证。

## 环境

| 项目       | 值                                                    |
| ---------- | ----------------------------------------------------- |
| 采集时间   | 2026-08-26 18:57:49 +08:00                            |
| 操作系统   | Microsoft Windows 11 企业版 10.0.22631（Build 22631） |
| CPU        | Intel(R) Core(TM) Ultra 9 185H，22 逻辑处理器         |
| 内存       | 31.5 GiB                                              |
| PowerShell | wrapper 5.1.22621.6931；环境采集 shell 7.6.4          |
| Node.js    | v22.23.1                                              |
| pnpm       | 11.19.0                                               |
| Docker     | 29.7.2，build a7dcaa6                                 |
| PostgreSQL | 17.11（`postgres:17-alpine`）                         |
| 时区       | China Standard Time                                   |

## 执行命令

```powershell
docker compose ps
pnpm perf:baseline
docker exec newproject3-postgres-1 psql -U fanshuye -d fanshuye -Atc "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'fanshuye_perf_%';"
```

`pnpm perf:baseline` 于 2026-08-26 18:56 本地运行成功，两个测试文件各 1 项测试通过。

## UI 聚合与布局结果

输入包含 1,000 个任务，其中 100 个状态为 `TODO`、`IN_PROGRESS` 或 `IN_REVIEW` 且未归档；其余 900 个为已归档完成任务。布局每次只生成 15 个可见 SVG 叶片，其余 85 个活跃任务进入叶簇。

测试先预热 200 次，再采集 60 个样本，每个样本执行 50 次完整筛选、确定排序、聚合和布局。

| 指标         |     实测 |       阈值 | 结果 |
| ------------ | -------: | ---------: | ---- |
| p50          | 0.287 ms |          — | 通过 |
| p95          | 0.302 ms |     ≤ 8 ms | 通过 |
| 最大单次均值 | 0.326 ms | < 16.67 ms | 通过 |
| 可见叶片     |       15 |       = 15 | 通过 |
| 聚合任务     |       85 |       = 85 | 通过 |

原始测试输出：

```text
PERF_UI_JSON {"totalTasks":1000,"activeTasks":100,"visibleLeaves":15,"overflowTasks":85,"samples":60,"iterationsPerSample":50,"p50Ms":0.287,"p95Ms":0.302,"maxMs":0.326,"p95ThresholdMs":8,"frameBudgetMs":16.67,"passed":true}
```

## PostgreSQL 依赖查询结果

测试在随机 schema `fanshuye_perf_ebe6f8e8c9ed4ae5b7b8a1e59ef51c83` 中应用完整迁移，创建 1,000 个任务、100 个活跃任务和 999 条 `BLOCKS` 边。三叉 DAG 最深为 6 层，根任务可到达超过配置上限的后续节点。

影响子图预热 3 次后采集 25 个样本。查询仓储配置 `DEPENDENCY_QUERY_MAX_NODES=64`，显式子图请求上限为 50。

| 指标             |                 实测 |                阈值 | 结果 |
| ---------------- | -------------------: | ------------------: | ---- |
| p50              |             6.325 ms |                   — | 通过 |
| p95              |             7.170 ms |            ≤ 250 ms | 通过 |
| 最大值           |             7.828 ms |     < 500 ms 硬超时 | 通过 |
| 配置查询返回节点 |                   64 |                ≤ 64 | 通过 |
| 子图返回节点     | 50，`truncated=true` | ≤ 50 且必须标记截断 | 通过 |

在同一仓储查询事务内读取到 `statement_timeout=500ms`，随后执行 `pg_sleep(2)`。PostgreSQL 在 **501.333 ms** 后返回错误码 **57014**（query canceled），证明限制不是测试端计时器模拟。

原始测试输出：

```text
PERF_POSTGRES_JSON {"postgresVersion":"17.11","totalTasks":1000,"activeTasks":100,"dependencyEdges":999,"dependencyDepth":6,"configuredMaxNodes":64,"returnedConfiguredNodes":64,"subgraphMaxNodes":50,"returnedSubgraphNodes":50,"truncated":true,"samples":25,"p50Ms":6.325,"p95Ms":7.17,"maxMs":7.828,"p95ThresholdMs":250,"statementTimeoutMs":500,"timeoutErrorCode":"57014","timeoutObservedMs":501.333,"isolatedSchema":"fanshuye_perf_ebe6f8e8c9ed4ae5b7b8a1e59ef51c83","passed":true}
PERF_POSTGRES_CLEANUP_JSON {"schema":"fanshuye_perf_ebe6f8e8c9ed4ae5b7b8a1e59ef51c83","removed":true}
```

运行后查询 `pg_namespace` 中 `fanshuye_perf_%` 的数量为 **0**，测试数据已清理。

## 适用范围

该结果是回归基线，不是生产容量承诺。UI 数值覆盖纯数据聚合和确定性 SVG 坐标计算，不包含 Tauri 原生窗口合成、GPU 绘制或真实用户输入延迟；这些仍由 Windows 原生端到端矩阵验证。PostgreSQL 基线覆盖多层影响遍历、最大返回节点数和数据库硬超时，不覆盖未来 Neo4j 投影。
