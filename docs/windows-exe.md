# Windows 单 EXE

`PilotMeter-0.1.0-preview.17-win-x64.exe` 将 Node.js 24.14.0、PilotMeter、桌面 PET、HTML + Tailwind CSS 工作台和生产依赖放在一个文件中，适用于 Windows 10/11 x64。无需安装 Node.js 或 npm；桌面宿主需要 .NET Framework 4.8，主界面使用 Microsoft Edge WebView2 Evergreen Runtime。所有页面、样式和宠物资源随包提供，不使用在线 CSS 或字体。不修改 PATH。

若设备未安装 WebView2 Runtime，PET 仍可启动，主窗口会显示 Microsoft 官方安装入口；安装后点击重试。WebView2 运行时由 Microsoft 维护和更新，应用包固定并校验 WebView2 SDK 与 x64 Loader 的版本和摘要。

此版本仍为预览版。内置官方 Copilot CLI 1.0.88，可在独立主窗口登录并管理多个 GitHub 账号；采集分类和 statusline 配置当前仅验证 `1.0.88` 规则。EXE 分发不改变单位核验、官方额度和真实账单对账门槛，详见[验证指南](validation-guide.md)。

## 下载与开始使用

已发布版本的 EXE 和 `SHA256SUMS` 可从 [GitHub Releases](https://github.com/Xiejiayun/PilotMeter/releases) 下载；源码构建方式见下文。在 PowerShell 中计算文件摘要，与同一版本校验清单中对应文件的一行比较：

```powershell
Get-FileHash -Algorithm SHA256 .\PilotMeter-0.1.0-preview.17-win-x64.exe
Get-Content .\SHA256SUMS
```

预览版 EXE 尚未签名，Windows 可能显示来源或信誉提示。先确认下载来源和 SHA-256；组织设备应遵循管理员的应用运行策略。

双击后先出现桌面小挂件，点击它打开独立主窗口，再点击“登录 GitHub”。设备授权在系统浏览器的 GitHub 官方页面完成；添加另一个账号时重复这一操作，并确认授权页上的目标账号。Windows EXE 已内置登录所需 CLI。

主窗口通过账号选择器切换当前账号，点击同步按钮更新额度；账户页提供添加、重新登录和移除。设备码弹窗按获取验证码、复制并打开 GitHub、返回自动连接三个步骤引导，进度与失败原因置于上部；验证码过期后可重新获取。网络或代理错误会显示具体处理提示。移除连接保留本机记录，不撤销 GitHub 上的授权。

若升级后显示后台版本不一致，先结束正在采集的 Copilot 会话，再点击右上角“重启本机服务”。程序会核对后台实例，正常停止旧服务并等待账本关闭，再启动当前版本；账号和用量数据保留。定时刷新不会自动停止服务。

当前版本提供总览、可用模型、用量记录和账户四页工作台。首页突出已用、总额和剩余，模型页支持搜索与状态筛选。账户页可选择飞行员、橘猫、柴犬、企鹅、软糖团、机器人、云朵、小叶精灵、水母、像素龙十个宠物；右键宠物也能更换角色、调整大小与动效。PNG 素材已嵌入程序，不需要复制设计文件。

双击 EXE，或不带命令运行，会显示可拖动的桌面挂件，不自动打开浏览器或控制台。单击或按 Enter/空格打开主窗口，拖动结束不会误打开窗口；右键菜单可切换置顶、隐藏到托盘或退出。托盘可以恢复挂件和打开主程序。位置及置顶设置保存在数据目录的 `desktop-ui.json`，移动屏幕后会将挂件移回可见工作区。

同一数据目录只保留一个桌面实例；再次双击会唤回挂件。关闭主窗口不关闭挂件；退出桌面界面不停止后台采集，仍可用 `stop` 停止服务。无桌面的自动化或远程会话使用显式 `start --background`。`open` / `start --open` 仍是明确要求用浏览器查看的 CLI 入口。

```powershell
# 查看运行环境；核对内置 Copilot 版本；不会自动登录
.\PilotMeter-0.1.0-preview.17-win-x64.exe doctor

# 显示桌面挂件（也可以直接双击 EXE）
.\PilotMeter-0.1.0-preview.17-win-x64.exe desktop

# 直接显示独立主窗口，适合快捷方式或键盘启动
.\PilotMeter-0.1.0-preview.17-win-x64.exe desktop --open

# 也可在主窗口登录后点击“启动 Copilot 会话”，选择项目文件夹
# 以下保留终端方式：用所选账号启动内置 Copilot，采集本次会话
Start-Process .\PilotMeter-0.1.0-preview.17-win-x64.exe -ArgumentList 'run -- --no-auto-update' -NoNewWindow -Wait

# 另一个终端或分屏查看状态
Start-Process .\PilotMeter-0.1.0-preview.17-win-x64.exe -ArgumentList 'watch' -NoNewWindow -Wait
.\PilotMeter-0.1.0-preview.17-win-x64.exe status --json
.\PilotMeter-0.1.0-preview.17-win-x64.exe open
.\PilotMeter-0.1.0-preview.17-win-x64.exe stop
```

`watch` 中按 `o` 打开页面、`q` 退出观察。所有 CLI 命令保留，参数用法见 [README](../README.md#命令)；将文档中的 `pilotmeter` 替换为 EXE 路径即可。路径含空格时使用 PowerShell 的调用运算符，例如 `& 'C:\我的工具\PilotMeter-0.1.0-preview.17-win-x64.exe' status`。

EXE 使用 Windows GUI 子系统以避免双击时弹出控制台。交互式 PowerShell 可能不会等待这种 EXE；`watch` 和 `run` 使用上方 `Start-Process -NoNewWindow -Wait`，让终端保持输入归属。重定向与脚本调用的 stdout、stderr 和退出码另有 EXE 回归覆盖。`Start-Process -ArgumentList` 接受命令行文本，自定义参数含空格时须在该文本中加双引号。

`run` 调用 Windows `.cmd` 形式的 Copilot 入口时，连续反斜杠紧接双引号的复杂参数可能被 shim 的多层解析改变。此限制已绕过 PilotMeter EXE，直接通过生产依赖 `cross-spawn` 调用 `.cmd` 独立复现。普通空格、中文、空参数、引号及尾反斜杠组合已测试；需要传递这类复杂参数时，可通过 `PILOTMETER_COPILOT_BIN` 指向独立安装的原生 Copilot `.exe` 入口。EXE 启动器到原生子进程的完整特殊参数集已通过。

需要独立账本时，把 `--data-dir` 放在命令之前。相对路径按当前终端工作目录解析：

```powershell
.\PilotMeter-0.1.0-preview.17-win-x64.exe --data-dir 'D:\PilotMeter 数据' desktop
.\PilotMeter-0.1.0-preview.17-win-x64.exe --data-dir 'D:\PilotMeter 数据' stop
```

## 缓存、数据与升级

首次运行把内嵌运行时和应用解压到稳定目录，后续运行复用同一载荷：

```text
%LOCALAPPDATA%\PilotMeter\runtime\<版本>-<载荷 SHA-256 前16位>
```

默认账本、设置和后台日志仍位于 `%LOCALAPPDATA%\PilotMeter`；`--data-dir` 或 `PILOTMETER_DATA_DIR` 可指定账本目录。EXE 可以放在普通用户可读取的位置，运行时缓存和账本需要可写空间。

升级前，先从旧挂件的右键菜单退出桌面界面，再运行新版。若提示后台版本冲突，先结束采集中的会话，再点击“重启本机服务”；也可通过 EXE 的 `stop` 命令停止对应数据目录的后台。仅关闭主窗口或隐藏到托盘不会退出旧挂件；同一数据目录已有挂件时，再次启动只会唤回该实例。升级不自动清空账本；备份时先退出桌面界面并停止服务，再复制数据目录。

显式执行 `init --statusline` 后，生成的桥接脚本引用解压目录内的 Node 和应用。移动外层 EXE 不改变这一引用；删除旧缓存会使仍引用它的 statusline 失效。升级后可用新版执行 `init --statusline` 更新 PilotMeter 自己管理的桥接脚本，再核对状态栏。若不再使用，先执行 `init --restore-statusline`，再停止服务。保留仍被服务或桥接脚本引用的运行时目录。

这两个配置命令的目标是当前 shell 的 `COPILOT_HOME`，未设置时为普通 `~/.copilot`；不会自动跟随页面选择安装或恢复受管账号独立目录中的状态栏。当前多账号会话可用 `watch` 或页面查看用量。

EXE 已包含官方 Copilot CLI。首次启动解压文件并显示挂件；登录操作创建应用账号配置目录，凭据由官方 CLI 管理，不替换普通 Copilot 配置。`init --statusline` 才会备份并修改相关设置；已有其他 statusline 时仍需按命令给出的变更说明显式使用 `--replace`。

总览优先展示 GitHub 的“高级请求”类别，聊天、代码补全等放在“其他额度”；没有高级请求时，只有唯一有限类别可作为默认主指标，多个有限类别需要明确选择，不相加。单位明确时展示总额、已用、剩余；单位未说明时，主额度区域直接显示已用数值和总额，并标注“单位未确认”，同时保留上游返回的比例。例如接口返回已用 `62000`、总额 `2000000`，界面直接显示 `62,000` 和 `2,000,000`，无需展开原始字段。过去的重置时间不作为下次重置日期。模型页按当前账号的官方 CLI 返回目录和策略展示状态，记录页按账号及月份查看本机消耗；本机明细不代表所有设备或组织共享池的总量。

已用数值优先按同一账号快照的总额减有效剩余量计算，保留剩余量的小数；没有有效剩余量时沿用额度接口返回值。界面会标注来源。GitHub 返回的百分比可能已经舍入，不能用它反算精确的已用数量。

所有额度数量和百分比按完整十进制数值展示，不额外四舍五入，不转换为科学计数法或 K/M 缩写，也不以 `<0.1%` 等阈值代替返回比例。已用、总额、剩余在空间充足时并列，窄窗口调整排列；数值保持单行，极长数值可横向滚动查看。主界面和详情均保留全部小数位，千位分隔符只影响排版。单位不明时第三项明确显示为剩余比例。

右上角显示当前账号与切换入口，侧栏提供“账户管理”和连接状态。切换账号后同步更新额度、模型与本机记录。桌面宠物的选择和设置在账户页，侧栏保留宠物预览入口。

PilotMeter 计量账本不保存对话内容；官方 Copilot CLI 在受管账号目录中保存的会话历史和日志遵循其自身行为，可能包含对话内容。这些文件与计量账本分开，不由 `retention.days` 清理。

## 从源码构建

构建环境需要 Windows x64、Node.js 24.14+、npm，以及 .NET Framework 4.8 和系统 C# 编译器。`csc.exe` 位于系统 `Microsoft.NET\Framework64\v4.0.30319` 目录；其中 `v4.0.30319` 是 CLR 4 路径，不代表应用的最低 Framework 版本。

在仓库根目录执行：

```powershell
npm ci
npm run build:windows
npm run test:windows
npm run release:check
```

构建输出：

```text
build/windows/PilotMeter-0.1.0-preview.17-win-x64.exe
build/windows/PilotMeter-0.1.0-preview.17-win-x64.exe.json
build/windows/PilotMeter-0.1.0-preview.17-win-x64.zip
build/windows/SHA256SUMS
```

完整本地验收与打包可运行 `npm run release:windows`。基于版本标签的 GitHub Release 工作流、版本管理和失败恢复见[打包与发布方案](releasing.md)。

构建时从 Node 官方固定版本下载 Windows x64 运行时，并按固定 SHA-256 验证。Node 24.14.0 的官方 `win-x64/node.exe` 摘要为：

```text
63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088
```

来源：[Node 24.14.0 官方校验清单](https://nodejs.org/download/release/v24.14.0/SHASUMS256.txt)。修改运行时版本时，需要同时更新固定摘要并重新完成 EXE 验收。构建环境需要网络获取依赖和运行时；成品启动无需再下载 Node。

随包保留 PilotMeter 的 MIT 许可证、完整 Node LICENSE、生产依赖许可证、Vite helper、Tailwind CSS 和 WebView2 SDK 的许可证。Node LICENSE 包括其内置组件条款，不能只保留文件开头的 MIT 文本。系统 Framework 和 WebView2 Evergreen Runtime 不随包复制。GitHub Copilot CLI 按其官方独立许可证分发，未经修改的运行时、完整 LICENSE/README 和归属声明均保留；PilotMeter 的 MIT 许可证不替代这些条款。

## 验收范围

`npm run test:windows` 使用实际 EXE 验收，不从源码或开发依赖加载应用；子进程 PATH 不含 Node/npm/Copilot，使用独立用户环境和数据目录。2026-09-28 的 `preview.5` 已在 Windows 11 Enterprise x64（10.0.26200）通过 13 组验收；`preview.6` 另增加内置 Copilot 版本、账号入口和只读运行检查。以下旧版结果保留为回归基线，不代表当前原生产物已经重新验收通过：

- 版本、帮助、只读 `doctor` 和未启动状态正常；首次两个进程并发解包及后续缓存复用正常。
- 后台启动后命令输出正确结束，重复启动复用实例；实际页面 HTML、JavaScript、CSS 和 CSP 可用。
- 合成 OTLP 采集、SQLite 持久化、设置保存、停止及重启通过；演示数据保持独立。
- 中文、空格及特殊字符路径通过；原生测试入口收到完整特殊参数和 UTF-8 stdin，stdout、stderr 和退出码正确。`.cmd` 边界单列记录。
- statusline 安装、stdin、桥接输出及恢复通过；移动外层 EXE 后原桥接脚本仍正常工作。
- 缓存文件被修改时启动器拒绝执行，恢复原始文件后可再次运行。构建检查固定 Node 摘要、精确生产依赖、许可证及包成员白名单，并扫描敏感文件和凭据形态。
- `preview.5` 单独在本机实际 TTY 中验证 `watch` 的 `q` 和 Ctrl+C 正常退出；其无参数入口当时打开浏览器。`preview.7` 已改为桌面挂件，自动化用显式 `start --background` 验证无桌面启动。

`preview.8` 已在本机通过 234 项 Node 回归、36 项 Chromium 回归、626 项原生检查、7 组实际 npm 安装验收和 17 组实际 EXE 验收。原生检查覆盖十个真实嵌入宠物资源、透明渲染、偏好迁移、账号操作与迟到响应隔离、精确额度、模型与分页记录 DTO、JSON 上界、API 白名单、CSRF、服务身份变化和取消请求。EXE 的 x64/GUI 子系统、便携 ZIP、版本清单及 SHA-256 校验通过；三平台与标签发布结果以对应 PR 和 Actions 为准。

`preview.8` 实际 EXE 的原生主窗口启动成功，已读取无账号状态的控件树。四页、880/1280 宽度、十宠物、未知单位和超长数字共 12 张原生控件离屏渲染图完成检查，使用合成数据。当时实际截图返回 `IGraphicsCaptureItemInterop.CreateForMonitor (0x80070057)`；重新选择窗口后，交互仍返回 `GetCursorPos: Access is denied (0x80070005)`。这些离屏图不替代实际点击、拖动、托盘恢复和跨屏 DPI 验收。`preview.7` 的 `watch` TTY 退出检查保留为历史基线。

`preview.13` 在总览和用量记录页增加“启动 Copilot 会话”：先选择已连接账号，再选择项目文件夹，在打开的终端中使用 Copilot。按钮只启动内置 CLI，采集绑定启动时的账号；取消文件夹选择不会启动进程。新会话记录会随页面定时刷新和“同步”更新。本月最近会话独立于记录页的月份与排序。

GitHub 登录只读取当前账号额度与模型，不会下载历史聊天记录。仅从 PilotMeter 启动、且已经产生遥测的会话会出现在本机记录中；未知费用不会按零计。`preview.12` 的实际登录和窗口验证证据见[兼容性记录](compatibility.md)，真实多账号采集与官方账单核对仍待验证。私有账号资料和截图不进入源码库。

未完成的系统/终端验收：干净 Windows 10/11 设备兼容性、真实 Copilot TUI 交互、原生 statusline 渲染以及终端链接点击。PATH 隔离测试不等同于干净系统验收。EXE 未签名。

合成测试不调用真实模型或账单，也不能证明官方月度额度。本机已读取一个真实账号的个人额度快照；官方页面逐项比对、第二个真实账号的完整切换、真实 `/usage` 和组织或企业账单对账仍按[验证指南](validation-guide.md)完成。

系统基线参考：[Node 24.14.0 平台支持](https://github.com/nodejs/node/blob/v24.14.0/BUILDING.md#platform-list)、[Windows 自带 .NET Framework 版本](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)。Node 的官方支持还取决于操作系统是否处于供应商支持期。
