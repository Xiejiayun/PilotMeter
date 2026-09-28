# 真实数据验收指南

本页描述尚待用户真实账户完成的验收。不要把测试 fixture 或 demo 的结果登记为真实证据。

## 登录与多账号

`preview.6` 随应用提供官方 Copilot CLI 1.0.88，无需为正常登录流程另装 CLI 或实验性 SDK。浏览器中已经登录 GitHub，不代表 PilotMeter 已连接该账号。

1. 在真实仪表盘点击“登录 GitHub”，复制设备码，在官方授权页确认目标账号并完成授权。添加另一账号时先核对授权页的实际登录身份；支持 github.com 和 `https://<tenant>.ghe.com`。
2. 若官方页面要求确认额外权限，先核对该页面所列权限。取得验证码、打开页面或停在确认页，都不算登录成功；以 PilotMeter 完成身份确认并显示账号为准。
3. 确认个人 Copilot 区域显示所选账号的快照及同步状态。与同一账号官方页面核对当前周期、百分比、上限和单位；管理员对用户设置的上限不能当成组织总池。
4. 添加第二个账号，分别启动采集并产生可识别的真实会话，再切换页面。账号记录、额度和预算应各自独立；切换期间不应短暂显示上一个账号的金额或明细。测试重新登录、拒绝授权、取消和过期重试；重新登录时选错身份不得替换原账号。
5. 移除账号应从列表消失，当前选择相应更新。移除 PilotMeter 连接不撤销 GitHub 上的授权，也不删除已采集账本；保留的旧记录仍可从“全部本机记录”查看。

命令行也可操作：

```powershell
pilotmeter account login
pilotmeter account list
# 把下列占位文字替换为 list 返回的账号 ID：
pilotmeter account use "账号 ID"
pilotmeter account refresh
pilotmeter run --account "账号 ID" -- --no-auto-update
# 查看包含不同账号及未分账号旧数据的全部本机记录：
pilotmeter account use none
```

个人额度刷新可能先返回 `refreshing: true`；随后查看页面或 `account list` 确认最终状态，不能把刷新请求已受理算作额度读取成功。个人额度始终对应上游当前周期，不随本机月份选择切换。单位未明确时保留“接口计量（单位未说明）”；即使上游返回百分比，也不能据此推断 AI Credits 或本地 nano AIU 的换算。

本轮真实设备码已成功获取，并到达官方 Copilot CLI 的 Codespaces、plugin gateway 等额外权限确认页，尚待用户确认。因此真实登录完成、额度读取和真实多账号验收仍未登记为通过。本指南不记录私有身份、组织或实际用量。

## 会话和单位

1. 完成上述 PilotMeter 账号登录，用 `pilotmeter doctor` 确认内置 CLI 1.0.88 可用，并用 `account list` 确认所选账号。`PILOTMETER_COPILOT_BIN` 仅用于显式指定其他入口；使用覆盖入口时应另行核验该版本和账号行为。
2. `pilotmeter run -- --no-auto-update` 启动会话，分别验证普通请求、切模型和子代理；每次记录原生 `/usage` 的显示值和结束时间。
3. 用详情页核对顶层调用，不累加 chat/subagent；保存仅含白名单元数据的脱敏样本。
4. 只有确认该实际组合中 nano AIU / 1e9 等于 Credits 后，执行 `unit verify`，证据说明应包含版本、日期和核对场景。未通过时保留原单位。
5. 原生文件 exporter 与 OTLP JSONL 是两个兼容性门槛；先核查实际逐行结构，当前 importer 只承诺 OTLP `resourceSpans` envelope。旧历史 checkpoint 不参与本月求和，SDK 历史适配未包含在预览版。

真实对账期间保留 `retention.days = null` 的默认配置。已清理的明细不能通过关闭策略或重放恢复；页面保留清理记录，不能把清理后的本机小计当作完整历史。

记录按启动时的账号归类。页面切换账号只影响后续启动和当前查看范围，不会更改已启动的采集上下文。在 Copilot 内切换账号后，请退出并从 PilotMeter 重新启动；不能用启动时的身份检查证明整个会话的 OAuth 身份未变化。旧的未分账号记录不会自动归入新登录账号。

## 组织或企业账单

1. 确认组织名或 enterprise slug、真正的付款主体、共享池与用户预算的区别。
2. 在本机安全凭据来源配置 `PILOTMETER_GITHUB_TOKEN`，不要在聊天、命令参数或 JSON 文件中提供 token。个人 endpoint 需要 Plan: read；组织需要相应 Administration: read 与账单角色；企业按端点要求的 token 类型与企业账单权限核实。
3. 重启 PilotMeter，运行 `account connect --organization <name>` 或 `--enterprise <slug>`，再 `account refresh --billing`。权限失败、空报告与不支持单位都有独立状态。此连接与设备码登录的个人账号独立，不能仅凭个人登录推断已有组织账单权限。
4. 核对响应主体、完整 UTC 月、产品、SKU、gross/discount/net 语义。只识别 Copilot 产品时仍属于部分覆盖，不能推断整个额度池。

## quota 证据导入

这是与上方自动读取个人额度分开的高级账单核验入口，不要求普通登录用户填写。需要从固定版本的只读 quota 能力获得真实数据并与官方页面核对；个人 `remainingPercentage` 单独出现不构成组织全池证据。`raw` 是本工具的归一化输入，不能直接复制整个 SDK 响应；例如 SDK 的 `isUnlimitedEntitlement` 要显式映射为 `isUnlimited`，并核实选中的是已验证的月度池。`account import-quota file.json` 接受如下结构（占位符必须替换为真实值）：

```json
{
  "period": "2026-09",
  "raw": {
    "usedRequests": "真实已用十进制数",
    "entitlementRequests": "真实当前额度十进制数",
    "resetDate": "2026-10-01T00:00:00.000Z",
    "isUnlimited": false
  },
  "evidence": {
    "billingEntity": "organization:实际组织",
    "usageSubject": "organization:实际组织",
    "poolId": "实际额度池标识",
    "period": "2026-09",
    "poolKind": "monthly-account",
    "billingMode": "ai-credits",
    "unit": "ai-credits",
    "products": ["已验证的全部同池产品"],
    "identityVerified": true,
    "unitVerified": true,
    "allowanceVerified": true,
    "coverageVerified": true,
    "officialPageCompared": true,
    "allowance": "与 entitlementRequests 一致的真实额度",
    "unlimited": false,
    "verifiedAt": "实际核对时间 ISO-8601",
    "providerUpdatedAt": "官方数据实际截止时间 ISO-8601",
    "evidence": "实际页面、CLI/SDK版本、额度池及核对过程的无敏感信息描述"
  }
}
```

所有 true 都代表已经实际完成的核对。未知事实不能填写 true。新月份、套餐或 flex 额度变化后必须重新核对；导入快照会标陈旧，不自动滚入新月份。无限额要求 `raw.isUnlimited`、`evidence.unlimited` 为 true 且 `evidence.allowance` 为 null。legacy Premium Requests 必须用对应的 billingMode/unit，不可改称 AI Credits。

## 有限范围对账

该入口核对一个有限时点的本机记录与官方账户快照，不会补齐历史，也不会更改任何调用金额。先完成上述真实会话单位、quota 与官方页面核对。当前只支持已验证 AI Credits 的完整账户快照；仅有部分产品的 Billing 报告、未知官方水位或 Premium Requests 会明确显示无法对账。

选中多账号登录中的个人 profile 时，旧的组织账单身份尚未与该 profile 绑定核验，因此不显示该旧账单或启用相关对账。`account use none` 可回到全部本机记录与原账单视图，但这一步本身不验证账本中的多个账号属于同一付款主体；仍需逐项证明下述来源、额度池和覆盖范围。

```powershell
pilotmeter reconcile status --period 2026-09
pilotmeter reconcile inspect --period 2026-09 --output review.json
# 实际核对模板中的来源、池、产品和覆盖范围，填写证据后：
pilotmeter reconcile verify review.json
pilotmeter reconcile status --period 2026-09 --json
# 撤销当月核验，不删除账本或账户快照：
pilotmeter reconcile clear --period 2026-09
```

月份替换成需要验证的 UTC 月。`inspect` 返回阻断原因及待核验模板；`--output` 只写新文件。模板的四个验证标记均为 false，`verifiedAt` 和 `evidence` 为空。只有实际核对通过后，才把相应标记改为 true，填写当前核验时间和不含敏感内容的证据说明；其余由服务生成的身份、池、产品、来源、时间范围与摘要字段保持原样。不能添加用量、额度或其他字段来替换计算结果。

必须逐一证明 `sourceContexts` 中的来源属于同一计费主体和额度池，并证明从 `coverageStart` 到 `coverageEnd` 的本机相关产品记录完整。范围是月初包含、官方截止时间不包含的半开区间，不使用抓取时间冒充官方水位。新启用采集或存在历史缺口时不能勾选完整覆盖。数据目录包含不同付款主体时，不能笼统绑定为一个账户；按账户使用独立 `--data-dir` 并保留来源标记。

已结束月份可以用下月月初作为不包含的官方截止时间，核对完整自然月；实际核验时间可在该月结束后。必须取得对应历史月份的官方快照，不能自行把月内水位改成月末，或把当前月用量当作旧月结账结果。

证据有效期为核验后 15 分钟。任何新账本事件、来源、冲突、重新分类、单位证据或账户快照变化都会使旧证据失效；相同事件重放不失效。重启保留证据及原始数据，但不会延长时效。正差额仅表示“暂未归属”，负差额为“尚未对齐”；账户快照陈旧时明确标有限时点参考，页面离线或证据过期不继续展示可用差额。

无法归月的异常、缺失/待分类计量、可能影响该月的明细清理，以及无法定位时间的拒绝数据都会阻止完整范围声明。未知不计零。后续恢复必须取得完整可靠来源后重新导入并核验；无法定位的拒绝记录不能凭手工证据抹除，必要时在独立数据目录导入已核实的完整记录，保留原账本用于审计。

## 终端与配置

- 独立测试 Windows Terminal 的 OSC 8 / Ctrl+点击、普通 URL、watch 的 `o`/`q`、Ctrl+C 和窗口缩放。
- `init --statusline` 的脚本执行与 Copilot 状态栏渲染分别验收。它和恢复命令使用当前 shell 的 `COPILOT_HOME`，未设置时为普通 `~/.copilot`，不会自动配置页面选中的受管账号目录。先确认正在验收的配置目录，再查看已有状态栏的替换方案；验证 stdin JSON、stdout 单行、刷新时延及原生链接保留情况，最后恢复并核对无关设置未变。受管账号目前可用 `watch` 或页面查看用量。
- SSH/WSL 使用实际 loopback 地址及显式端口转发，不切换公网监听。

完整发布门槛：真实账号登录及切换可用；至少一个实际订阅+CLI组合中，会话用量与 `/usage` 一致，个人额度和组织全池分别与对应官方页面完成核验。个人上游百分比通过，不等于组织全池对账通过；未完成的范围继续明确标记，保持预览版标签。
