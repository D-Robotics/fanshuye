# 番薯叶

番薯叶是面向开发团队的 Windows 桌面任务态势工具。一棵番薯树代表团队的一组活跃任务，每片叶子代表一个任务；用户可以在不打开完整任务系统的情况下，直接从桌面观察优先级、状态和阻塞情况。

当前版本重点解决三类问题：任务过多容易遗忘、团队成员看不到进展、多人重复执行同一工作。

## 当前界面

收起态是一棵 `176 × 216` 逻辑像素的透明悬浮任务树：

- 最多直接显示 8 个活跃任务，超出的任务通过 `+N` 入口汇总。
- 任务首先按重要度从高到低排序，相同重要度继续使用稳定的行动等级排序。
- 高重要度任务优先占据更靠外的叶位。
- 每一对兄弟节点固定先分配左叶、再分配右叶，因此左叶优先于右叶。
- 叶子采用参考图式细长尖叶轮廓，沿枝条方向向外生长，不显示负责人头像。
- 点击叶子直接打开对应任务详情；悬停不会弹出遮挡内容的卡片。
- 按住主干上的拖动区域可以移动窗口，重启后保留横纵位置。
- 点击总览入口可以展开完整任务树，按 `Esc` 返回紧凑悬浮状态。

在 200% DPI 下，收起态实际物理尺寸为 `352 × 432` 像素。

## MVP 功能

- Windows 11 优先的 Tauri 2 桌面客户端。
- 任务标题、说明、完成定义、重要度、行动等级和截止时间。
- 唯一负责人、多个协作人、原子任务认领和任务状态流转。
- 人工阻塞、依赖阻塞、逾期和无人认领提示。
- `BLOCKS` 任务依赖 DAG，当前由 PostgreSQL 保存；Neo4j 留作依赖关系规模扩大后的可选演进。
- REST 命令、WebSocket 增量通知和 SQLite 本地只读缓存。
- 版本冲突、幂等命令、审计事件和工作区隔离。
- 隐私模式、全局快捷键、系统托盘和桌面通知。

当前版本暂不包含 Agent 自动调度、自动识别任务进度、Git 平台集成或离线写入。这些能力将在基础任务闭环稳定后接入，现有任务与依赖模型会为 Agent 保留扩展边界。

## 快速预览（免登录）

要求：Node.js 22 和 pnpm 11。

```powershell
pnpm install
$env:VITE_DEMO_MODE='true'
pnpm --filter @fanshuye/desktop dev:web
```

打开 `http://localhost:1420/?window=overlay` 可以预览紧凑任务树；打开 `http://localhost:1420/` 可以查看完整界面。该模式使用本地演示任务，不需要登录、数据库或服务端。

## Windows 原生运行

除 Node.js 和 pnpm 外，还需要：

- Rust stable（MSVC target）
- Visual Studio Build Tools
- MSVC C++ 工具链
- Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime

启动免登录原生开发版本：

```powershell
$env:VITE_DEMO_MODE='true'
pnpm --filter @fanshuye/desktop dev
```

构建 Release 应用和 NSIS 安装包：

```powershell
$env:VITE_DEMO_MODE='true'
pnpm --filter @fanshuye/desktop build:native
```

构建产物位于：

```text
apps/desktop/src-tauri/target/release/fanshuye-desktop.exe
apps/desktop/src-tauri/target/release/bundle/nsis/番薯叶_<version>_x64-setup.exe
```

Windows 工具链检查、安装升级、DPI 和签名流程见 [`docs/windows-validation.md`](docs/windows-validation.md)。

## 连接本地服务端

真实协作模式需要 Docker Desktop 或可访问的 PostgreSQL 17。根 `.env` 是配置模板的工作副本，Node 服务不会自动读取它。

```powershell
Copy-Item .env.example .env
# 修改 DATABASE_URL、SESSION_SECRET 等本地配置。

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

在另一个已导入同一 `.env` 的 PowerShell 窗口启动客户端：

```powershell
$env:VITE_DEMO_MODE='false'
pnpm --filter @fanshuye/desktop dev
```

服务端健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:4310/health
```

正常结果应包含 `status: "ok"` 和 `database: "ready"`。不要让开发迁移或种子连接生产数据库；服务端配置见 [`apps/server/.env.example`](apps/server/.env.example)，部署流程见 [`docs/operations.md`](docs/operations.md)。

## 项目结构

```text
apps/
  desktop/                 React + Tauri Windows 桌面客户端
    src-tauri/             Rust 原生窗口、托盘、快捷键和持久化
  server/                  TypeScript 模块化单体服务端
packages/
  contracts/               API 和事件契约
  domain/                  任务状态、优先级和依赖规则
  ui/                      任务树、番薯叶悬浮树和表单组件
openspec/changes/           产品变更规格、设计和执行清单
docs/                      架构、运维和 Windows 验证文档
```

紧凑二叉任务树的实现位于 [`packages/ui/src/components/TaskPlantOverlay.tsx`](packages/ui/src/components/TaskPlantOverlay.tsx)，对应规格位于 [`openspec/changes/compact-draggable-binary-task-tree/`](openspec/changes/compact-draggable-binary-task-tree/)。

## 验证

完整 JavaScript/TypeScript 质量门禁：

```powershell
pnpm check
```

它会执行格式检查、Lint、类型检查、单元测试、前端和服务端构建、服务端产物检查及 MVP 范围检查。

在已加载 MSVC 环境的终端中执行 Rust 验证：

```powershell
pnpm rust:check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

验证当前任务树规格：

```powershell
openspec validate compact-draggable-binary-task-tree --strict
```

架构细节见 [`docs/architecture.md`](docs/architecture.md)，服务端测试说明见 [`apps/server/README.md`](apps/server/README.md)。

## 开发阶段说明

项目当前处于功能 MVP 阶段，优先打磨任务创建、认领、协作、状态流转、阻塞、依赖和任务树反馈。完整多显示器/DPI 实机矩阵、可信代码签名和正式真人计时研究属于扩大试点或公开发布前的发布门槛，不阻塞当前功能迭代。
