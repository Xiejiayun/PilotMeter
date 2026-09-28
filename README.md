# PilotMeter

GitHub Copilot CLI 本地用量监控工具：10 个可选桌面宠物、原生 Windows 主窗口、账户额度与模型清单、终端状态提示和可选原生状态栏。Node.js + SQLite，无独立云服务，无 Electron。

**当前为 `0.1.0-preview.8` 预览版，尚未公开发布 npm。** 支持多账号登录和读取当前用户的 Copilot 额度。本机采集默认保存原始 nano AIU，组织账单对账仍需核验；真实订阅、`/usage` 和官方页面对账是独立发布门槛，合成测试不能替代。

## 安装与开始使用

内置官方 Copilot CLI 1.0.88；在 Windows 主窗口或可选网页点击“登录 GitHub”，按提示在 GitHub 输入设备码并确认账号。可继续添加个人或工作账号，通过账号选择器切换。采集分类和状态栏配置当前仅验证 `1.0.88` 规则，其他版本保持待分类。

### Windows 单 EXE

Windows 10/11 x64 使用单文件 `PilotMeter-0.1.0-preview.8-win-x64.exe`，无需安装 Node.js 或 npm；已发布产物见 [Releases](https://github.com/Xiejiayun/PilotMeter/releases)，源码构建方式见 [Windows EXE 指南](docs/windows-exe.md)。挂件和独立主窗口都使用原生 WinForms 控件，需要 .NET Framework 4.8；没有内嵌网页或 WebView 依赖。不要求管理员权限，不修改 PATH。

双击 EXE 先显示可拖动的小挂件，不打开浏览器或命令行窗口。点击挂件打开独立主窗口，关闭主窗口后挂件仍保留；右键可隐藏到托盘、调整置顶或退出桌面界面。重复双击会唤回同一数据目录的挂件。退出桌面界面不停止采集服务，停止服务仍使用 `stop`。在 PowerShell 中也能使用完整命令：

```powershell
.\PilotMeter-0.1.0-preview.8-win-x64.exe doctor
.\PilotMeter-0.1.0-preview.8-win-x64.exe desktop
.\PilotMeter-0.1.0-preview.8-win-x64.exe desktop --open
Start-Process .\PilotMeter-0.1.0-preview.8-win-x64.exe -ArgumentList 'run -- --no-auto-update' -NoNewWindow -Wait

# 另一个终端或分屏
Start-Process .\PilotMeter-0.1.0-preview.8-win-x64.exe -ArgumentList 'watch' -NoNewWindow -Wait
.\PilotMeter-0.1.0-preview.8-win-x64.exe stop
```

`desktop --open` 直接打开主窗口。EXE 使用 GUI 子系统，交互式 PowerShell 可能立即返回提示符；`run` 和 `watch` 使用上方 `Start-Process -NoNewWindow -Wait` 保持终端输入归属。主窗口的账号菜单提供重新登录和移除，设备码窗口支持取消与过期重试。

主窗口分为总览、可用模型、用量记录和账户四页。总览在单位明确时展示同一类别的总额、已用和剩余；来源未说明单位时保留可靠比例，并提供原始数量展开区。模型页来自当前账号的官方 CLI 模型目录与策略，不把登录成功当成所有模型可用。本机记录按账号隔离，与组织共享账单分别展示。

账户页和宠物右键菜单可更换 10 个宠物，调整大小、动效与置顶。宠物素材嵌入 EXE，选择保存在本机；启动不依赖设计 HTML 或联网下载图片。发布资产另提供便携 ZIP。开发者可以使用 `npm run release:windows` 完整测试和打包，推送合并到 main 的版本标签即可触发 GitHub Release，见[打包与发布方案](docs/releasing.md)。

首次运行会将内嵌 Node、Copilot CLI 和应用解压到 `%LOCALAPPDATA%\PilotMeter\runtime\<版本>-<载荷哈希前16位>`，账本仍保存在 `%LOCALAPPDATA%\PilotMeter`。升级前先在旧挂件菜单中退出，再用旧版执行 `stop`；已配置的 statusline 引用此稳定缓存，不能随意删除。下载校验、缓存与源码构建说明见 [Windows EXE 指南](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/windows-exe.md)。

### npm 安装

npm 方式需要 Node.js **24.14+**。当前尚未公开发布 npm，可从源码构建并安装本地包：

```powershell
npm ci
npm test
npm pack
npm install -g ./pilotmeter-0.1.0-preview.8.tgz

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
| `run [--account id] [--replace-telemetry] [--source-label name] -- <args>` | 用所选账号启动 Copilot 并采集本次会话 |
| `watch` / `status [--json]` | 持续观察或输出一次状态 |
| `statusline` | 只读本地快照，stdout 一行，不连接 GitHub |
| `open` / `stop` | 打开页面 / 正常停止自己的服务 |
| `init --statusline [--replace]` | 备份并最小修改 Copilot 的 JSONC 设置 |
| `init --restore-statusline` | 逐字段恢复仍属于 PilotMeter 的设置 |
| `config set budget.monthlyCredits 1500` | 设置本机记录范围的自定义预算；`null` 清除 |
| `config set retention.days 90` | 显式启用 90 天明细保留策略并立即清理；默认关闭，`null` 停止后续清理 |
| `import <file> [--source-label name]` | 导入受支持的 OTLP traces JSONL，支持增量与重放 |
| `demo [--open]` | 在独立 `demo` 子目录启动明显标注的虚构数据 |
| `account login [--host https://github.com] [--account id]` | 官方设备码登录；可添加多个账号或重新授权 |
| `account list` / `account use <id或none>` | 查看账号、切换账号；none 显示全部本机记录 |
| `account remove <id>` | 从 PilotMeter 移除账号，保留历史，不撤销 GitHub 授权 |
| `account refresh` | 刷新所选账号个人额度；未选账号时刷新旧账单绑定 |
| `account connect --organization name` | 绑定组织付费主体 |
| `account connect --enterprise slug` | 绑定企业付费主体 |
| `account connect --user login --direct-billing` | 显式确认个人直付后绑定个人主体 |
| `account refresh --billing` / `account disconnect` | 刷新账单 / 断开绑定，保留本地记录 |
| `account import-quota <file>` | 导入只读 quota 数据及完整核验证据；未验证不会开启官方比例 |
| `unit verify --cli-version 1.0.88 --evidence "实际核对说明"` | 在真实 `/usage` 对账后记录单位换算证据 |
| `unit clear` | 撤销单位验证，恢复原始单位展示 |
| `reconcile status [--period YYYY-MM] [--json]` | 查看所选 UTC 月的对账结果及无法比较的原因 |
| `reconcile inspect [--period YYYY-MM] [--output file.json]` | 检查当前范围并生成待核验模板；不覆盖已有文件 |
| `reconcile verify <file>` / `reconcile clear [--period YYYY-MM]` | 校验证据 / 撤销该月证据；不修改调用金额 |

所有命令均可在命令名前使用 `--data-dir <目录>`。可以用 `PILOTMETER_COPILOT_BIN` 指定独立安装的 Copilot 入口。已有 exporter 时默认报告冲突；只有 `--replace-telemetry` 才覆盖本次子进程的 exporter 设置，不修改 shell profile 或组织配置。

所选账号拥有独立 Copilot 配置目录；新会话按启动时的账号归类，切换页面账号不会改变已启动会话的归属。在 Copilot 内使用 `/user` 或 `/login` 换号后，请退出并从 PilotMeter 重新启动；启动时身份验证不等于持续核实每条遥测的实际付款账号。旧记录和未登录采集保留在“全部本机记录”视图，不自动分配给新账号。各账号的自定义预算分别保存。

`init --statusline` 和恢复命令作用于当前 shell 的 `COPILOT_HOME`，未设置时使用普通 `~/.copilot`。它们不会随页面选择切换目标，也不会自动配置受管账号的独立目录；当前多账号会话可用独立 `watch` 或页面查看用量。

## 官方额度与预算

原生主窗口和可选网页显示所选 GitHub 用户的当前周期 Copilot 额度，直接读取官方 CLI 的只读账号接口。默认突出“高级请求”类别，聊天、代码补全等放入“其他额度”；没有高级请求时，只有唯一有限类别可以成为默认主指标，多个有限类别需明确选择，不合并数量或比例。类别名不代表计量单位：单位未确认时隐藏原始数量，只展示上游明确返回的比例或额度状态；过去的重置日期不显示为下次重置。个人额度不等于组织共享账单，也不随网页的历史月份选择变化。

下方本机记录与账单核验保留三种显示模式：

- **官方额度**：只有核实当月计费主体、额度池、单位、产品完整覆盖和动态额度后才显示百分比。组织共享池不能当作个人独享额度。
- **自定义预算**：仅在单位已验证且有实际已知调用时，按本机已记录 Credits / 用户预算计算。未知调用继续单列。
- **仅用量**：默认模式。未采集不等于 0，缺少计量不按消息数量推算费用，未验证单位保留 nano AIU。

账单使用专用环境变量 `PILOTMETER_GITHUB_TOKEN`，服务只在后端请求固定 GitHub API。token 不通过命令参数接收、不写入数据库、日志或页面，也不传给 Copilot 子进程。服务启动后更改凭据，需要 `stop` 再 `start --background`；权限修正后重新 `account connect` 解除停止重试状态。

个人、组织、企业使用各自端点与权限。当前仅识别明确的 `Copilot AI Credits / AI Credit / ai-credits` 组合，并标为产品部分覆盖；其他 SKU/单位保持 unsupported。空的个人报告不能代表组织或企业使用了 0。

个人额度使用内置官方 CLI 的实验性只读 account RPC，不额外安装 SDK。旧账单 quota 证据导入继续独立保留；登录新账号不会继承或自动认证旧组织账单绑定。格式与真实验收步骤见[验证指南](docs/validation-guide.md)。

对账另需显式核验该数据目录内的全部采集来源、额度池、产品范围与时间覆盖。`reconcile inspect` 从实际账本和已验证账户快照生成模板；本地金额由服务端按月初至官方数据截止时间计算，模板不能提供或改写金额。无法证明覆盖时保持“无法对账”；只含部分产品的 Billing 报告、没有官方截止时间或 legacy Premium Requests 均不与本地 nano AIU 比较。

核验证据只对应当时的快照，有效期 15 分钟。账本、来源、分类、单位证据或账户快照变化后需重新核对，重复导入相同事件不影响。正差额显示“暂未归属”，负差额显示“尚未对齐”，不会自动归因其他设备或补入会话。具体步骤见[有限范围对账](docs/validation-guide.md#有限范围对账)。

## 数据与隐私

默认数据目录：Windows `%LOCALAPPDATA%\PilotMeter`；macOS `~/Library/Application Support/PilotMeter`；Linux `$XDG_STATE_HOME/pilotmeter` 或 `~/.local/state/pilotmeter`。

GitHub 密码只在 GitHub 输入。授权凭据由官方 Copilot CLI 管理，可能使用系统凭据库；独立配置目录不等于系统凭据库隔离。凭据库不可用时，官方 CLI 可能回退到本地文件保存。PilotMeter 账号清单仅保存身份和目录标识，不向页面发送 token 或官方内部账号选择标识。移除账号不删除官方 CLI 凭据或撤销 OAuth 授权；需要撤销时使用 GitHub 的应用授权设置。

仅监听 `127.0.0.1`。collector 与管理接口使用独立随机令牌，浏览器修改使用同源校验与 CSRF 令牌。PilotMeter 的计量账本只持久化 ID、模型、时间、token 计数和计量等白名单元数据，不保存 prompt、response、tool argument。内置官方 Copilot CLI 仍会按自身设置在受管 `COPILOT_HOME` 中保存会话历史及日志，可能包含对话内容；这部分文件不属于计量账本，也不受账本明细保留策略清理。OTLP 支持 HTTP JSON，protobuf 和压缩请求返回明确错误；metrics/logs 接收后不保存、不参与费用累计。

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

EXE 双击会启动服务并显示挂件，点击才打开主窗口；npm 安装后通过命令启动。两种方式都包含官方 Copilot CLI，启动不会自动登录。GitHub 设备授权链接在系统浏览器打开。测试和 demo 使用独立目录；真实状态栏修改只在显式 `init --statusline` 时进行，已有自定义状态栏需查看变更方案后用 `--replace`。

已连接并读取一个真实账号的个人额度快照；官方页面比对、两个真实账号的完整切换、会话对账和原生窗口交互验收仍未完成。当前测试结果与桌面自动化受阻情况见[兼容性记录](docs/compatibility.md)。

[实施方案](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/implementation-plan.md) · [分阶段进展](https://github.com/Xiejiayun/PilotMeter/blob/main/docs/progress.md) · [兼容性和剩余门槛](docs/compatibility.md) · [验证指南](docs/validation-guide.md) · [安装验收](docs/npm-package-contents.md)

PilotMeter 采用 MIT License；内置 GitHub Copilot CLI 按其官方独立许可证分发，完整条款随包保留。
