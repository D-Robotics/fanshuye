# 番薯叶 MVP 轻量威胁模型

## 范围与信任边界

本模型覆盖桌面客户端、REST/WebSocket 边界、模块化服务端、PostgreSQL 事实库和可重建 SQLite 缓存。任务标题、说明、完成定义、成员身份、会话令牌及工作区关系均按敏感数据处理。客户端输入和客户端声明的身份一律不可信；服务端认证会话、逐请求工作区授权和 PostgreSQL 约束才是权限与事实边界。

WebSocket 只是提交后通知通道，不是恢复或授权事实源。桌面 SQLite 只是当前 Windows 用户可读的已确认投影，不能反写服务端；刷新凭据属于操作系统凭据存储边界，不属于缓存边界。

风险按影响和可利用性评为 `Critical / High / Medium / Low`。`CLOSED` 表示初始 High/Critical 风险已有代码和自动化证据；`ACCEPTED` 表示残余风险已降级、明确限制和试点前提，不表示永久豁免。

## 风险与闭环

| 威胁场景                                        | 初始风险 | 已实施控制                                                                                                                                                                                                                  | 自动化证据                                                                                                                                                                                  | 残余风险与状态                                                                |
| ----------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 跨工作区直接对象引用泄露任务                    | Critical | 每个列表、详情、命令、快照、增量和订阅入口查询活跃成员关系；拒绝响应不返回对象存在性或正文                                                                                                                                  | `postgres.integration.test.ts` 的跨工作区 API 用例；`security-runtime.integration.test.ts` 的移除后 API 用例                                                                                | Low — `CLOSED`                                                                |
| 两名成员同时认领，形成重复负责人                | High     | 单事务、任务行锁/条件更新、`expectedVersion` 和唯一负责人字段；冲突返回权威快照                                                                                                                                             | `postgres.integration.test.ts` 使用两个真实数据库连接并验证恰好一个成功                                                                                                                     | Low — `CLOSED`                                                                |
| 两个并发依赖写入共同形成环                      | High     | 工作区图版本写锁、递归可达性检查、事务回滚和数据库约束                                                                                                                                                                      | `postgres.integration.test.ts` 覆盖直接、间接及并发成环                                                                                                                                     | Low — `CLOSED`                                                                |
| WebSocket 劫持、跨站连接或撤权后继续收取事件    | High     | 必须同时提供 `fanshuye.v1` 与唯一 `bearer.<JWT>` 子协议；有 Origin 时必须精确命中允许列表；握手检查未撤销会话和活跃成员；角色变化强制重连，成员移除/登出/会话撤销主动关闭订阅；令牌协议头不进入日志                         | `security.test.ts` 的协议/Origin 拒绝；`event-hub.test.ts` 的会话和成员断连；`security-runtime.integration.test.ts` 的真实 API + WebSocket 角色变化、移除、登出、显式撤销和攻击 Origin 用例 | Low — `CLOSED`                                                                |
| XSS、危险外链和任意远程导航                     | High     | React 文本渲染，不使用不受控 HTML；外链只接受显式 HTTP(S)；Tauri CSP 固定脚本、对象和连接来源                                                                                                                               | `TaskDetailPanel.test.tsx`、`TaskTree.test.tsx`、`security.test.ts` 和 `threat-model.test.ts`                                                                                               | Low — `CLOSED`                                                                |
| 密码、访问令牌、刷新令牌或本地路径进入日志/缓存 | Critical | Argon2 密码哈希；刷新令牌只以 SHA-256 摘要入库并轮换；桌面刷新凭据进入 Windows keyring；请求日志不序列化头、正文或原始查询，错误不序列化动态 message/stack；关联 ID 仅接受 UUID；SQLite 和 Git 忽略规则排除凭据与数据库文件 | `logging.test.ts`、`threat-model.test.ts`、`security-runtime.integration.test.ts`                                                                                                           | Low — `CLOSED`                                                                |
| SQLite 中的任务正文被同机其他主体读取           | High     | 缓存只含已授权显示数据，不含令牌、密码、服务端密钥、outbox 或未确认写入；数据库由 Tauri SQL 插件放入应用数据范围，可删除重建；试点设备必须使用独立 Windows 账户、锁屏和磁盘加密                                             | `cache.test.ts` 的可重建/事务测试；`threat-model.test.ts` 的缓存模式静态守卫                                                                                                                | Medium — `ACCEPTED for MVP`；公开试点前依据任务敏感度决定是否引入数据库级加密 |

High/Critical 初始风险没有未闭环项。唯一保留项是本机账户已被攻破时的任务正文披露；它已降为 Medium，并以受管 Windows 账户、磁盘加密和试点数据分级作为部署前提。缓存中出现任何凭据、离线写队列或跨用户共享路径，都会重新提升为 High 并阻断发布。

## 撤权时序不变量

1. 成员角色变化、成员移除和会话撤销先在 PostgreSQL 事务或会话更新中生效。
2. 提交成功后，进程内 EventHub 删除匹配订阅并以私有关闭码关闭 socket；坏 socket 不得阻止其他连接撤销，也不得把已提交命令变成失败响应。
3. 角色变化使用 `4003` 强制客户端重新握手，从数据库加载新角色；成员移除同样使用 `4003`，后续工作区 API 返回 `403`。
4. 登出和显式会话撤销使用 `4001`；每个后续 REST/WS 请求都重新检查 `sessions.revoked_at`，旧访问令牌立即返回 `401`，不等待 JWT 自然过期。
5. 多实例部署前必须把撤权通知扩展为进程间广播或连接网关；当前闭环只承诺模块化单体的单服务进程部署拓扑。

## 日志与关联 ID 规则

- 日志为 JSON 结构，由 Fastify/Pino 生成；`reqId` 是单次请求的关联键，响应头和安全错误体返回相同 `x-correlation-id`。
- 只接受客户端提供的 UUID 关联 ID，其他值替换为服务端 UUID，避免日志注入和不受控高基数。
- 请求日志仅允许方法和服务端路由模板；禁止原始 URL、查询值、Authorization、WebSocket 子协议和请求正文。
- 错误日志只允许错误类型、受限代码和状态码；禁止动态 message、stack、任务正文、令牌和绝对文件路径。
- 指标标签同样只能使用代码内固定枚举，不能使用用户、工作区、任务或错误正文。

## 验证命令

```powershell
pnpm --filter @fanshuye/server exec vitest run test/security.test.ts test/event-hub.test.ts test/logging.test.ts test/threat-model.test.ts
$env:TEST_DATABASE_URL='postgres://fanshuye:fanshuye@127.0.0.1:5432/fanshuye'
pnpm --filter @fanshuye/server exec vitest run test/security-runtime.integration.test.ts test/postgres.integration.test.ts
```

每次修改认证、成员关系、WebSocket、日志序列化、Tauri CSP、凭据适配器或 SQLite 模式时都必须运行对应回归测试。新增部署拓扑、公共域名、第三方集成或 Agent 数据流时必须重新审查本模型。
