# Windows 打包与发布

Windows x64、Node.js 24.14+、npm 和系统 .NET Framework 4.8 编译器即可构建。成品不要求用户安装 Node 或 npm；HTML 主界面需要 Microsoft Edge WebView2 Evergreen Runtime，缺少时显示官方安装引导。构建脚本获取固定摘要的 WebView2 SDK，样式使用本地 Tailwind 编译。

## 本地一键验收与打包

```powershell
npm ci
npx --no-install playwright install chromium
npm run release:windows
```

该命令运行 Node 单元/集成测试、干净前缀 npm 安装验收、浏览器回归、Windows 构建、实际 EXE 隔离环境验收和发布文件校验。Windows 测试覆盖原生 PET、账户 DTO、loopback 身份校验以及真实 WebView2 中的页面、接口和宿主通信。需要本机已有 WebView2 Evergreen Runtime；CI 工作流会在隔离 runner 上安装 Microsoft 签名的运行时。合成测试不消耗真实账户额度，也不证明组织账单已对账。

输出目录 `build/windows/`：

| 文件 | 用途 |
| --- | --- |
| `PilotMeter-<version>-win-x64.exe` | 直接双击运行的主分发文件 |
| `PilotMeter-<version>-win-x64.zip` | 同一个 EXE、版本清单、使用说明和校验值的便携包 |
| `PilotMeter-<version>-win-x64.exe.json` | 运行时版本、架构、载荷摘要和签名状态 |
| `SHA256SUMS` | 上述三个文件的 SHA-256 校验清单 |

仅重新构建使用 `npm run build:windows`；已有产物验收使用 `npm run test:windows` 和 `npm run release:check`。打包器从官方来源下载固定版本 Node，校验摘要，并锁定官方 Copilot CLI 和生产依赖。十个宠物 PNG 编入原生程序，不依赖设计目录或远程图片。

页面使用本地 Tailwind 构建，不依赖在线 CDN。WebView2 SDK 固定为 `1.0.3537.50`，下载时核验 SHA-256；分发包包含必要的托管程序集、x64 loader 与许可证。`npm run design:export` 可另外生成 `docs/design/desktop-v3.html`，这是内联资源的离线设计稿，示例模式不执行真实账号操作，也不是 EXE 的运行依赖。

## GitHub Release

1. 更新版本：`npm version 0.1.0-preview.17 --no-git-tag-version`，同步修改 `src/shared/runtime.ts` 的 `VERSION`，一起提交 package、lockfile 和运行时版本。安装包验收会拒绝版本不一致的产物。
2. 添加对应版本的 `docs/releases/0.1.0-preview.17.md`，记录实际功能、升级方法与已知边界。
3. 提交 PR，等待三平台 CI 通过后合并 main。
4. 在最新 main 创建并推送版本标签：

```powershell
git switch main
git pull --ff-only
git tag v0.1.0-preview.17
git push origin v0.1.0-preview.17
```

`Windows Release` 工作流会验证标签与 package 版本一致、提交已进入 main、发布说明存在；在 Windows 上重新测试、打包、校验，然后上传 EXE、ZIP、版本清单与 SHA256SUMS。上传先进入草稿，全部成功后才公开；带 `-preview` 等后缀的版本自动标为 Pre-release。

无需个人访问令牌，工作流使用本仓库 `GITHUB_TOKEN` 的 contents 写权限。失败时保留日志与可用产物。也可在 Actions 中手动运行并填写已存在的版本标签；已有 Release 不会被覆盖。若上传中断留下草稿，先检查草稿与失败日志，人工处理后再重试。

当前产物未进行代码签名，清单中的 `signed` 为 false。未来接入组织签名证书时，应在生成外层校验清单前签署最终 EXE，并更新清单与验收；不要将证书或私钥提交到仓库。支持目标为 Windows 10/11 x64，未验证的 x86/ARM64 不作为本版本支持范围。

## 升级

先结束采集中的 Copilot 会话，从旧宠物或托盘菜单退出桌面程序，再执行旧版 EXE 的 `stop` 命令停止后台服务，最后启动新 EXE。账户、账本和宠物选择仍保存在原数据目录，升级不清空。关闭主窗口或隐藏宠物并不退出旧实例，退出桌面界面也不会停止后台；同一数据目录重复启动会唤回已经运行的版本。使用自定义数据目录时，停止和启动命令都应带上相同的 `--data-dir`。
