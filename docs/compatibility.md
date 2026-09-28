# 兼容性与验证记录

更新：2026-09-28。本页仅记录实际证据；合成测试不能代替真实账单与 `/usage` 对账。

## P0 基线

| 项目 | 实际结果 |
| --- | --- |
| 操作系统 | Windows，PowerShell，工作区 `C:\workspace\PilotMeter` |
| Node / npm | 24.14.0 / 11.9.0 |
| GitHub 仓库 | `Xiejiayun/PilotMeter`，系统 Git 凭据有管理权限 |
| Copilot CLI | 隔离安装 `@github/copilot@1.0.88`，实际版本/帮助与 SDK stdio 连接通过；只读 `auth.getStatus` 返回未登录，尚无真实会话对账 |
| 计费主体 | 用户确认组织或企业付费；具体主体和只读账单权限待连接 |
| 单位换算 | 官方文档有 nano AIU 换算说明；实际订阅未验证，默认显示原始 nano AIU |
| 官方月度比例 | 未验证额度池、单位、完整覆盖和分母；保持不可用 |
| 原生状态栏 / OSC 8 点击 | 真实终端行为待验证，提供普通 URL 和 open 备用入口 |
| macOS / Linux | GitHub hosted runners 已通过构建、单元/集成测试和真实包安装，Linux 另通过浏览器测试；原生终端交互尚未实测 |

## 已完成的工程验证

- `preview.4` 的 122 项 Node 单元/集成测试通过，包括事件分类/去重、BigInt、UTC 月度、文件恢复、账户边界、鉴权、崩溃锁竞争、来源隔离、演示隔离、JSONC 恢复、明细清理回滚、限流恢复、对账及待分类超时与迟到证据恢复。
- `preview.4` 的 22 项 Chromium 测试通过：21 项状态/布局测试以及实际 daemon 的页面、CSRF 编辑和会话详情联调；桌面和 320px 截图已检查。
- Windows 的真实 npm 全局 `.tgz` 安装通过 7 组验收，生产安装无需 TypeScript/Vite/Playwright。真实 CLI shim、后台复用、静态资源、demo、停止和重启均通过。
- 原生 Copilot 1.0.88 的实际版本和帮助命令通过；不发起模型请求。状态栏桥接脚本本身已实测中文、空格和特殊字符路径与 stdin；原生 TUI 的渲染/点击仍未验证。
- Windows npm 11.9.0 的全局 prefix 不支持 `&`；这是生成的 npm shim 在应用启动前的问题。应用的数据目录参数可以包含 `&`。详见 [npm 安装包验收](npm-package-contents.md)。
- GitHub Actions 固定 Node 24.14.0，三平台构建、测试与打包，Windows/Ubuntu 另运行 Chromium；最新结果见 [CI 记录](https://github.com/Xiejiayun/PilotMeter/actions/workflows/ci.yml)。CI 结果与真实终端点击验收分别记录。
- 只读认证探针未发送模型请求、读取凭据或修改真实用户配置；`account.getQuota` 在未登录状态返回 `-32603`，不能作为额度数据。当前进程未配置 `PILOTMETER_GITHUB_TOKEN`。

## 能力边界

- `preview.4` 增加 24 小时待分类超时诊断。超时从首次采集时间计算，不从历史调用结束时间计算；仍保持 pending 并排除费用，真实祖先后到可重新判定，已有超时诊断保留。
- `preview.3` 对账入口通过显式证据验证全部来源、账户池、产品和月初至官方截止的半开范围；金额来自真实账本查询，证据不能覆盖金额。账本或快照变化、无法定位异常、清理影响和证据过期均阻止比较。工程测试使用合成数据，不构成真实账户核验。
- `preview.2` 增加显式 `retention.days` 策略，默认关闭。schema v2 升级前备份；清理原子提交并保留最小 trace 防重放标记，不恢复已清理历史。时间不明、跨阈值或冲突 trace 保守保留。
- 模型 chat 小计按贡献记录单独核实 CLI 版本，未知版本保留原始单位，异常或冲突记录列入未知，不能套用当月顶层调用的单位证据。
- Billing 403 有限流头时执行退避；普通权限错误保持暂停。重启后恢复失败快照及重试截止时间，不通过重启提前再次请求。

- 当前已核查的采集分类规则固定为 CLI `1.0.88`：`invoke_agent`，合法 server address/port，且祖先链不含其他 invoke_agent。未知版本或缺失祖先保持待分类。
- 组织、企业付费不能通过个人 endpoint 的空列表证明零用量；端点按显式主体选择。
- 测试 fixtures 均为人工合成，只用于验证解析、精度、幂等和边界，不冒充真实脱敏账单。
- 首版以启用采集后的本地记录为准。SDK 历史读取属于独立后续适配，不读取或恢复活动会话。
- JSONL 已验证格式为每行一个 OTLP traces `resourceSpans` envelope，原生 CLI file exporter 格式尚未取得真实样本。不能把本格式的合成测试算作原生文件兼容证据。
- quota 提供显式验证证据导入边界，不自动安装实验性 SDK。组织文档中其他 SKU/单位组合暂为 unsupported；完整额度池覆盖不能从单一产品推断。
- npm 本地包验证与公开发布分开；未获得发布账号、包名归属和公开发布授权前不发布。

## 真实验收仍需的证据

1. 具体组织或企业及有权限的专用只读凭据来源（不把 token 写入源码、命令参数或文档）。
2. 同一 CLI 会话的普通请求、切模型和子代理场景：遥测顶层计量与 `/usage` 对照。
3. 官方页面与 quota 的月度池、单位、周期、分母和同池产品覆盖；共享池与用户预算分别核实。
4. Windows Terminal 和 Copilot 状态栏分别测试链接、stdin、stdout、Ctrl+C。

这些门槛未通过时产品是本地用量预览，不能宣称官方月度额度功能已经验证。
