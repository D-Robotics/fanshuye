# 架构边界

## 运行时

```text
Tauri 桌面端
  ├─ overlay 悬浮任务树
  ├─ main 列表与详情
  ├─ 同步控制器
  └─ SQLite 可重建只读缓存
          │ REST + WebSocket
          ▼
TypeScript 模块化单体
  ├─ identity
  ├─ workspace
  ├─ task
  ├─ dependency
  ├─ sync
  └─ audit
          │
          ▼
PostgreSQL 权威事实源
```

服务端模块不能跨边界直接修改其他模块的数据表。客户端共享协议和显示枚举，但权限、状态机、任务版本、认领和依赖 DAG 规则必须由服务端重新验证。

## 数据一致性

- 每个写命令包含 `commandId`；针对现有任务的命令包含 `expectedVersion`。
- 状态表、工作区序号和审计事件在一个 PostgreSQL 事务中提交。
- WebSocket 只是低延迟通知；断线后通过增量游标或完整快照恢复。
- SQLite 只存服务端确认数据，没有 outbox，也不能反向覆盖服务端。
- PostgreSQL 是任务与依赖的唯一写入事实源。

## 扩展边界

- `DependencyCommandPort` 和 `DependencyQueryPort` 隔离图查询实现。
- Neo4j 只有在实测需要复杂影响分析时才可作为事件驱动的只读投影，禁止同步双写。
- 未来 Agent 只能生成建议；人接受后仍调用普通任务命令。
- 外部引用只保存安全链接，不代表已经接入 Git 或读取外部内容。
