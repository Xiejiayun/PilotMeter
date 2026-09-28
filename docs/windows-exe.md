# Windows 单 EXE

`PilotMeter-0.1.0-preview.7-win-x64.exe` 将 Node.js 24.14.0、PilotMeter、原生桌面界面和生产依赖放在一个文件中，适用于 Windows 10/11 x64。无需安装 Node.js 或 npm；挂件和主窗口需要 .NET Framework 4.8，没有 WebView 依赖。无需管理员权限，不修改 PATH。

此版本仍为预览版。内置官方 Copilot CLI 1.0.88，可在原生主窗口登录并管理多个 GitHub 账号；采集分类和 statusline 配置当前仅验证 `1.0.88` 规则。EXE 分发不改变单位核验、官方额度和真实账单对账门槛，详见[验证指南](validation-guide.md)。

## 下载与开始使用

已发布版本的 EXE 和 `SHA256SUMS` 可从 [GitHub Releases](https://github.com/Xiejiayun/PilotMeter/releases) 下载；源码构建方式见下文。在 PowerShell 中计算文件摘要，与同一版本校验清单中对应文件的一行比较：

```powershell
Get-FileHash -Algorithm SHA256 .\PilotMeter-0.1.0-preview.7-win-x64.exe
Get-Content .\SHA256SUMS
```

预览版 EXE 尚未签名，Windows 可能显示来源或信誉提示。先确认下载来源和 SHA-256；组织设备应遵循管理员的应用运行策略。

双击后先出现桌面小挂件，点击它打开独立主窗口，再点击“登录 GitHub”。设备授权在系统浏览器的 GitHub 官方页面完成；添加另一个账号时重复这一操作，并确认授权页上的目标账号。Windows EXE 已内置登录所需 CLI。

主窗口通过账号选择器切换当前账号，点击“刷新”同步额度；“···”账号菜单提供重新登录和移除。设备码窗口支持复制验证码、打开授权页、取消和过期重试。移除连接保留本机记录，不撤销 GitHub 上的授权。

双击 EXE，或不带命令运行，会显示可拖动的桌面挂件，不自动打开浏览器或控制台。单击或按 Enter/空格打开主窗口，拖动结束不会误打开窗口；右键菜单可切换置顶、隐藏到托盘或退出。托盘可以恢复挂件和打开主程序。位置及置顶设置保存在数据目录的 `desktop-ui.json`，移动屏幕后会将挂件移回可见工作区。

同一数据目录只保留一个桌面实例；再次双击会唤回挂件。关闭主窗口不关闭挂件；退出桌面界面不停止后台采集，仍可用 `stop` 停止服务。无桌面的自动化或远程会话使用显式 `start --background`。`open` / `start --open` 仍是明确要求用浏览器查看的 CLI 入口。

```powershell
# 查看运行环境；核对内置 Copilot 版本；不会自动登录
.\PilotMeter-0.1.0-preview.7-win-x64.exe doctor

# 显示桌面挂件（也可以直接双击 EXE）
.\PilotMeter-0.1.0-preview.7-win-x64.exe desktop

# 直接显示独立主窗口，适合快捷方式或键盘启动
.\PilotMeter-0.1.0-preview.7-win-x64.exe desktop --open

# 先在主窗口登录，然后用所选账号启动内置 Copilot，采集本次会话
Start-Process .\PilotMeter-0.1.0-preview.7-win-x64.exe -ArgumentList 'run -- --no-auto-update' -NoNewWindow -Wait

# 另一个终端或分屏查看状态
Start-Process .\PilotMeter-0.1.0-preview.7-win-x64.exe -ArgumentList 'watch' -NoNewWindow -Wait
.\PilotMeter-0.1.0-preview.7-win-x64.exe status --json
.\PilotMeter-0.1.0-preview.7-win-x64.exe open
.\PilotMeter-0.1.0-preview.7-win-x64.exe stop
```

`watch` 中按 `o` 打开页面、`q` 退出观察。所有 CLI 命令保留，参数用法见 [README](../README.md#命令)；将文档中的 `pilotmeter` 替换为 EXE 路径即可。路径含空格时使用 PowerShell 的调用运算符，例如 `& 'C:\我的工具\PilotMeter-0.1.0-preview.7-win-x64.exe' status`。

EXE 使用 Windows GUI 子系统以避免双击时弹出控制台。交互式 PowerShell 可能不会等待这种 EXE；`watch` 和 `run` 使用上方 `Start-Process -NoNewWindow -Wait`，让终端保持输入归属。重定向与脚本调用的 stdout、stderr 和退出码另有 EXE 回归覆盖。`Start-Process -ArgumentList` 接受命令行文本，自定义参数含空格时须在该文本中加双引号。

`run` 调用 Windows `.cmd` 形式的 Copilot 入口时，连续反斜杠紧接双引号的复杂参数可能被 shim 的多层解析改变。此限制已绕过 PilotMeter EXE，直接通过生产依赖 `cross-spawn` 调用 `.cmd` 独立复现。普通空格、中文、空参数、引号及尾反斜杠组合已测试；需要传递这类复杂参数时，可通过 `PILOTMETER_COPILOT_BIN` 指向独立安装的原生 Copilot `.exe` 入口。EXE 启动器到原生子进程的完整特殊参数集已通过。

需要独立账本时，把 `--data-dir` 放在命令之前。相对路径按当前终端工作目录解析：

```powershell
.\PilotMeter-0.1.0-preview.7-win-x64.exe --data-dir 'D:\PilotMeter 数据' desktop
.\PilotMeter-0.1.0-preview.7-win-x64.exe --data-dir 'D:\PilotMeter 数据' stop
```

## 缓存、数据与升级

首次运行把内嵌运行时和应用解压到稳定目录，后续运行复用同一载荷：

```text
%LOCALAPPDATA%\PilotMeter\runtime\<版本>-<载荷 SHA-256 前16位>
```

默认账本、设置和后台日志仍位于 `%LOCALAPPDATA%\PilotMeter`；`--data-dir` 或 `PILOTMETER_DATA_DIR` 可指定账本目录。EXE 可以放在普通用户可读取的位置，运行时缓存和账本需要可写空间。

升级前，先从旧挂件的右键菜单退出桌面界面，再用旧版 EXE 对每个运行中的数据目录执行 `stop`，然后运行新版。仅关闭主窗口或隐藏到托盘不会退出旧挂件；同一数据目录已有挂件时，再次启动只会唤回该实例。升级不自动清空账本；备份时先退出桌面界面并停止服务，再复制数据目录。

显式执行 `init --statusline` 后，生成的桥接脚本引用解压目录内的 Node 和应用。移动外层 EXE 不改变这一引用；删除旧缓存会使仍引用它的 statusline 失效。升级后可用新版执行 `init --statusline` 更新 PilotMeter 自己管理的桥接脚本，再核对状态栏。若不再使用，先执行 `init --restore-statusline`，再停止服务。保留仍被服务或桥接脚本引用的运行时目录。

这两个配置命令的目标是当前 shell 的 `COPILOT_HOME`，未设置时为普通 `~/.copilot`；不会自动跟随页面选择安装或恢复受管账号独立目录中的状态栏。当前多账号会话可用 `watch` 或页面查看用量。

EXE 已包含官方 Copilot CLI。首次启动解压文件并显示挂件；登录操作创建应用账号配置目录，凭据由官方 CLI 管理，不替换普通 Copilot 配置。`init --statusline` 才会备份并修改相关设置；已有其他 statusline 时仍需按命令给出的变更说明显式使用 `--replace`。

主窗口是原生 WinForms 界面，默认展示所选账号、主要额度和同步状态。优先展示 GitHub 的“高级请求”类别，聊天、代码补全等放在“其他额度”；没有高级请求时，只有唯一有限类别可作为默认主指标，多个有限类别需要明确选择，不相加。类别不代表计量单位，单位未说明的原始数量不展示；过去的重置时间不作为下次重置日期。账号操作只调用通过身份验证的本机接口，GitHub 设备授权链接由系统浏览器打开。

PilotMeter 计量账本不保存对话内容；官方 Copilot CLI 在受管账号目录中保存的会话历史和日志遵循其自身行为，可能包含对话内容。这些文件与计量账本分开，不由 `retention.days` 清理。

## 从源码构建

构建环境需要 Windows x64、Node.js 24.14+、npm，以及 .NET Framework 4.8 和系统 C# 编译器。`csc.exe` 位于系统 `Microsoft.NET\Framework64\v4.0.30319` 目录；其中 `v4.0.30319` 是 CLR 4 路径，不代表应用的最低 Framework 版本。

在仓库根目录执行：

```powershell
npm ci
npm run build:windows
npm run test:windows
```

构建输出：

```text
build/windows/PilotMeter-0.1.0-preview.7-win-x64.exe
build/windows/SHA256SUMS
```

构建时从 Node 官方固定版本下载 Windows x64 运行时，并按固定 SHA-256 验证。Node 24.14.0 的官方 `win-x64/node.exe` 摘要为：

```text
63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088
```

来源：[Node 24.14.0 官方校验清单](https://nodejs.org/download/release/v24.14.0/SHASUMS256.txt)。修改运行时版本时，需要同时更新固定摘要并重新完成 EXE 验收。构建环境需要网络获取依赖和运行时；成品启动无需再下载 Node。

随包保留 PilotMeter 的 MIT 许可证、完整 Node LICENSE、生产依赖许可证，以及可选网页产物包含的 Vite helper 对应许可证。Node LICENSE 包括其内置组件条款，不能只保留文件开头的 MIT 文本。系统 Framework 不随包复制。GitHub Copilot CLI 按其官方独立许可证分发，未经修改的运行时、完整 LICENSE/README 和归属声明均保留；PilotMeter 的 MIT 许可证不替代这些条款。

## 验收范围

`npm run test:windows` 使用实际 EXE 验收，不从源码或开发依赖加载应用；子进程 PATH 不含 Node/npm/Copilot，使用独立用户环境和数据目录。2026-09-28 的 `preview.5` 已在 Windows 11 Enterprise x64（10.0.26200）通过 13 组验收；`preview.6` 另增加内置 Copilot 版本、账号入口和只读运行检查。以下旧版结果保留为回归基线，不代表当前原生产物已经重新验收通过：

- 版本、帮助、只读 `doctor` 和未启动状态正常；首次两个进程并发解包及后续缓存复用正常。
- 后台启动后命令输出正确结束，重复启动复用实例；实际页面 HTML、JavaScript、CSS 和 CSP 可用。
- 合成 OTLP 采集、SQLite 持久化、设置保存、停止及重启通过；演示数据保持独立。
- 中文、空格及特殊字符路径通过；原生测试入口收到完整特殊参数和 UTF-8 stdin，stdout、stderr 和退出码正确。`.cmd` 边界单列记录。
- statusline 安装、stdin、桥接输出及恢复通过；移动外层 EXE 后原桥接脚本仍正常工作。
- 缓存文件被修改时启动器拒绝执行，恢复原始文件后可再次运行。构建检查固定 Node 摘要、精确生产依赖、许可证及包成员白名单，并扫描敏感文件和凭据形态。
- `preview.5` 单独在本机实际 TTY 中验证 `watch` 的 `q` 和 Ctrl+C 正常退出；其无参数入口当时打开浏览器。`preview.7` 已改为桌面挂件，自动化用显式 `start --background` 验证无桌面启动。

当前 `preview.7` 纯原生修订已通过 219 项完整 Node 回归、36 项浏览器回归、194 项原生检查和 7 组实际 npm 安装验收。原生检查覆盖路径归一、参数解析、DTO、JSON 上界、API 白名单、CSRF、服务身份变化，以及真实 loopback 请求和半截响应体取消。当前 GUI EXE 的 `watch` 已在本机 TTY 中验证 `q` 和 Ctrl+C 正常退出；实际 EXE 的最终验收及三平台结果见对应 PR 检查记录和 Release。

原生窗口的实际交互和视觉验收受工具错误阻挡：重新选择窗口后，激活操作仍返回 `GetCursorPos: Access is denied (0x80070005)`，未能完成点击、拖动、托盘恢复与窗口布局检查。无窗口契约检查、真实 loopback 请求和网页截图均不替代这些桌面验收。

未完成的系统/终端验收：干净 Windows 10/11 设备兼容性、真实 Copilot TUI 交互、原生 statusline 渲染以及终端链接点击。PATH 隔离测试不等同于干净系统验收。EXE 未签名。

合成测试不调用真实模型或账单，也不能证明官方月度额度。本机已读取一个真实账号的个人额度快照；官方页面逐项比对、第二个真实账号的完整切换、真实 `/usage` 和组织或企业账单对账仍按[验证指南](validation-guide.md)完成。

系统基线参考：[Node 24.14.0 平台支持](https://github.com/nodejs/node/blob/v24.14.0/BUILDING.md#platform-list)、[Windows 自带 .NET Framework 版本](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)。Node 的官方支持还取决于操作系统是否处于供应商支持期。
