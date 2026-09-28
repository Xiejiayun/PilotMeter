# Windows 单 EXE

`PilotMeter-0.1.0-preview.5-win-x64.exe` 将 Node.js 24.14.0、PilotMeter 和生产依赖放在一个文件中，适用于 Windows 10/11 x64。使用者无需安装 Node.js、npm 或额外 .NET；启动器使用系统自带的 .NET Framework 4.x。无需管理员权限，不修改 PATH。

此版本仍为预览版。Copilot CLI 需要独立安装并登录；采集分类和 statusline 配置当前仅验证 `1.0.88` 规则。EXE 分发不改变单位核验、官方额度和真实账单对账门槛，详见[验证指南](validation-guide.md)。

## 下载与开始使用

从 [GitHub Releases](https://github.com/Xiejiayun/PilotMeter/releases) 下载同一版本的 EXE 和 `SHA256SUMS`。在 PowerShell 中计算文件摘要，与校验清单中对应文件的一行比较：

```powershell
Get-FileHash -Algorithm SHA256 .\PilotMeter-0.1.0-preview.5-win-x64.exe
Get-Content .\SHA256SUMS
```

预览版 EXE 尚未签名，Windows 可能显示来源或信誉提示。先确认下载来源和 SHA-256；组织设备应遵循管理员的应用运行策略。

双击 EXE，或在终端中不带参数运行，会执行 `start --background --open`：启动本机后台服务并打开浏览器页面。关闭页面不停止服务；退出终端观察也不停止服务。停止时运行 `stop`。

```powershell
# 查看运行环境；不会替你安装或登录 Copilot
.\PilotMeter-0.1.0-preview.5-win-x64.exe doctor

# 通过 PilotMeter 启动已独立安装的 Copilot，采集本次会话
.\PilotMeter-0.1.0-preview.5-win-x64.exe run -- --no-auto-update

# 另一个终端或分屏查看状态
.\PilotMeter-0.1.0-preview.5-win-x64.exe watch
.\PilotMeter-0.1.0-preview.5-win-x64.exe status --json
.\PilotMeter-0.1.0-preview.5-win-x64.exe open
.\PilotMeter-0.1.0-preview.5-win-x64.exe stop
```

`watch` 中按 `o` 打开页面、`q` 退出观察。所有 CLI 命令保留，参数用法见 [README](../README.md#命令)；将文档中的 `pilotmeter` 替换为 EXE 路径即可。路径含空格时使用 PowerShell 的调用运算符，例如 `& 'C:\我的工具\PilotMeter-0.1.0-preview.5-win-x64.exe' status`。

`run` 调用 Windows `.cmd` 形式的 Copilot 入口时，连续反斜杠紧接双引号的复杂参数可能被 shim 的多层解析改变。此限制已绕过 PilotMeter EXE，直接通过生产依赖 `cross-spawn` 调用 `.cmd` 独立复现。普通空格、中文、空参数、引号及尾反斜杠组合已测试；需要传递这类复杂参数时，可通过 `PILOTMETER_COPILOT_BIN` 指向独立安装的原生 Copilot `.exe` 入口。EXE 启动器到原生子进程的完整特殊参数集已通过。

需要独立账本时，把 `--data-dir` 放在命令之前。相对路径按当前终端工作目录解析：

```powershell
.\PilotMeter-0.1.0-preview.5-win-x64.exe --data-dir 'D:\PilotMeter 数据' start --background --open
.\PilotMeter-0.1.0-preview.5-win-x64.exe --data-dir 'D:\PilotMeter 数据' stop
```

## 缓存、数据与升级

首次运行把内嵌运行时和应用解压到稳定目录，后续运行复用同一载荷：

```text
%LOCALAPPDATA%\PilotMeter\runtime\<版本>-<载荷 SHA-256 前16位>
```

默认账本、设置和后台日志仍位于 `%LOCALAPPDATA%\PilotMeter`；`--data-dir` 或 `PILOTMETER_DATA_DIR` 可指定账本目录。EXE 可以放在普通用户可读取的位置，运行时缓存和账本需要可写空间。

升级前，用旧版 EXE 对每个运行中的数据目录执行 `stop`，再运行新版。升级不自动清空账本；备份时先停止服务，再复制数据目录。

显式执行 `init --statusline` 后，生成的桥接脚本引用解压目录内的 Node 和应用。移动外层 EXE 不改变这一引用；删除旧缓存会使仍引用它的 statusline 失效。升级后可用新版执行 `init --statusline` 更新 PilotMeter 自己管理的桥接脚本，再核对状态栏。若不再使用，先执行 `init --restore-statusline`，再停止服务。保留仍被服务或桥接脚本引用的运行时目录。

EXE 首次启动不自动安装 Copilot，也不自动写入 Copilot 配置。`init --statusline` 才会备份并修改相关设置；已有其他 statusline 时仍需按命令给出的变更说明显式使用 `--replace`。

## 从源码构建

构建环境需要 Windows x64、Node.js 24.14+、npm，以及系统 .NET Framework 4.x 的 C# 编译器。正常 Windows 10/11 已包含所需 Framework；`csc.exe` 位于系统 `Microsoft.NET\Framework64\v4.0.30319` 目录。使用的 ZIP API 来自 Framework 4.5 及以上，编译器目录中的 `v4.0.30319` 是 CLR 4 路径，不表示应用只使用 Framework 4.0 API。

在仓库根目录执行：

```powershell
npm ci
npm run build:windows
npm run test:windows
```

构建输出：

```text
build/windows/PilotMeter-0.1.0-preview.5-win-x64.exe
build/windows/SHA256SUMS
```

构建时从 Node 官方固定版本下载 Windows x64 运行时，并按固定 SHA-256 验证。Node 24.14.0 的官方 `win-x64/node.exe` 摘要为：

```text
63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088
```

来源：[Node 24.14.0 官方校验清单](https://nodejs.org/download/release/v24.14.0/SHASUMS256.txt)。修改运行时版本时，需要同时更新固定摘要并重新完成 EXE 验收。构建环境需要网络获取依赖和运行时；成品启动无需再下载 Node。

随包保留 PilotMeter 的 MIT 许可证、完整 Node LICENSE、生产依赖许可证，以及前端产物包含的 Vite helper 对应许可证。Node LICENSE 包括其内置组件条款，不能只保留文件开头的 MIT 文本。系统 Framework 不随包复制。

## 验收范围

2026-09-28，Windows 11 Enterprise x64（10.0.26200）实际 EXE 通过 13 组独立验收。脚本为 `npm run test:windows`，不从源码或开发依赖加载应用；子进程 PATH 不含 Node/npm，使用独立用户环境和数据目录。

- 版本、帮助、只读 `doctor` 和未启动状态正常；首次两个进程并发解包及后续缓存复用正常。
- 后台启动后命令输出正确结束，重复启动复用实例；实际页面 HTML、JavaScript、CSS 和 CSP 可用。
- 合成 OTLP 采集、SQLite 持久化、设置保存、停止及重启通过；演示数据保持独立。
- 中文、空格及特殊字符路径通过；原生测试入口收到完整特殊参数和 UTF-8 stdin，stdout、stderr 和退出码正确。`.cmd` 边界单列记录。
- statusline 安装、stdin、桥接输出及恢复通过；移动外层 EXE 后原桥接脚本仍正常工作。
- 缓存文件被修改时启动器拒绝执行，恢复原始文件后可再次运行。构建检查固定 Node 摘要、精确生产依赖、许可证及包成员白名单，并扫描敏感文件和凭据形态。
- 单独在本机实际 TTY 中验证 `watch` 的 `q` 和 Ctrl+C 正常退出；无参数 EXE 成功启动后台服务并调用默认浏览器打开页面。自动化另覆盖远程终端的普通 URL 回退。

未完成的系统/终端验收：干净 Windows 10/11 设备兼容性、真实 Copilot TUI 交互、原生 statusline 渲染以及终端链接点击。PATH 隔离测试不等同于干净系统验收。EXE 未签名。

合成测试不调用真实模型或账单，也不能证明官方月度额度。真实订阅、`/usage`、组织或企业付款主体及官方页面对账仍按[验证指南](validation-guide.md)完成。

系统基线参考：[Node 24.14.0 平台支持](https://github.com/nodejs/node/blob/v24.14.0/BUILDING.md#platform-list)、[Windows 自带 .NET Framework 版本](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)。Node 的官方支持还取决于操作系统是否处于供应商支持期。
