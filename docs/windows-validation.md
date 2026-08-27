# Windows 原生构建与验收

本手册用于 Windows 11 原生 Tauri 开发、NSIS 打包、签名和发布候选验收。纯 Web UI 启动见根 README，不需要 Rust。

## 构建前置条件

- Node.js 22、pnpm 11，以及已执行 `pnpm install --frozen-lockfile`。
- Rust stable 的 `x86_64-pc-windows-msvc` toolchain。
- Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”、MSVC x64/x86 工具和 Windows 10/11 SDK。请从 Developer PowerShell for VS 2022 构建。
- Microsoft Edge WebView2 Runtime。安装包使用 `downloadBootstrapper`，干净机器安装时还需要访问 WebView2 下载地址。
- 发布签名需要组织管理的 Windows 代码签名证书、私钥访问权限、可信时间戳服务和 Windows SDK `signtool.exe`。私钥不得进入仓库或日志。

仓库根目录的 `.vsconfig` 固定了原生构建所需的 C++ workload、x64/x86 MSVC 工具和 Windows 11 SDK。经授权后，可从微软官方 Build Tools 安装器导入该配置；这是系统级安装，不应由普通项目脚本静默执行：

```powershell
vs_BuildTools.exe --config .vsconfig --passive --wait --norestart
```

在 Developer PowerShell 中记录工具版本和路径；任一必需项缺失都停止原生构建：

```powershell
node --version
pnpm --version
rustc --version
cargo --version
rustup show active-toolchain
where.exe cl.exe
where.exe link.exe
where.exe signtool.exe

Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*' `
  -ErrorAction SilentlyContinue |
  Where-Object { $_.name -match 'WebView2' } |
  Select-Object name, pv
```

也可以运行仓库内只读预检；它会拒绝把 Git 自带的 GNU `link.exe` 误认为 MSVC 链接器：

```powershell
pnpm native:preflight
pnpm native:preflight:signing # 发布签名门禁
```

普通预检同时核对 Node >= 22、pnpm 11 和 `x86_64-pc-windows-msvc` Rust host。签名预检还要求
`WINDOWS_CERT_THUMBPRINT`（40 位十六进制）、HTTPS `WINDOWS_TIMESTAMP_URL` 和
`WINDOWS_EXPECTED_SIGNER_SUBJECT`；预检只验证配置是否完整，不读取或导出证书私钥。

## 原生开发与未签名打包

先按根 README 将 `.env` 导入当前 PowerShell 并启动 PostgreSQL、迁移与服务端。原生开发入口是：

```powershell
pnpm --filter @fanshuye/desktop dev
```

该入口会把 rustup 的用户级 Cargo 目录加入当前子进程，并在 Build Tools 已安装但当前不是 Developer PowerShell 时尝试导入 `VsDevCmd.bat` 环境；不会永久修改系统 `PATH`。

构建发布候选前先通过根级发布门禁，再执行：

```powershell
pnpm --filter @fanshuye/desktop build:native

$installer = Get-ChildItem -LiteralPath 'apps/desktop/src-tauri/target/release/bundle/nsis' `
  -Filter '*.exe' -File |
  Sort-Object LastWriteTime |
  Select-Object -Last 1
if (-not $installer) { throw 'NSIS installer was not produced' }
Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName
```

签名后可用仓库脚本再次独立检查哈希、Authenticode 状态、签名主体和时间戳；若提供预期主体，必须精确匹配：

```powershell
$expectedInstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash
pnpm native:installer:inspect `
  -InstallerPath $installer.FullName `
  -ExpectedSignerSubject $env:WINDOWS_EXPECTED_SIGNER_SUBJECT `
  -ExpectedSha256 $expectedInstallerHash `
  -ExpectedProductName '番薯叶'
```

`native:installer:inspect` 只有在签名有效、可信时间戳存在且所有给定期望值均匹配时才返回成功。
`pnpm build` 只构建 Web 与服务端 JavaScript，不会生成安装包。当前 Tauri 配置只生成 NSIS、采用 per-machine 安装；安装与卸载验证需要管理员权限。不得把未签名产物标记为公开发布候选。

## 签名与产物校验

证书指纹和时间戳 URL 由发布平台以受保护环境变量注入。下面的命令只引用指纹，不导出私钥：

```powershell
if (-not $env:WINDOWS_CERT_THUMBPRINT) { throw 'WINDOWS_CERT_THUMBPRINT is required' }
if (-not $env:WINDOWS_TIMESTAMP_URL) { throw 'WINDOWS_TIMESTAMP_URL is required' }

$installer = Get-ChildItem -LiteralPath 'apps/desktop/src-tauri/target/release/bundle/nsis' `
  -Filter '*.exe' -File |
  Sort-Object LastWriteTime |
  Select-Object -Last 1
if (-not $installer) { throw 'NSIS installer was not produced' }

signtool.exe sign /sha1 $env:WINDOWS_CERT_THUMBPRINT /fd SHA256 `
  /tr $env:WINDOWS_TIMESTAMP_URL /td SHA256 $installer.FullName
signtool.exe verify /pa /v $installer.FullName
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }
Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName
```

签名之后重新记录 SHA-256；分发清单中的哈希必须是最终签名文件的哈希。签名、哈希或时间戳验证失败都阻断发布。

## 发布候选验收矩阵

在与开发机隔离的干净 Windows 11 虚拟机上安装已签名候选，记录 OS build、安装包版本、SHA-256、签名主体、WebView2 版本、显示器、DPI 和每项证据。至少覆盖：

- 单显示器与双显示器。
- 100%、125%、150% 和 200% DPI。
- 主显示器切换、显示器拔插和休眠恢复。
- hover 展开、短暂路过、点击固定、Escape 收起。
- 托盘、全局快捷键、单实例、可选开机启动和正常退出。
- 应用重启后恢复安全会话、托盘、边缘入口和最近一次确认的任务树。
- 在 Windows 凭据管理器中确认固定的番薯叶凭据条目存在；同时复核 localStorage、SQLite、日志和 UI 错误均不含刷新凭据。
- 桌面壳与服务端同时运行时 `/health`、登录和任务树快照均可用。
- 窗口隐藏并常驻至少 30 分钟时记录 CPU、工作集和连接数，确认无持续异常增长。
- 透明置顶窗口及固定侧边面板降级。
- 编辑器保持焦点、全屏应用、隐私模式和勿扰模式。
- 在线、重连、断网缓存、服务恢复和版本冲突。
- 干净安装、从上一已发布版本升级、卸载以及本地缓存保留策略。

侧边面板降级用例必须至少执行一次 `FANSHUYE_SIDE_PANEL=1` 启动，以便在透明合成正常的机器上也能确定性覆盖降级路径；随后清除该环境变量并重新验证透明悬浮模式。

隐藏态资源用例先启动并登录番薯叶，收起并隐藏两个窗口，然后以管理员或能读取进程 TCP 信息的 PowerShell 运行：

```powershell
pnpm native:residency:measure `
  -ProcessName fanshuye-desktop `
  -DurationSeconds 1800 `
  -WarmupSeconds 300 `
  -OutputPath docs/evidence/windows-hidden-residency-local.json
```

默认门槛按整个番薯叶/WebView2 子进程树计算：预热后 30 分钟内平均 CPU 不高于 1%、P95 不高于 3%、工作集净增长不高于 50 MB，且隐藏态不保留已建立 TCP 连接。脚本输出逐次采样和阈值结论；退出码 `7` 表示门槛失败。将输出 JSON 的 SHA-256 填入 `resource.hidden-cpu-memory`，不得用短时自动化测试替代真实常驻测量。

复制证据模板，逐项填入实际截图或录屏路径，并在 `notes` 中写明该用例观察到的行为。路径相对于证据 JSON 所在目录解析；每项还要填写该文件的
`evidenceSha256`。可用 `(Get-FileHash -Algorithm SHA256 -LiteralPath <path>).Hash` 取得哈希。除隐藏态资源用例必须引用测量脚本生成的 JSON 外，验证器只接受具有正确文件签名且达到最低大小的截图或录屏；它还会核对 SHA-256，因而任意文本、伪扩展名文件或记录后被替换的文件不能通过。
同一段录屏可以覆盖多个用例，但每个复用该文件的用例都必须在 `notes` 中写出对应的三段式时间码，例如 `timecode=00:03:17 已验证 Escape 收起`；否则门禁会拒绝该记录。
`executedAt` 必须是带时区的 ISO-8601 时间，`tester` 不能是占位符，`appVersion` 必须与仓库版本一致。

```powershell
Copy-Item docs/evidence/windows-native-e2e-template.json `
  docs/evidence/windows-native-e2e-local.json
pnpm native:e2e:validate `
  -EvidencePath docs/evidence/windows-native-e2e-local.json

Copy-Item docs/evidence/windows-release-template.json `
  docs/evidence/windows-release-local.json
$env:WINDOWS_EXPECTED_SIGNER_SUBJECT = '<由发布负责人提供的完整签名主体>'
pnpm native:release:validate `
  -EvidencePath docs/evidence/windows-release-local.json
```

发布证据的 `installerPath` 必须指向实际已签名安装包，`installerSha256` 必须是该文件的最终哈希。
发布验证器会现场重新计算哈希、读取 Authenticode 签名与时间戳，并把签名主体与受保护环境变量中的外部信任锚精确比较；
还会核对安装包 ProductName、ProductVersion、当前仓库版本和低于当前版本的 `previousVersion`。证据 JSON 内自报
`signatureStatus: Valid` 不能单独使门禁通过。

安装后至少验证一次服务端 `/health` 为 `ok/ready`、登录、快照、正常退出和再次启动。用任务管理器确认退出后没有遗留番薯叶进程；连续启动第二个实例时只能保留一个主实例。断网期间只能读取已有缓存且所有写入口禁用，恢复网络后无需重启即可重新同步。

升级前复制诊断用缓存并记录旧版本；升级后确认配置与约定保留的数据可读。卸载分别验证“保留缓存”和“清除缓存”的既定产品策略，测试结束时从干净虚拟机快照恢复，不能用生产用户或生产服务端做安装测试。

Rust、MSVC/Windows SDK、WebView2、代码签名证书、时间戳服务或干净 Windows 11 验收机属于外部发布前置条件。缺少其中任一项时，可以完成 Web 验证，但不能声称原生安装包、签名或 Windows 矩阵已通过。
