# PilotMeter

GitHub Copilot CLI 本地用量监控工具：独立终端状态提示、可选原生状态栏，以及按会话查看消耗的浏览器页面。Node.js + SQLite，无独立云服务，无 Electron。

**当前为 `0.1.0-preview.5` 预览版，尚未公开发布 npm。** 默认保存原始 nano AIU，官方月度额度保持“未确认”；真实订阅、`/usage` 和官方页面对账是独立发布门槛，合成测试不能替代。

## 安装与开始使用

Copilot CLI 由用户独立安装、登录。采集分类和状态栏配置当前仅验证 `1.0.88` 规则，其他版本保持待分类。

### Windows 单 EXE

Windows 10/11 x64 可使用 [Releases](https://github.com/Xiejiayun/PilotMeter/releases) 中的 `PilotMeter-0.1.0-preview.5-win-x64.exe`，无需安装 Node.js 或 npm。启动器使用 Windows 自带的 .NET Framework 4.x，无需安装额外 .NET，不要求管理员权限，也不修改 PATH。

双击 EXE 会启动后台服务并打开本地页面，等同于 `start --background --open`。在 PowerShell 中也能使用完整命令：

```powershell
.\PilotMeter-0.1.0-preview.5-win-x64.exe doctor
.\PilotMeter-0.1.0-preview.5-win-x64.exe run -- --no-auto-update

# 另一个终端或分屏
.\PilotMeter-0.1.0-preview.5-win-x64.exe watch
.\PilotMeter-0.1.0-preview.5-win-x64.exe stop
```

首次运行会将内嵌 Node 和应用解压到 `%LOCALAPPDATA%\PilotMeter\runtime\<版本>-<载荷哈希前16位>`，账本仍保存在 `%LOCALAPPDATA%\PilotMeter`。升级前先 `stop`；已配置的 statusline 引用此稳定缓存，不能随意删除。下载校验、缓存与源码构建说明见 [Windows EXE 指南](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/windows-exe.md)。

### npm 安装

npm 方式需要 Node.js **24.14+**。当前尚未公开发布 npm，可从源码构建并安装本地包：

```powershell
npm ci
npm test
npm pack
npm install -g ./pilotmeter-0.1.0-preview.5.tgz

pilotmeter doctor
pilotmeter run -- --no-auto-update

# 另一个终端或分屏
pilotmeter watch
```

`run` 保留 Copilot 的参数、stdio 和退出码，不向 Copilot TUI 持续插入输出。`watch` 中按 `o` 打开页面、`q` 退出观察，后台服务继续运行。非 TTY 输出一次状态后结束。支持的终端显示 OSC 8 链接，同时保留普通 URL 和 `pilotmeter open`。

Windows npm 全局安装目录不要包含 `&`：npm 11.9.0 自身生成的 `.cmd` 会在 PilotMeter 启动前失败。中文、空格、括号和数据目录中的 `&` 已通过验证。详见[安装验收记录](docs/npm-package-contents.md)。

## 命令

| 命令 | 用途 |
| --- | --- |
| `doctor` | 只读检查运行时、Copilot、终端、服务和状态栏配置覆盖 |
| `start [--background] [--open]` | 前台或后台启动 loopback 服务 |
| `run [--replace-telemetry] [--source-label name] -- <args>` | 为本次 Copilot 子进程配置本地遥测 |
| `watch` / `status [--json]` | 持续观察或输出一次状态 |
| `statusline` | 只读本地快照，stdout 一行，不连接 GitHub |
| `open` / `stop` | 打开页面 / 正常停止自己的服务 |
| `init --statusline [--replace]` | 备份并最小修改 Copilot 的 JSONC 设置 |
| `init --restore-statusline` | 逐字段恢复仍属于 PilotMeter 的设置 |
| `config set budget.monthlyCredits 1500` | 设置本机记录范围的自定义预算；`null` 清除 |
| `config set retention.days 90` | 显式启用 90 天明细保留策略并立即清理；默认关闭，`null` 停止后续清理 |
| `import <file> [--source-label name]` | 导入受支持的 OTLP traces JSONL，支持增量与重放 |
| `demo [--open]` | 在独立 `demo` 子目录启动明显标注的虚构数据 |
| `account connect --organization name` | 绑定组织付费主体 |
| `account connect --enterprise slug` | 绑定企业付费主体 |
| `account connect --user login --direct-billing` | 显式确认个人直付后绑定个人主体 |
| `account refresh` / `account disconnect` | 刷新账单 / 断开绑定，保留本地记录 |
| `account import-quota <file>` | 导入只读 quota 数据及完整核验证据；未验证不会开启官方比例 |
| `unit verify --cli-version 1.0.88 --evidence "实际核对说明"` | 在真实 `/usage` 对账后记录单位换算证据 |
| `unit clear` | 撤销单位验证，恢复原始单位展示 |
| `reconcile status [--period YYYY-MM] [--json]` | 查看所选 UTC 月的对账结果及无法比较的原因 |
| `reconcile inspect [--period YYYY-MM] [--output file.json]` | 检查当前范围并生成待核验模板；不覆盖已有文件 |
| `reconcile verify <file>` / `reconcile clear [--period YYYY-MM]` | 校验证据 / 撤销该月证据；不修改调用金额 |

所有命令均可在命令名前使用 `--data-dir <目录>`。可以用 `PILOTMETER_COPILOT_BIN` 指定独立安装的 Copilot 入口。已有 exporter 时默认报告冲突；只有 `--replace-telemetry` 才覆盖本次子进程的 exporter 设置，不修改 shell profile 或组织配置。

不同 `COPILOT_HOME` 通过实际绝对路径散列隔离；同一 HOME 内切换 Copilot 账户时，使用不同 `--source-label`。采集身份始终标为未验证，账单账户绑定不能证明本机事件属于该账户。

## 官方额度与预算

三种显示模式严格分开：

- **官方额度**：只有核实当月计费主体、额度池、单位、产品完整覆盖和动态额度后才显示百分比。组织共享池不能当作个人独享额度。
- **自定义预算**：仅在单位已验证且有实际已知调用时，按本机已记录 Credits / 用户预算计算。未知调用继续单列。
- **仅用量**：默认模式。未采集不等于 0，缺少计量不按消息数量推算费用，未验证单位保留 nano AIU。

账单使用专用环境变量 `PILOTMETER_GITHUB_TOKEN`，服务只在后端请求固定 GitHub API。token 不通过命令参数接收、不写入数据库、日志或页面，也不传给 Copilot 子进程。服务启动后更改凭据，需要 `stop` 再 `start --background`；权限修正后重新 `account connect` 解除停止重试状态。

个人、组织、企业使用各自端点与权限。当前仅识别明确的 `Copilot AI Credits / AI Credit / ai-credits` 组合，并标为产品部分覆盖；其他 SKU/单位保持 unsupported。空的个人报告不能代表组织或企业使用了 0。

quota 目前提供实验性证据导入适配边界，普通安装不包含 SDK，也不自动声称其字段属于 AI Credits。格式与真实验收步骤见[验证指南](docs/validation-guide.md)。

对账另需显式核验该数据目录内的全部采集来源、额度池、产品范围与时间覆盖。`reconcile inspect` 从实际账本和已验证账户快照生成模板；本地金额由服务端按月初至官方数据截止时间计算，模板不能提供或改写金额。无法证明覆盖时保持“无法对账”；只含部分产品的 Billing 报告、没有官方截止时间或 legacy Premium Requests 均不与本地 nano AIU 比较。

核验证据只对应当时的快照，有效期 15 分钟。账本、来源、分类、单位证据或账户快照变化后需重新核对，重复导入相同事件不影响。正差额显示“暂未归属”，负差额显示“尚未对齐”，不会自动归因其他设备或补入会话。具体步骤见[有限范围对账](docs/validation-guide.md#有限范围对账)。

## 数据与隐私

默认数据目录：Windows `%LOCALAPPDATA%\PilotMeter`；macOS `~/Library/Application Support/PilotMeter`；Linux `$XDG_STATE_HOME/pilotmeter` 或 `~/.local/state/pilotmeter`。

仅监听 `127.0.0.1`。collector 与管理接口使用独立随机令牌，浏览器修改使用同源校验与 CSRF 令牌。只持久化 ID、模型、时间、token 计数和计量等白名单元数据；不保存 prompt、response、tool argument。OTLP 支持 HTTP JSON，protobuf 和压缩请求返回明确错误；metrics/logs 接收后不保存、不参与费用累计。

同一 trace/span 全局去重；冲突隔离并回算，缺失祖先保持待分类。费用采用 BigInt，按调用结束时间归属 UTC 月份；会话生命周期与月度累计分开。JSONL 当前验证的是每行一个 OTLP `resourceSpans` envelope；原生 CLI 文件 exporter 格式仍需真实样本核验。

待分类调用从首次采集起等待 24 小时后标记超时，并保留诊断；这不会把未知金额视为零，也不会自动计入顶层用量。服务在启动、采集和每分钟维护时检查；重放和重启不重置等待时间，也不会重复累加超时诊断。后到祖先仍可触发重新分类，历史诊断保留以便追溯。

`node:sqlite` 在当前 Node 24.14 上仍有 experimental 警告，数据库访问限定后台进程。`stop` 和卸载不删除用户账本；升级或卸载前先停止服务。发生损坏时保留文件，不自动清空。备份时先停止服务，再复制整个数据目录。

明细保留默认关闭。显式设置 `retention.days`（1–36500）后，在保存设置、服务启动和每分钟维护时，清理所有已观测节点均已在阈值前结束的整条 trace。跨阈值、时间缺失或存在冲突的 trace 保守保留。清理会永久移除对应明细，仅保留 trace ID 等防重放标记；重复导入或晚到的父/子节点不会恢复这条 trace。关闭策略或延长天数也不会恢复此前明细。账户快照、原始遥测文件及升级备份不受此策略影响，SQLite 会复用释放的页而不保证文件立即缩小。

发生过清理后，页面和终端明确显示“仍保留的记录”，空账本保持未知，不显示零消费。`preview.2` 升级到数据库 schema v2 前创建备份，旧版本会拒绝较新的 schema；升级前先停止旧服务。

## 开发与验证

```powershell
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run test:pack

# Windows x64：构建并验收独立 EXE
npm run build:windows
npm run test:windows
```

EXE 双击会启动服务并打开页面；npm 安装后通过命令启动。两种方式均不自动安装 Copilot 或修改其配置。测试和 demo 使用独立目录；真实状态栏修改只在显式 `init --statusline` 时进行，已有自定义状态栏需查看变更方案后用 `--replace`。

[实施方案](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/implementation-plan.md) · [分阶段进展](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/progress.md) · [兼容性和剩余门槛](docs/compatibility.md) · [验证指南](docs/validation-guide.md) · [安装验收](docs/npm-package-contents.md)

MIT License。
