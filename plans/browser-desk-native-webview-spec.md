# browser-desk 内嵌可交互浏览器方案（cap.webview 原语 + 插件驱动，W1）

> 日期：2026-11-13 · 状态：**已分析待批准**（用户裁定「先记录」）
> 上位文档：`plans/browser-desk-coexistence-plan.md`（共存期方案，已实施）· `plans/browser-plugin-full-extraction-spec.md`（方案 D 全外迁）

---

## 1. 背景与需求

browser-desk 插件 v0.1.0 已落地（共存期，MCP 21 工具 + 面板控制台 + screencast 内嵌视图）。用户实测后反馈：

1. MCP 工具可用 ✅（四层链路根因已修复：主仓 `be63c6a6`/`9b3a855e`/`ce9f63b7` + 插件仓 `5109dbe`/`59a2be4`/`ae6edc2`）
2. **画面渲染体验不佳**：screencast JPEG 帧流（250ms 轮询）动效卡顿、文字发虚，事件回传模拟交互缺右键菜单/输入法/文本选择
3. 期望：**面板里就是一个真浏览器**（原生 WebView2 手感），而非帧画面

## 2. 技术选型结论

| 路径 | 结论 |
|---|---|
| **W. 宿主子 webview（选定方向）** | 宿主提供通用 `cap.webview` 托管原语；插件面板上报自身 DOM 矩形，宿主把原生 WebView2 精确叠放在面板位置。画面/交互原生。技术先例 = 已移除的内置浏览器（`commands/browser.rs` 的 WebviewBuilder + add_child + set_bounds 全套成熟实现可参考） |
| iframe 直嵌 | 主流站点 X-Frame-Options/CSP 拒绝，否 |
| screencast 继续优化 | 天花板明显（帧率/清晰度/交互模拟），保留为 **web 模式降级**，不废弃 |

## 3. 架构定案（W1：用户与 AI 同视口）

- **宿主新增 `cap.webview`**（通用 webview 托管原语，无浏览器业务；定位同 `cap.terminal` 之于 PTY）：
  - 动作：`create(label, url)` / `destroy(label)` / `set_bounds(label, rect)` / `show` / `hide` / `navigate(label, url)` / `eval(label, script)` / `list`
  - 生命周期硬规则：面板隐藏/关闭/插件停用 → 对应 webview 销毁（防 orphan，旧浏览器教训）
  - 坐标通路：面板 `getBoundingClientRect` 上报 → 宿主换算窗口坐标（旧 BrowserPanel→browser_set_bounds 同款）
- **插件 browser-desk**：
  - 面板：EmbeddedView 改为「占位 div + ResizeObserver 上报 bounds + 请求 create/定位」；交互代码删除（原生 webview 自带）
  - service：保留标签编排/下载管理/会话绑定；AI 工具后端从 CDP 切到宿主 cap.webview
- **AI 工具面**：desk_* 21 工具名不变，实现层切到宿主（用户与 AI 操作同一个 webview，AI 看到用户正在看的页面）
- **web 模式降级**：浏览器访问（无原生 webview）时保留 screencast 路径或明确提示仅桌面可用

## 4. 边界与风险

- 宿主不再是「零残留」：但 cap.webview 是通用原语（非浏览器业务），与 cap.terminal 同级辩护
- webview 生命周期管理必须干净，否则重蹈旧浏览器 orphan webview 覆辙
- mosi 供应商并发限额紧（429 concurrency_limit_exceeded），测试需串行留冷却

## 5. 工作量预估

- 宿主 cap.webview capability：~400-600 行 Rust（参考 browser.rs 成熟实现通用化）
- 插件面板改造：EmbeddedView → 占位 div + bounds 上报
- AI 工具后端切换（desk_* → cap.webview）
- 合计约 2-3 天

## 6. 实施记录（待补）

未开始。
