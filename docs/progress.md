# 分阶段实施记录

| 阶段 | 实现 | 验证与 PR |
| --- | --- | --- |
| P0 数据与终端验证 | 环境、计费主体和验证门槛已记录，隔离 CLI 1.0.88 版本/帮助已实测 | PR #1 已合并；实际账单和 Copilot 会话验证待连接 |
| P1 npm 骨架与采集 | CLI、loopback 服务、SQLite、OTLP、JSONL 已实现 | 21 项测试通过，PR #2 已合并 |
| P2 账户与展示领域 | 精确数值、三种模式、账单主体、quota 证据门槛、刷新退避已实现 | PR #3 已合并；真实组织账单待凭据 |
| P3 终端与页面 | run/watch/statusline、JSONC 可恢复配置、响应式会话页面、独立 demo 已实现 | PR #4 已合并；68 项单元/集成测试与 11 项浏览器测试通过 |
| P4 安装与边界验证 | 真实 `.tgz` 全局安装、离线使用指南、三平台 CI 与包内容检查已实现 | Windows 7 组安装验收通过；[PR #5](https://github.com/Xiejiayun/PilotMeter/pull/5) 已合并，三平台 CI 全部通过 |

每阶段提交并通过 PR 合并；不会把未通过的外部验证记录为完成。

## 方案逐项审计后的补齐

`preview.2` 补上默认关闭的明细保留策略、schema v2 迁移备份、永久防重放标记与清理后的范围说明；同时修复限流/权限状态跨重启恢复、模型分项单位验证、打开详情刷新和终端缓存/链接边界。Windows 已通过 90 项单元/集成测试、15 项 Chromium 测试及 7 组真实安装包验收；[PR #6](https://github.com/Xiejiayun/PilotMeter/pull/6) 三平台 CI 全绿并已合并。

`preview.3` 接通对账 CLI/API 与页面入口，通过账本和账户快照摘要绑定有限范围核验证据，支持已结束的完整 UTC 月；没有充分证据时不显示差额。110 项 Node 测试、21 项 Chromium 测试和 7 组安装验收通过；[PR #7](https://github.com/Xiejiayun/PilotMeter/pull/7) 三平台 CI 全绿并已合并。真实账户验证仍未完成。

`preview.4` 补齐最后一项工程缺项：待分类调用从首次采集起超过 24 小时后记录超时诊断；仍排除计费，后到证据可重新判定。维护、重放和重启不重复记录超时，详情页区分普通待分类与超时。

`preview.4` 的 [PR #8](https://github.com/Xiejiayun/PilotMeter/pull/8) 已合并，三平台 CI 全绿。首版工程功能已按方案逐项复核；下列真实验收门槛通过前，整体目标仍未完成。

## Windows EXE 分发

`preview.5` 按用户需求增加 Windows x64 单文件 EXE，内置校验过的 Node 24.14.0 和锁定的生产依赖，无需用户安装 Node/npm。无参数启动后台服务并打开页面；CLI、独立账本与可恢复 statusline 继续可用。

本机 122 项 Node 测试、22 项 Chromium 测试、7 组真实 npm 安装验收及 13 组实际 EXE 验收通过。EXE 验收使用 PATH 无 Node/npm 的隔离环境，覆盖并发首次启动、后台输出结束、采集持久化、原生参数/stdio、移动 EXE 后的 statusline 和缓存篡改拒绝；本机 TTY 的 `watch` 退出与无参数打开页面另外实测。三平台 CI 继续运行，Windows job 新增实际 EXE 构建、验收和资产上传。详细范围及 `.cmd` 参数边界见 [Windows EXE 指南](windows-exe.md)。

该分发仍为未签名预览版；EXE 可直接运行不代表真实订阅或官方额度已通过对账。

## 剩余发布门槛

- 用户已确认组织/企业付费，但具体组织/enterprise slug、只读账单权限和专用凭据尚未提供。
- 本机只读检查确认 Copilot CLI 当前未登录；登录后进行真实普通请求、切模型、子代理与 `/usage` 对账，取得原生 file exporter JSONL 脱敏样本。
- 官方月度池、真实额度和完整产品覆盖与官方页面核对；通过前不启用官方百分比。
- Copilot 原生状态栏实际渲染、Windows Terminal 点击/Ctrl+C 的最终人工验收。
- npm 公开发布未执行：名称候选在当前代理仓库查询为未找到，但这不证明名称归属或发布权限；公开发布另需明确授权。

SDK 历史补齐属于方案明确列出的后续可选适配，本次预览不读取历史 journal，不承诺全历史。
