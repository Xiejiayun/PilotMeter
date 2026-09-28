# PilotMeter icon

深蓝圆角底，白色开口计量环和冰蓝导航指针，将 Pilot（导航）与 Meter（用量监测）合为一个符号。图标是固定品牌标志，不代表实时用量或连接状态。

- 矢量原稿：[`web/assets/pilotmeter.svg`](../../web/assets/pilotmeter.svg)
- 透明背景 PNG（512 × 512）：[`web/assets/pilotmeter-512.png`](../../web/assets/pilotmeter-512.png)
- Windows / favicon：[`web/assets/pilotmeter.ico`](../../web/assets/pilotmeter.ico)，含 16、20、24、32、40、48、64、128、256px，支持不同 DPI。
- [浅色、深色背景与实际尺寸预览](pilotmeter-icon-preview.png)

网页页头与 SVG favicon 引用同一原稿，Windows 启动器使用同一 ICO。`DesktopBrand.cs` 提供原生桌面共用的图标加载器；主窗口与托盘的调用随桌面功能一并合入，挂件中的动态飞行员仍独立绘制。

修改 SVG 后，在已有开发依赖的工作区重新导出：

```sh
npx playwright install chromium
node scripts/generate-icons.mjs
npm run build
```

生成脚本通过 Chromium 渲染 SVG，并生成透明 PNG、多尺寸 ICO 和预览图。ICO 的小尺寸使用 32 位 DIB，256px 使用 PNG，兼容 .NET Framework 与 Windows 资源管理器。生成的资产提交到源码，正常构建和使用应用无需运行图标生成脚本。
