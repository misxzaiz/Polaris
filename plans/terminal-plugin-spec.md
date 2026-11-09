# 终端插件化 spec（terminal-desk）

> 目标：把内置终端改为插件实现——先实现插件（stdio 模式，不占端口），验证后接管内置席位，最后拆除内置代码。
> 日期：2026-11-10。状态：实施中。

## 一、背景与目标

内置终端是主仓硬编码功能：前端 `src/components/Terminal/`（6 文件）+ `src/stores/terminalStore.ts`，后端 `src-tauri/src/commands/terminal.rs`（portable-pty 0.8）。按「插件优先」治理方向（AGENTS.md §五，2026-10-30 定案），终端应迁为插件。

- **不占端口**：不采用 docker-desk 式 HTTP service；PTY 留在宿主进程（能力已在跑，零新增风险），插件只做 UI + 编排。插件如需 AI 工具，走 `mcpServers` stdio（宿主既有通道）。
- **先共存、后接管、再拆除**：插件以独立视图安装验证 → shadow 接管内置席位 → 拆除内置代码与旧命令。

## 二、现状勘察结论（2026-11-10 实测）

| 事实 | 位置 |
|---|---|
| PTY 后端完备：`terminal_create/write/resize/close/list/get` 5+3 命令，读线程 4096B → base64 → 事件 | `commands/terminal.rs`（715 行） |
| 事件 `terminal:output` / `terminal:exit` 负载带 `sessionId`（camelCase） | terminal.rs:53-63 |
| 双出口 sink：Tauri emit / Web EventBroadcaster（WS），按会话创建时选择 | terminal.rs:73-111 |
| 插件面板**今天就能**监听 `terminal:output`（`__POLARIS_HOST_LISTEN__` 对非 chat-event 无过滤） | `src/main.tsx:116-130` |
| `router_dispatch` 在插件 invoke 白名单 → 新增 cap 即可达 | `src/main.tsx:35-54` |
| cap 权限默认全放行（内置 deny 仅 `cap.data_root*` / `cap.plugin*`） | `router/policy_permission.rs` |
| 能力注册点：`bus.register_handle(Box::new(XxxCapability))`，依赖以 Arc 注入构造器 | `state.rs:499-530` |
| 面板渲染：builtin 查表优先，重复 panelType 内建赢；`getShadowedSlot`（slotMode:'shadow'）已定义但渲染端未消费 | `LeftPanel.tsx:315-344`、`plugin-system/registry.ts:351` |
| 脚本发现扫 package.json scripts（按 lockfile 定 runner） | `commands/terminal_script.rs` |
| 自定义脚本存 config.json `terminal_scripts`（按工作区 key） | `models/config.rs:1576` |
| Web 端完整支持终端（EventBroadcaster WS 广播）；`open_in_external` 仅桌面 | `web/api/ipc.rs:407-417` |
| 插件面板全屏走 manifest `panel.supportsFullscreen` | docker-desk 先例 |
| 会话不持久化（纯内存，重启即失）；前端挂载时自动建会话兜底 | terminal.rs:117 |

## 三、总体方案（四阶段）

```
阶段A 共存          阶段B 接管                阶段C 优化            阶段D 拆除
┌─────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌──────────────────┐
│ 宿主:        │   │ 宿主:             │   │ 插件:         │   │ 主仓:             │
│ cap.terminal │──▶│ LeftPanel 消费    │──▶│ webgl 渲染    │──▶│ 删 builtin 贡献   │
│ 插件仓:      │   │ shadow slot:      │   │ 搜索/分屏/    │   │ 删 Terminal 组件/ │
│ terminal-desk│   │ 插件面板替代内置   │   │ 重命名 tab    │   │ store/旧命令      │
│ 独立视图     │   │ (卸载即回退)      │   │               │   │ 删 @xterm 依赖    │
└─────────────┘   └──────────────────┘   └──────────────┘   └──────────────────┘
```

所有者：主仓（cap.terminal + shadow 接线 + 拆除）= Polaris 主仓会话；插件 = `D:\space\base\Polaris-plugin\plugins\terminal-desk`。

## 四、cap.terminal 契约（阶段A，主仓）

新增 `src-tauri/src/services/router/terminal_capability.rs`，注册于 `state.rs` 能力装配处。**旧 `terminal_*` 命令过渡期保持不动**（双轨），拆除阶段再砍。

动作协议（payload 统一 `{ "action": ... }`，与 cap.bash 同风格）：

| action | 入参 | 出参 | 对应旧命令 |
|---|---|---|---|
| `create` | `name?` `cwd?` `cols?` `rows?` `initialCommand?` `env?` `purpose?` `scriptId?` | `{ sessionId }` | terminal_create |
| `write` | `sessionId` `data`(base64) | `{}` | terminal_write |
| `resize` | `sessionId` `cols` `rows` | `{}` | terminal_resize |
| `close` | `sessionId` | `{}` | terminal_close |
| `list` | — | `{ sessions: [...] }`（过滤已退出） | terminal_list |
| `get` | `sessionId` | 会话详情或 null | terminal_get |
| `discover_scripts` | `workspacePath?` | `{ scripts: [...] }` | terminal_discover_scripts |
| `open_in_external` | `command` `cwd?` | `{}`（仅桌面，web-only 构建返回错误） | terminal_open_in_external |

事件流（复用既有事件名，负载不变）：
- `terminal:output` `{ sessionId, data(base64) }`
- `terminal:exit` `{ sessionId, exitCode }`

**sink 装配**：`TerminalEventSink` 增加 `Dual { tauri, web }` 变体（桌面构建双通道同发，浏览器客户端走 WS、Tauri webview 走 emit，互不干扰；同 lib.rs plugin.service.status 双通道先例）；新增 `TERMINAL_EVENT_SINK: OnceLock` + `set_global_terminal_sink()/global_terminal_sink()`（terminal.rs，显式 std Result 防触摸类型别名），桌面 lib.rs setup 注入 Dual、`run_web_server` 注入 Web。cap.terminal 的 create 用全局 sink（未注入时报错）。旧命令的 per-session sink 语义不变（零回归）。

**权限（实施定案，推翻上文初稿）**：**不设** `cap.terminal remote deny`。理由：既有 legacy 终端命令（`/api/terminal-create` 等）本就允许已鉴权 Remote 完整驱动 PTY，web 独立构建（浏览器前端 `Source::Remote` 是安全铁律）的插件终端面板依赖 cap.terminal 可达——加 deny 是功能回归而非安全增益（暴露面与现状完全一致）。鉴权依赖传输层 token（同 cap.config 远程读写先例）。

**装配形态（实施定案）**：`TerminalCapability::with_state(Arc<AppState>)`（同 cap.ai.chat/cap.history 模式），注册于桌面 lib.rs setup（chat_state = clone_for_web）与 web `run_web_server`（真身 state）；`AppState.terminal_manager` 类型不动（无需 Arc 化）。桌面 clone_for_web 的 fresh manager 使插件会话与内置会话分池——双轨共存期互不干扰，拆除阶段（阶段D）若需合池再评估。

## 五、插件设计（阶段A/B，Polaris-plugin 仓）

```
plugins/terminal-desk/
├── plugin.json          # id: terminal-desk, name: 终端
├── package.json         # esbuild bundle → dist/panel.js --external:react
├── src/
│   ├── index.tsx        # 入口（占位符化模板纪律）
│   ├── Panel.tsx        # 主面板：tab 栏 + 会话区 + 脚本抽屉
│   ├── SessionView.tsx  # 单会话 xterm 封装（fit/webgl/search addon、主题、输入输出）
│   ├── ScriptDrawer.tsx # 脚本面板（发现 + 自定义命令）
│   ├── host.ts          # 桥封装：capDispatch / listen / theme
│   ├── model.ts         # 状态：会话表、脚本表、dangerous confirm
│   └── xtermTheme.ts    # CSS 变量 → xterm theme（移植 getXtermTheme）
├── mcp/server.js        # （可选阶段）stdio MCP：列会话/跑脚本，经 {{polarisPort}}/{{polarisToken}} 调 /api/router-dispatch cap.terminal
├── test/                # node 原生测试（model 纯逻辑 + mcp 协议）
└── dist/panel.js
```

manifest 要点：
- `contributes.views[]`：`{ id: 'terminal-desk.panel', area: 'activityBar', panelType: 'terminal-desk', icon: 'Terminal', order: 71 }`（阶段A独立视图；阶段D 去掉 shadow 改回独立，或保持）
- `contributes.panel`：`{ entry: './dist/panel.js', supportsFullscreen: true }`
- **无 `services`**（零端口）；`mcpServers` stdio 可选
- `permissions`: `{ aiToolAccess: true }`（MCP 用）

面板功能（v1 对齐内置，v2 超越）：
- 多 tab 会话：新建/切换/关闭/退出态标记（exitCode 徽标）/重开；挂载自动建首个会话
- 输入输出：`onData` → base64 → cap.terminal write；`terminal:output` 按 sessionId 过滤 → xterm.write
- resize：ResizeObserver + fit addon → proposeDimensions → cap.terminal resize（rAF+去抖，移植内置节奏）
- 主题：CSS 变量取色 + `__POLARIS_THEME_API__.subscribe` 热更新
- 脚本抽屉：discover_scripts 发现 + 自定义命令（存 `plugin_get_config/plugin_set_config`，**不碰宿主 config.json terminal_scripts**）、危险命令确认（移植 isDangerousCommand）、运行=写入会话、停止=写 Ctrl+C
- 运行命令浮层：面板内 Ctrl+Shift+R（window keydown + 面板可见性判定 offsetParent）

## 六、接管（阶段B，主仓小改）

LeftPanel 渲染裁决补一行 shadow 消费（完成 P3-T1 设计闭环）：
- 激活面板类型为 `terminal`（builtin 视图 id `terminal.panel` 的 panelType）且 `pluginRegistry.getShadowedSlot('terminal.panel')` 命中已启用插件 → 该席位渲染 `<PluginPanelHost panelType={插件panelType}>`，隐藏 builtin terminalContent
- tab strip 不变（仍显示原 Terminal tab，图标/顺序/文案零扰动）；禁用/卸载插件 → 内置面板原样回来（天然回滚）

已知边界（记录，不阻塞）：
- 工作区切换/app_start 自动跑脚本：内置走 eventBus（窗口内），插件听不到。阶段B 先降级为「面板激活时自动跑 terminal_open 触发器」；阶段D 若要保留，宿主补一条 workspace-changed 传输事件再评估
- Ctrl+Shift+R 全局热键在 shadow 期由插件面板自管（内置监听者仍在但无害；拆除阶段删）

## 七、拆除（阶段D，主仓）

清单以勘察报告为准（本文档 §二来源，拆除时重新 grep 复核行号）：
- 删 `src/components/Terminal/`、`src/stores/terminalStore.ts`、`src/types/terminal*.ts`、`@xterm/*` 3 依赖
- 删 `builtinPlugins.ts` terminal.panel 贡献、App.tsx terminalContent 接线、viewStore terminal 相关字段、useAppInit/useAppEvents/useWindowManager 终端块、ToolSwitcher pin、eventBus 两事件、locales labels.terminalPanel
- 后端：`terminal_*` 命令与 `commands/terminal.rs` 命令层——PTY 核保留（cap.terminal 是唯一入口），命令层按「每迁一个砍一个旧命令」砍；`web/api/ipc.rs` 终端 dispatch 与 match arm 删除（**保留 optional_string/u16/string_map helpers，被共用**）；`terminal_script.rs` 的发现逻辑并入或被 cap.terminal 调用
- `models/config.rs terminal_scripts` 字段保留 + serde(default)（存量 config.json 兼容，读侧不再有消费者）
- 插件 manifest 阶段D 将 shadow slot 移除（builtin 已不存在，恢复独立视图渲染）

## 八、面板优化（阶段C，参考来源）

参考：VS Code 集成终端（tabs/分屏/右键/重命名）、xterm.js 官方 addon 体系、社区 React xterm 实践。
- `@xterm/addon-webgl`：GPU 渲染（fallback canvas），大输出不掉帧
- `@xterm/addon-search`：Ctrl+F 搜索条（高亮/上下导航/大小写/正则）
- 分屏：同组双会话左右分栏（简单 CSS grid，每栏独立 SessionView）
- tab 重命名 + 图标态（运行中/已退出）；tab 右键菜单（重命名/复制会话/关闭）
- 滚回行数提升至 10000+（scrollback），快速滚动节流
- 全屏（manifest supportsFullscreen 既有机制）

## 九、验收

阶段A：
- [ ] `cargo check` 过；web-only 门禁 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 过
- [ ] 新增 capability 单测（动作分发/未知动作/未注册）通过
- [ ] 插件安装后在活动栏出现「终端」独立视图；新建会话出 shell 提示符；输入 `dir` 有回显；resize 跟手；关闭 tab 会话退出；主题切换配色跟随
- [ ] Web 浏览器端（tauri:dev:web 9827）同样可用
- [ ] 期间内置终端功能回归正常（双轨共存互不干扰）

阶段B：
- [ ] 启用插件 shadow 后，Terminal 席位渲染插件面板；禁用插件即回内置
- [ ] 卸载插件无残留（会话由宿主持有，UI 关闭即可）

阶段C：webgl 生效（devtools renderer 判定）、搜索可用、分屏可用

阶段D：
- [ ] 主仓 grep `terminalStore|@/components/Terminal|terminal_create` 仅剩 cap.terminal 链路
- [ ] `pnpm typecheck` + `pnpm test:run` + `cargo check` 全过；启动包体积 xterm 相关 chunk 消失

## 十、风险与边界

- PTY 留宿主 = 终端「实现」拆两半：进程在宿主、UI 在插件。这是有意的：宿主 PTY 已双端验证（桌面+Web），插件进程内 PTY（node-pty）要带平台二进制且 Web 端不可用。拆除阶段「内置」仅指 UI 与命令层，PTY 核心是宿主能力（同 cap.bash 定位）。
- 会话归属：cap.terminal 创建的会话与内置命令创建的会话同池（TerminalManager 单例），互见事件（按 sessionId 过滤，无害）。
- 协议无运行时 schema 校验（已知缺口）：cap.terminal 入参保守校验（cols/rows u16 范围、base64 解码失败显式报错）。
