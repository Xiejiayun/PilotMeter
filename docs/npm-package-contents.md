# npm 安装包验收

更新：2026-09-28。此记录对应 Windows、Node.js 24.14.0、npm 11.9.0 的本地 `.tgz` 安装测试；不代表已公开发布，也不代替真实 Copilot 用量或官方账单对账。

## 复现

以下开发验收命令在项目源码仓库根目录运行。安装包附带兼容性记录、验证指南、Windows EXE 指南和本文，供安装后离线查阅。

```powershell
npm ci
npm run test:pack
```

`scripts/pack-smoke.mjs` 先执行实际 `npm pack --json`（包含 `prepack` 构建），再用真实 `.tgz` 做独立全局安装。测试通过安装生成的 `pilotmeter.cmd` 运行，当前目录位于临时目录，不从工作区加载开发工具。

默认只读取当前 npm 的仓库地址，写入测试专属的 npm 配置与缓存；不复制用户凭据。可通过 `PILOTMETER_TEST_NPM_REGISTRY` 显式指定支持 HTTPS 的仓库或企业代理仓库。仓库 URL 不接受用户名、密码或查询参数，不关闭 TLS 校验。

## 已通过的验收

| 检查 | 结果 |
| --- | --- |
| 包内容与完整性 | 验证实际 tarball 的 SHA-512，与 npm 返回的 integrity 一致；对所有包成员执行严格白名单检查 |
| 生产安装 | 独立全局 prefix，`--omit=dev --ignore-scripts`；无 TypeScript、Vite、Playwright 等开发依赖 |
| 生成的命令入口 | 通过 npm 生成的 `.cmd` 执行帮助、版本、只读 `doctor`、未启动状态 |
| 路径 | 安装 prefix 含中文、空格、括号；数据目录另含 `&`，参数可正确传递 |
| 后台生命周期 | loopback 健康检查、重复启动复用同一实例、正常停止、重新启动 |
| 页面 | 包内 HTML、构建后的 JavaScript 与 CSS 均可通过实际 daemon 加载；CSP 存在 |
| 空账本 | 未采集消费保持未知，未显示官方百分比；帮助和 `doctor` 不创建数据目录 |
| 设置 | 通过安装命令设置预算，重启后保留 |
| 演示 | `<data-dir>/demo` 独立账本，标记为虚构数据，真实账本仍为空 |
| 隐私与清理 | 包内不含源码目录、测试、数据库、日志、环境文件；扫描 GitHub 凭据形态和私钥形态；停止本次实例后仅删除测试拥有的临时目录 |

包内允许 `package.json`、`README.md`、`LICENSE`、`docs/compatibility.md`、`docs/validation-guide.md`、`docs/npm-package-contents.md`、`docs/windows-exe.md`、`docs/releasing.md`、CLI 入口、`dist` 编译产物和 `public` 静态资源。五份文档均列入打包与验收白名单，验收脚本要求它们实际存在。`dist` 中的类型声明与 source map 属于编译产物；不打包 `src` 或测试 fixtures。README 中的实施方案和分阶段进展使用仓库完整链接。

## Windows npm shim 的已知限制

实际尝试将全局 prefix 设置为包含 `&` 的路径时，npm 11.9.0 生成的 `.cmd` 在 PilotMeter 代码执行前失败。生成脚本中的 `SET dp0=%~dp0` 没有引用路径，导致 `&` 被命令解释器当作命令分隔符。

因此当前验证范围要求 **Windows npm 全局安装目录不含 `&`**。中文、空格和括号已通过实际安装验证；`--data-dir` 参数中的 `&` 已通过。测试不会修改 npm 生成的 shim 来掩盖这个限制。

本机公共 npm 仓库直连曾返回 TLS handshake failure；使用已配置的企业代理仓库后安装通过。这是测试环境的网络差异，不通过关闭证书验证绕过。

## 验证范围

这个脚本不调用模型、不连接真实账单、不安装状态栏，也不打开浏览器。它验证打包产物与真实命令入口可用。浏览器交互由 `npm run test:e2e` 覆盖；真实订阅、终端链接和 `/usage` 对账门槛见[兼容性记录](compatibility.md)，操作步骤见[验证指南](validation-guide.md)。
