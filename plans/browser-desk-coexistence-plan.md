# browser-desk 插件化共存期方案（架构方案 D-共存版）

> 日期：2026-11-12 · 状态：**P0–P3 已实施完成**（插件仓 commit `51b9e51`），P4/P5 待后续批准
> 上位文档：`plans/browser-plugin-full-extraction-spec.md`（方案 D 全外迁）· `plans/core-slimdown-plugin-extraction-plan.md` §4.1 B1-7
> 用户裁定（2026-11-12）：先建插件、不删宿主；需支持多窗口、AI 经 MCP 实时交互；如需改宿主须通用兼容、避免死代码。

---

## 1. 与原方案 D 的差异

| 项 | 原方案 D | 本方案（共存版） |
|---|---|---|
| 节奏 | 插件与删码一体推进 | **明确共存期（P0–P4）宿主零改动** |
| 工具名 | `browser_*` 直接沿用 | 共存期 `desk_*` 前缀（与内置 polaris-browser 并存零歧义），P5 删码后评估是否改回 |
| 多窗口 | 未展开 | tab 池 + agentKey 绑定（30min TTL）+ `newWindow`/`require_new` 开新窗口 |
| 实时交互 | 未展开 | `desk_watch`（事件环长轮询增量）+ `desk_wait`（selector/urlPattern/downloadComplete/dialog 服务端挂起） |
| 面板调用服务 | 未展开 | 面板 → `cap.pluginServiceManager.request`（宿主通用转发，P1 已有能力）→ service `/dispatch`；面板不直连端口 |

## 2. 插件形态（Polaris-plugin 仓 `plugins/browser-desk`，已落地）

- **service**（`contributes.services`，Supervisor 托管，autoStart）：puppeteer-core 驱动系统 Chrome（`headless:false, defaultViewport:null`，网页开独立 Chrome 窗口）；tab 池 + agentKey 绑定表 + 每 tab 200 条事件环 + 等待器 + 下载跟踪（`Browser.downloadWillBegin/Progress`）；`/dispatch`（16 action）+ `/__health`（degraded 不致命）。
- **MCP**（stdio，`contributes.mcpServers`）：16 个 `desk_*` 工具；服务端口三级自发现（`BROWSER_DESK_SERVICE_PORT` env → cap.kv `browser-desk/service-port` → 9700–9719 扫描），发现失败不缓存、下次调用重试（冷启动竞态已修）。
- **面板**（shadow 接管 `browser` 席位，`enabledByDefault:false` 手动启用）：搜索框 / 标签列表（激活/关闭/新窗口）/ 搜索结果 / AI 操作日志 / 引擎状态徽章 + Chrome 缺失安装引导；数据全部经宿主 `cap.pluginServiceManager.request` 转发，面板不感知端口。
- **依赖策略**：puppeteer-core 不进 zip；service 启动时探测插件目录 node_modules，缺失则 `npm install --no-save puppeteer-core@25`。

## 3. 宿主改动

**零改动。** 面板服务转发用的是 P1 Git 域落地时新增的通用能力 `cap.pluginServiceManager.request`（非本插件专用）；shadow 席位、PTT/视图声明、MCP 注册均为既有机制。符合「改宿主须通用兼容」约束。

## 4. 已验证

- 插件仓单测 11 项全绿（stub 注入，覆盖 acquire/reuse/agentKey 路由/事件环/等待超时/批量关闭）。
- 真机 E2E（本机 Chrome 157）：双窗口并行、agentKey 路由、`desk_search`（bing 结构化 3 条）、`desk_read`（正文抽取）、`desk_watch`（navigation 事件）、`desk_status`、`desk_close(all)` 全通过。
- MCP 全链路冒烟（真实 service + 真实 MCP 子进程 + 真实 Chrome）：acquire→search→read→status→close 全 PASS（`test/mcp-smoke.mjs`）。
- 面板 esbuild 构建通过、tsc 无错、plugin.json styles 同步机制沿用 terminal-desk 范式。

## 5. 后续阶段（待批准）

- **P4 切换默认**：稳定运行后可将内置壳 `polaris.browser` 的 `enabledByDefault` 置 false（一行、可逆），引导用户使用 browser-desk。
- **P5 宿主删码**：按 `browser-plugin-full-extraction-spec.md` §4 清单执行（后端 5,433 行 + 前端 6,821 行 + 注入脚本），工具名评估改回 `browser_*`；删码后本插件的 acquire/agentKey/mode 语义即行为金标。

## 6. 已知边界

- 圈选（marquee/region-select）、AI overlay、assert/storage 旧工具未承接（webview 时代语义；CDP 下由 `desk_evaluate` 等原生替代），README 已列明。
- web 端（9827）下插件 service 同样起 Chrome，天然同构可用——顺带补齐了内置浏览器「web 模式全拒」的旧缺口。
- 首次启动需 npm install puppeteer-core（约 1–2 分钟），期间 `/__health` 返回 starting，面板显示启动中。
