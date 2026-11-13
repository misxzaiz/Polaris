# browser-desk 插件化全外迁方案（架构方案 D）

> 日期：2026-11-12 · 状态：实施中（worktree 独立分支）
> 上位文档：`plans/core-slimdown-plugin-extraction-plan.md` §4.1 B1-7（本方案替代其「两步走」路径）
> 用户裁定（2026-11-12）：全部外迁；现有内置浏览器不好用，至少需要提供搜索网上内容及交互等基础功能。
> 决策依据分析：见本文件 §1。

---

## 1. 方案定型：为什么是「全外迁 + CDP 引擎」而非「薄 cap.browser」

旧总纲 B1-7 的两步走方案（宿主保留薄 `cap.browser` webview 原语）有一个隐性成本：webview 属宿主进程，所有面板/MCP 请求都要经宿主转发，且现状难用的四个根源（bounds 同步抖动、下载盲区、web/桌面行为分裂、wry 注入脚本受限）全部保留。

本方案换引擎：插件 service 用 puppeteer-core 驱动系统 Chrome（CDP 协议），彻底离开宿主 webview。收益：

1. 搜索/导航/JS 执行是 Chrome 原生能力，AI 搜索闭环（查询→结构化结果→点击→读正文）不需要手写注入脚本。
2. web 端（9827 浏览器访问）与桌面同构——插件 service 同样起 Chrome，面板只是显示层，`web-mode-browser-availability.md` 的四层缺口问题消失。
3. 下载管理走 CDP `Browser.setDownloadBehavior`，四层缺口（browser-download-manager.md §1.1）一次性解决。
4. 宿主净删 ~9.7k 行且**零残留**（连 cap 层都不需要），比 Git 域方案 C 更彻底。

已核实的事实基础：
- 本机 Chrome 157 与 Edge 并存（`C:\Program Files\Google\Chrome\Application\chrome.exe`）。
- 插件进程驱系统 Chrome 有先例：animation-2d 的 render.mjs 用 puppeteer-core + executablePath。
- puppeteer-core 88MB 不进 zip（见 §5 打包策略）。

## 2. 插件形态（Polaris-plugin 仓 `plugins/browser-desk`）

| 部分 | 实现 |
|---|---|
| service（常驻 Node） | `service/main.js`：HTTP /dispatch + /__health；puppeteer-core launch 系统 Chrome（headless 可配）；标签/会话池；下载事件；结构化搜索 |
| MCP（stdio） | `mcp/server.js`：工具面见 §3 |
| 面板（shadow 接管 browser.panel 席位） | 控制台形态：搜索框 / 标签列表（打开·激活·关闭）/ 打开 URL / AI 操作日志 |
| shared | `shared/core.js`：标签模型与搜索 URL 模板（面板与 MCP 同口径） |

Chrome 定位顺序：`BROWSER_DESK_CHROME` env → 常见路径（Chrome/Edge）→ 找不到则面板给引导（不崩溃）。

**面板显示形态裁定**：网页在独立 Chrome 窗口（`headless: false, defaultViewport: null`），面板做控制台。理由：Chrome 原生体验（用户已习惯）、零 bounds 同步、MVP 复杂度最低；screencast 内嵌列为后续增强（chrome-devtools MCP 已证明可行）。

## 3. MCP 工具面（AI 交互契约）

兼容现有 `browser_*` 命名（AI 提示词零改动），第一批实现集：

| 工具 | 参数 | 语义 |
|---|---|---|
| browser_list | — | 列出打开的标签（id/title/url） |
| browser_navigate | url / query | 打开或导航（query 走搜索引擎） |
| browser_search | query, engine? | **搜索并返回结构化结果**（title/url/snippet 数组）——新增，AI 搜索闭环核心 |
| browser_read | url? | 抽取当前页/指定 URL 正文（打分容器算法） |
| browser_click | label?, index?, text? | 点击元素 |
| browser_fill | label?, index?, value | 填表 |
| browser_press_key | keys | 键盘 |
| browser_scroll | amount?, direction? | 滚动 |
| browser_screenshot | label?, fullPage? | 截图（base64） |
| browser_status | — | 引擎/标签状态 |
| browser_close | label? | 关标签 |
| browser_find | query | 页内查找 |
| browser_evaluate_script | script | JS 执行（AI 逃生舱） |
| browser_history | label? | 历史 |

未在本批实现的旧工具（assert/storage/marquee/overlay 等）在 README 列明「未承接」；这些依赖 webview 时代语义，CDP 下要么原生替代要么放弃。

## 4. 宿主删码清单（主仓，分独立 revert 的 commit）

### 4.1 后端删除
- `src-tauri/src/commands/browser.rs`（4049 行）+ `commands/mod.rs` 声明
- `src-tauri/src/commands/browser_scripts.rs`（407 行）+ 声明
- `src-tauri/src/services/browser_mcp_server.rs`（977 行）+ `services/mod.rs` 声明
- `src-tauri/src/bin/polaris_mcp.rs` 的 browser 子命令分支
- `src-tauri/src/lib.rs`：706（set_browser_app_handle）、1053-1085（35 命令注册）、browser 相关 import
- `src-tauri/src/services/ask_listener.rs`：handle_browser_frame / dispatch_browser_frame + "browser" 帧分支
- `src-tauri/src/services/mcp_config_service.rs`：BROWSER_MCP_SERVER_NAME / BROWSER_PLUGIN_ID 注册与 plugin 映射
- `src-tauri/src/web/api/ipc.rs`：browser_check_embed 分支 + starts_with("browser_") 拒绝分支（后者保留语义但改提示「由 browser-desk 插件提供」）
- `src-tauri/src/ai/engine/simple_ai/tools/browser.rs`（172 行）+ tools/mod.rs 注册

### 4.2 前端删除
- `src/components/Browser/` 4 文件（2706 行）
- `src/services/tauri/browserService.ts`（774 行）+ index.ts 导出
- `src/stores/browserDownloadStore.ts` / `browserSidebarStore.ts` / `marqueeStore.ts`（圈选域一并退役）
- `src/hooks/useBrowserVisibilityGuard.ts`
- `src/plugins/browser/manifest.ts` + builtinPlugins.ts 注册行
- App.tsx：browserContent / useBrowserVisibilityGuard 接线（LeftPanel 的 browserContent prop 与席位机制保留）
- useAppInit.ts：browserClearOrphanedSessions 调用
- useAppEvents.ts：browser://acquire-request 监听（AI 主动开 tab 通道，改由插件 MCP 承接）
- tabStore.ts：browserClose/makeBrowserWebviewLabel 引用（browser tab 类型保留——插件经通用 panelType 机制接管）

### 4.3 保留（席位契约，同 terminal/git 范式）
- `builtinPlugins.ts` 的 `browser.panel` 视图声明（id/panelType/icon/slot）
- LeftPanel browserContent prop 通道（改为占位或插件 shadow）
- tabStore 的 TabType 'browser' 与 openBrowserTab 入口

### 4.4 类型救出
- `BrowserRegion` 等类型被 conversationStore/types.ts 与 ContextBlockPreview 消费——圈选域退役后这些类型随消息历史数据兼容保留（types 定义内联化，不依赖 browserService）

## 5. 打包策略

puppeteer-core 88MB 不可进 zip。方案：**service 启动时解析 node_modules，缺失则 npm install --no-save puppeteer-core**（animation-2d 开发态同模式产品化）。宿主自带 node，插件目录可写。离线机器：面板给「无法获取浏览器引擎」引导。后续演进：裸 CDP WebSocket 协议（ws ~1MB）替代 puppeteer 依赖，本批不做。

## 6. 验收门禁

1. 插件仓：service 真实浏览器 E2E（search→read→click 闭环）+ MCP 冒烟 + typecheck
2. 主仓：`pnpm typecheck` / `pnpm lint` / `pnpm test:run` / `cargo check` / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`
3. grep 断言：主仓无 `commands::browser` / `browser_mcp_server` / `BrowserActionDispatcher` 残留；前端无 browserService import 残留
4. 真宿主 E2E：9827 打开 browser 席位→插件面板接管→搜索→AI 经 MCP 调 browser_search 返回结构化结果
