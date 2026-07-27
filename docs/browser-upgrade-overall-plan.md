# Polaris 内置浏览器升级改造汇总执行方案

> 文件: `docs/browser-upgrade-overall-plan.md`
> 版本: v1 · 2026-07-27
> 架构师: 小白
> 状态: 待评审 (Draft)

---

## 目录

1. [项目概述](#1-项目概述)
2. [根因总结](#2-根因总结)
3. [四大 Phase 执行计划](#3-四大-phase-执行计划)
   - [Phase 0: 信息提取增强](#phase-0-信息提取增强)
   - [Phase 1: UI 体验重构](#phase-1-ui-体验重构)
   - [Phase 2: 自动化交互增强](#phase-2-自动化交互增强)
   - [Phase 3: 架构完善 (ADR 0004 落地)](#phase-3-架构完善-adr-0004-落地)
4. [跨 Phase 依赖关系](#4-跨-phase-依赖关系)
5. [风险与缓解](#5-风险与缓解)
6. [实施建议](#6-实施建议)
7. [附录: 文件索引与行号引用](#7-附录-文件索引与行号引用)

---

## 1. 项目概述

### 1.1 问题背景

Polaris 内置浏览器 (built-in browser) 经过 ADR 0001 奠定基础、当前实现已支持 WebView 获取、导航、页面上下文提取、DOM 元素检查、点击/填充自动化、诊断、浏览器区域截图、操作日志和 MCP 图片内容,但在使用体验与 AI 自动化能力层面存在三大突出问题:

| 问题域 | 现象 | 影响 |
|---|---|---|
| **① 状态栏/工具栏体验感零分** | 11 个工具栏按钮无视觉分层,全部同一样式;后退/前进按钮永远启用;地址栏无 favicon/安全指示/加载进度;底部状态栏冗余文案;错误反馈不统一 | 用户无法建立操作优先级,认知成本高,信任感低 |
| **② 信息识别不全** | 页面上下文提取维度缺失:无表格、代码块、图片、JSON-LD 结构化数据;正文截断无分段;链接无分类;标题只到 h3;meta 缺 canonical/og:image | AI 对页面的理解粒度粗,无法支撑深度分析、代码提取、SEO 判断等任务 |
| **③ 可操作内容识别不完整** | 交互元素缺坐标 (`rect`)、选中态 (`checked`/`selected`)、选择项 (`options`)、稳定定位串 (`selector`);click 脚本缺 mousemove/mouseenter;表单约束 (required/pattern/min/max) 丢失 | AI 点击易误命中同名元素;无法操作下拉/复选/单选;无法感知折叠/展开/表单校验状态 |

此外,ADR 0004 (Proposed) 评审发现更深层的架构问题:状态分散、tab 持久化语义不明确、浏览器动作派发在三条路径重复、DOM 自动化仅依赖注入 JavaScript、诊断捕获与截图可靠性不足。

### 1.2 改造目标

1. **体验对标**:工具栏、地址栏、状态栏达到 Chrome/Edge 体验基线(视觉分层、安全指示、进度反馈、可发现性)。
2. **信息维度全覆盖**:页面上下文提取覆盖表格/代码/图片/结构化数据/链接分类/扩展 meta;交互元素输出坐标/状态/选项/约束/稳定定位串。
3. **自动化可靠性**:补充原生回退原语 (wait/scroll/press_key/type_text/screenshot)、hover 驱动事件、诊断持久捕获,使浏览器成为稳定可用的 AI 自动化表面。
4. **架构硬化**:状态机收敛、tab 持久化明确、共享动作派发器、陈旧 session 清理、`file://` 策略、安全加固,消除行为漂移风险。

### 1.3 影响范围 (涉及模块)

| 模块 | 文件 | 改动性质 |
|---|---|---|
| 后端浏览器命令 | `src-tauri/src/commands/browser.rs` (~2500 行) | 结构体扩展、脚本宏增强、新命令、状态清理 |
| 前端浏览器面板 | `src/components/Browser/BrowserPanel.tsx` | 状态机、UI 重构、组件拆分 |
| 前端浏览器服务 | `src/services/tauri/browserService.ts` | 类型同步、新函数、历史状态查询 |
| 前端 Hook | `src/hooks/useFavicon.ts` (新增) | favicon 获取与缓存 |
| SimpleAI 浏览器工具 | `simple_ai/tools/browser.rs` | 动作派发器接入 |
| MCP 浏览器桥 | `polaris-browser-mcp` / ask-listener | 动作派发器接入 |
| Tab 状态管理 | `src/stores/tabStore.ts` | persist `partialize` 策略 |
| 国际化 | `src/locales/{zh-CN,en-US}/common.json` | 新增 browser 块 key |
| 后端测试 | `browser.rs` L2206-2353 `browser_script_tests` | 更新 + 新增用例 |
| 前端渲染 | 诊断面板、overlay badge 消费点 | 读取新增字段 |

### 1.4 改造边界

- **不替换**当前 WebView 内置浏览器为 headless/Playwright/CDP (ADR 0004 已否决,因 Polaris 需要可视、用户可管理的浏览器 tab)。
- **不暴露**任意 JavaScript 执行通道到 MCP (ADR 0004 已否决,避免安全面扩大)。
- 所有新增 Rust 字段均 `#[serde(default)]`/`Option`/`Vec`(空 default),保证**后向兼容** (旧前端解析新数据不崩溃) 与**前向兼容** (新前端读旧数据有 fallback)。

---

## 2. 根因总结

以下根因从三份规划文档与 ADR 0004 中提炼,每条附引用来源。

| 编号 | 根因 | 影响 | 引用来源 |
|---|---|---|---|
| RC1 | **`styleOf` 无缓存**: `getComputedStyle` 在 `isVisible`/`looksInteractive`/`scoreOf`/`collectRoots` 对同一元素各调一次,大 DOM 上调用次数呈 O(3n) | 诊断 eval 3.5s 超时,大 SPA 返回空 | 信息提取 §1.4 / §3.2.1 (browser.rs L1505/L1691/L1706/L1718/L1825) |
| RC2 | **交互元素无坐标输出**: collector 内部有 `rectOf` 并用于去重排序,但 `toPolarisInteractiveElement` 不输出 `rect` | AI 点击只能靠 text 模糊匹配,易误命中同名元素 | 信息提取 §1.2 (browser.rs L1668-1678/L1853-1862) |
| RC3 | **交互元素状态缺失**: `checked`/`selected`/`options`/`expanded`/`pressed`/`tooltip`/表单约束未提取 | AI 无法操作下拉/复选/单选/感知折叠态 | 信息提取 §1.2 / §2.1 |
| RC4 | **页面上下文维度不全**: 无表格/代码块/图片/JSON-LD/列表/表单;正文截断无分段;链接无分类;标题只到 h3 | AI 对页面结构理解粗,无法提取代码、分析表格、识别结构化数据 | 信息提取 §1.1 |
| RC5 | **click 脚本缺 hover 事件**: 仅派发 pointerdown/mousedown/click,无 mousemove/mouseover/mouseenter | hover 驱动的菜单/工具提示无法被 AI 触发 | 信息提取 §1.4 / §3.4 (browser.rs L1973-1993) |
| RC6 | **console 捕获导航后丢失**: `CONSOLE_CAPTURE_SCRIPT` 仅在 diagnostics 调用时 eval 注入,WebView 重载后 `window.__POLARIS_BROWSER_CONSOLE__` 重置 | 诊断始终只捕获注入后的消息,导航前错误丢失 | 信息提取 §1.4 / §3.3 (browser.rs L2150) |
| RC7 | **工具栏无视觉分层**: 11 个按钮全用 `toolbarButtonClass`,无分隔线、无主/次/图标分级 | 用户无法建立操作优先级,认知成本 >2 级 | UI 重构 §一 P1 / §四 (BrowserPanel.tsx L647-648/L688-828) |
| RC8 | **后退/前进按钮误判**: `disabled={status !== 'ready'}`,不反映真实历史可点击性 | 用户误触导航,体验差 | UI 重构 §一 P2 (BrowserPanel.tsx L693/L702) |
| RC9 | **地址栏无身份与状态信息**: 静态 `Globe2` 图标替代 favicon,无 HTTPS 指示,无加载进度 | 用户无视觉信任感,对访问站点无感知 | UI 重构 §一 P3/P4 (BrowserPanel.tsx L719-740/L857-861) |
| RC10 | **状态分散在三处 flag**: `status`/`loading`/`error` 独立管理,`finally` 块中时序竞态 | 状态不一致,UI 复合条件难以维护 | UI 重构 §五 (BrowserPanel.tsx L237-239) |
| RC11 | **错误反馈不统一**: 部分操作 `setError`,部分 `setError`+`toast.error` 双重,部分只 toast | 用户看到双重报错或无提示 | UI 重构 §一 P6 (BrowserPanel.tsx L692 vs L643/L798) |
| RC12 | **AI 操作面板折叠按钮误判**: `disabled={!latestOperation}`,无操作时灰色不可点 | 用户无法主动打开 AI 面板 | UI 重构 §一 P7 (BrowserPanel.tsx L1035-1053) |
| RC13 | **浏览器状态四分五裂**: 前端 tab / 后端 session / WebView 生命周期 / 边界 / agent binding 各自管理,存在 ghost tab | 状态陈旧,tab 关闭后残留 | ADR 0004 Context #1 / P0 #3 |
| RC14 | **tabStore persist 语义不明确**: Zustand persist 但注释说 tab 不持久化,缺 `partialize`,重启后 ghost tab | 重启后出现已失效的浏览器 tab | ADR 0004 Context #2 / P0 #1 |
| RC15 | **浏览器动作派发三路径重复**: SimpleAI native tool / MCP bridge / ask-listener 各写一份 | 新增动作需改三处,行为易漂移 | ADR 0004 Context #3 / P0 #2 |
| RC16 | **DOM 自动化仅依赖注入 JS**: 对复杂交互页面 (富文本/原生控件) 不足,无可回退原语 | 部分页面 AI 无法操作 | ADR 0004 Context #4 / P1 #1 |
| RC17 | **截图可靠性不足**: Windows-only,假设 monitor 0,无 DPI/窗口偏移/多屏处理 | 截图坐标偏差、非 Windows 不可用 | ADR 0004 Context #5 / P2 #2 |

---

## 3. 四大 Phase 执行计划

> **Phase 命名说明**: 为与用户指定的"四大 Phase"对齐,本方案将信息提取增强设为 Phase 0,UI 重构设为 Phase 1,自动化交互设为 Phase 2,架构完善设为 Phase 3。各 Phase 内部的任务编号为 T{Phase}.{N},来源文档行号均标注。

---

### Phase 0: 信息提取增强

**来源文档**: `docs/browser-info-extraction-plan.md` (989 行)
**优先级**: P0(必做) + P1(应做) + P2(可做)
**人日预估**: ~2.5 人日 (P0 批次 ~1.5 人日 + P1 批次 ~1 人日 + P2 按需)
**依赖**: 无外部 Phase 依赖;Phase 0 内部的 P1 任务依赖 P0 字段已加

#### 目标

扩展 `BrowserPageContext` 与 `BrowserInteractiveElement` 的数据维度,填补表格/代码/图片/结构化数据/交互状态/坐标/稳定定位串等缺失,同时将诊断 eval 从 3.5s 超时降至 1-2s,使 AI 获得高粒度、可定位的页面上下文。

#### 具体任务清单

**P0 任务 (必做,批次 1, ~1.5 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T0.1 | `styleOf` WeakMap 缓存 | 在 collector 宏中用 `WeakMap` 缓存 `getComputedStyle` 结果,根除 `isVisible`+`looksInteractive`+`scoreOf`+`collectRoots` 多次调用 (O(3n)→O(n)) | browser.rs L1505 | 低 | 脚本含 `__styleCache`,3000 元素场景 getComputedStyle 调用从 ~9000 降至 ~3000 |
| T0.2 | `BrowserInteractiveElement` 增字段 | 新增 `rect`/`checked`/`selected`/`options`/`selector` (全部 `#[serde(default)]`) | browser.rs L98-109 + browserService.ts | 中 | `cargo check --lib` 通过,TS `tsc --noEmit` 通过 |
| T0.3 | `toPolarisInteractiveElement` 输出新字段 | 输出 rect (从 `entry.rect` 取);提取 checked/selected/options;`buildStableSelector` 辅助;`numberOrNull` 辅助 | browser.rs L1853-1862 / L1532 后 | 中 | 脚本含 `rect:`/`checked:`/`selected:`/`options:`/`selector:` |
| T0.4 | Click 补 mousemove/mouseenter | 在 dispatchPointer 前插入 `dispatchMouse('mousemove')`/`dispatchMouseEnter('mouseover')`/`dispatchMouseEnter('mouseenter')` | browser.rs L1973-1993 | 低 | 脚本含 `mousemove`/`mouseover`/`mouseenter` |
| T0.5 | `PAGE_CONTEXT_SCRIPT` 扩展 | 新增 tables (15×200)/codeBlocks (30×4000)/images (40)/structuredData (JSON-LD 20)/links.rel/canonical/ogTitle/ogImage | browser.rs L1405-1442 | 中 | 脚本含 `querySelectorAll('table')`/`pre`/`img[src]`/`application/ld+json` |
| T0.6 | 诊断 eval 超时 3500→5000 + 双遍短路 | 超时升 5000ms (L881/L970);第二遍 querySelectorAll 用 `seenInSelector` WeakSet 短路 | browser.rs L881/L970/L1819-1829 | 低 | 大 DOM 诊断时间 3.5s→1-2s |

**P1 任务 (应做,批次 2, ~1 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T0.7 | 追加交互状态字段 | `tooltip`/`expanded`/`pressed`/`readOnly`/`required`/`min`/`max`/`step` | browser.rs L98-109 + TS | 中 | 对应字段在 `toPolarisInteractiveElement` 中输出 |
| T0.8 | `BrowserPageContext` 扩展 | `tables`/`codeBlocks`/`images`/`structuredData`/`lists`/`forms`/`canonical`/`ogTitle`/`ogImage`;标题 h1-h6;links.rel | browser.rs L142-152 + TS | 中 | TS 接口含对应可选字段 |
| T0.9 | CONSOLE_CAPTURE_SCRIPT 导航后持久注入 | 新增 `inject_console_capture` 函数;在 `on_navigation` 回调 + navigate/reload 完成后注入;脚本包 IIFE 自包 | browser.rs L1167/L1881-1918/L2148-2157 | 中 | 脚本 trim 后以 `(() =>` 开头;导航后 console 仍在捕获 |
| T0.10 | 上限调整 | `SCAN_LIMIT` 5000→8000;Shadow DOM 深度 3→5;maxElements 交互 220→300/诊断 180→220/click/fill 240→300 | browser.rs L1497/L1750/L1921/L1927 | 低 | 脚本含 `depth > 5`/`maxElements: 300` |
| T0.11 | `BrowserVisualElement` 增强 | 新增 `checked`/`selected`/`selector` | browser.rs L182-189 + TS | 低 | TS 接口同步 |
| T0.12 | 测试用例更新与新增 | 更新 `collector_covers_modern_interactive_patterns` 上限断言;新增 6 个 P0 测试 | browser.rs L2206-2353 | 低 | `cargo check --lib` 全绿 |

**P2 任务 (可做,按需)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T0.13 | 病态体积保护 `clamp_context_arrays` | 对 tables/codeBlocks/images/structuredData/lists/forms 总量截断 (每项 ≤30) | browser.rs L882 | 低 | 病态页面序列化 <200KB |
| T0.14 | microdata 解析 | 解析 `<script type="application/ld+json">` 外还有 `itemprop` | PAGE_CONTEXT_SCRIPT | 中 | — |
| T0.15 | selector 输出 xpath 备选 | 除 CSS selector 外提供 xpath | collector | 低 | — |

#### 改动文件清单

| 文件 | 改动内容 | 预估行数变化 |
|---|---|---|
| `src-tauri/src/commands/browser.rs` | 结构体扩展、脚本宏增强、超时调整、测试 | +~400 / -~50 |
| `src/services/tauri/browserService.ts` | `BrowserInteractiveElement`/`BrowserPageContext`/`BrowserVisualElement`/`BrowserSelectOption` 类型同步 | +~80 |

#### 人日预估

- P0 批次:1.5 人日
- P1 批次:1.0 人日
- P2 批次:0.5 人日 (按需)
- **小计: 2.5 人日**

#### 依赖关系

- 无外部 Phase 依赖,可独立启动。
- P1 任务 (T0.7-T0.12) 依赖 P0 字段定义 (T0.2) 与脚本基础 (T0.5)。
- T0.9 (console 持久化) 独立,可与 P0 并行。

#### 验收标准

- `cargo check --lib` 零错误
- `tsc --noEmit` 零错误
- `cargo test` (browser_script_tests) 全部通过,新增 6 个测试通过
- 性能:3000 节点 SPA 诊断时间 ≤2s
- 序列化:典型页面 <80KB,病态页面 <200KB

---

### Phase 1: UI 体验重构

**来源文档**: `docs/browser-ui-refactor-plan.md` (700 行)
**优先级**: P0(状态机+错误) → P1(视觉分层) → P2(地址栏) → P3(可发现性)
**人日预估**: ~4.2 人日 (含 i18n 0.2)
**依赖**: 需要后端 `browser_get_history_state` (T1.4);与 Phase 0 无强依赖,可并行

#### 目标

将工具栏从 11 个同质按钮重构为"导航组 + 增强地址栏 + AI 主按钮 + 溢出菜单"四区布局;建立三级视觉分级;地址栏集成 favicon/安全指示/加载进度;状态收敛为单一状态机;错误反馈统一;AI 面板永远可触发;小屏语义不丢失。

#### 具体任务清单

**P0 — 状态机 + 错误统一 (~0.5 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T1.1 | `useBrowserState` 状态机 | 用 `useReducer` 收敛 `status`/`loading`/`error` 为单一 `BrowserState` (idle/loading/ready/error/native-unavailable);新增 `backEnabled`/`forwardEnabled` | BrowserPanel.tsx L237-239 | 中 | 状态转换正确;`finally` 块无时序竞态 |
| T1.2 | 统一错误处理 | 所有导航/工具类操作的 `.catch` 改为 `toast.error`,移除 `setError`;error banner 仅用于启动失败 | BrowserPanel.tsx L692/L701/L710/L806/L1091 vs L643/L669/L798 | 低 | 无双重报错,无遗漏 |
| T1.3 | 历史状态查询 (前端) | 新增 `browserGetHistoryState` 函数 | browserService.ts L223 后 | 低 | 成功时同步 `SET_HISTORY_STATE`,失败时静默退化 |

**P1 — 视觉分层 + 分组 (~1 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T1.4 | 后端 `browser_get_history_state` | 新增 Tauri command,调用 `can_go_back()`/`can_go_forward()`,返回 `BrowserHistoryState` | Rust browser command 模块 | 中 | 返回正确的 canGoBack/canGoForward |
| T1.5 | 三级按钮类名常量 | 新增 `browserBtnPrimary`/`browserBtnSecondary`/`browserBtnIcon`;替换 `toolbarButtonClass`/`taskButtonClass` | BrowserPanel.tsx L647-650 | 低 | 实心主按钮与描边次按钮视觉差异明显 |
| T1.6 | 工具栏重构 | 导航组加 `border-r` 分隔线;讲解/修改改 `browserBtnPrimary`;移除地址栏内 Search 按钮 | BrowserPanel.tsx L688-828 | 中 | 四区布局生效 |
| T1.7 | `BrowserOverflowMenu` 组件 | Dropdown 收纳:上下文预览/诊断/AI操作/DevTools/复制/外链/清理数据,每项 icon+label | 新增组件 | 中 | 菜单项完整,操作后自动关闭 |

**P2 — 地址栏增强 (~2 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T1.8 | `AddressBar` 子组件 | 集成 SecurityIndicator、favicon、URL 输入框、2px 进度条 (loading 驱动) | BrowserPanel.tsx L719-740 | 中 | 地址栏底部进度条随 loading 填充,完成时淡出 |
| T1.9 | `useFavicon` hook | 5s 超时 fetch `favicon.ico`,失败回退 Google favicon API,再失败 Globe2;host 级 `Map` 缓存 | 新增 src/hooks/useFavicon.ts | 中 | 缓存命中不再 fetch,超时通过 AbortController 取消 |
| T1.10 | `SecurityIndicator` 组件 | `https`→绿锁/`http`→黄警告/`localhost`→灰终端;`isLocalDevUrl` 复用 | 新增组件 | 低 | 三类协议图标正确 |

**P3 — 可发现性 + 小屏 (~0.5 人日)**

| 编号 | 任务 | 详细说明 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T1.11 | AI 面板折叠按钮修复 | 移除 `disabled={!latestOperation}`;无操作时文案"AI 操作日志 — 点击打开",图标用 tertiary 色 | BrowserPanel.tsx L1035-1053 | 低 | 折叠按钮永远可点击 |
| T1.12 | AI 面板内冗余清理 | 移除重复 `isLocalDev`/`highlightCount` badge;空操作日志显示友好空状态 | BrowserPanel.tsx L885-1031 | 低 | 重复元素只出现在底部状态栏一处 |
| T1.13 | 底部状态栏瘦身 | 移除静态文案/重复标签;保留色点+host+标题+清理按钮;loading 时显示"加载中…"+spinner | BrowserPanel.tsx L1055-1101 | 低 | 状态栏信息密度合理 |
| T1.14 | 小屏适配 | <640px 导航组保留,AI 任务进溢出菜单;640-1279px 单字"讲"/"改";≥1280px 完整;溢出菜单内始终 icon+label | BrowserPanel.tsx + 新组件 | 中 | <640px 全部功能可触达 |

**i18n (~0.2 人日)**

| 编号 | 任务 | 详细说明 | 文件 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|
| T1.15 | 补齐 browser key | 新增 12 个 browser 块 key (zh-CN + en-US);可删除冗余 `browser.aiReady` 等 | locales zh-CN/en-US common.json | 低 | 新增 key 全部覆盖,无遗漏 |

#### 改动文件清单

| 文件 | 改动内容 | 预估行数变化 |
|---|---|---|
| `src/components/Browser/BrowserPanel.tsx` | 状态机、UI 重构、组件拆分、小屏适配 | +~400 / -~200 |
| `src/services/tauri/browserService.ts` | `browserGetHistoryState` 函数 + 类型 | +~25 |
| `src/hooks/useFavicon.ts` (新增) | favicon 获取与 host 级缓存 | +~50 |
| `src-tauri/src/commands/browser.rs` | `browser_get_history_state` command + `BrowserHistoryState` 结构体 | +~30 |
| `src/locales/{zh-CN,en-US}/common.json` | browser 块 key 新增 | +~24/语种 |

#### 人日预估

- P0(状态机):0.5
- P1(视觉分层):1.0
- P2(地址栏):2.0
- P3(可发现性):0.5
- i18n:0.2
- **小计: 4.2 人日**

#### 依赖关系

- T1.3/T1.4 (历史状态) 需前后端同步,后端 T1.4 可提前做。
- T1.8-T1.10 (地址栏) 独立,可与 P1 并行。
- T1.9 (`useFavicon`) 需 `navigator.fetch` 在 Tauri 环境可用 (已具备)。
- 与 Phase 0/2/3 无强依赖。

#### 验收标准

- 状态转换符合状态机图 (idle→loading→ready/error/native-unavailable)
- 后退/前进反映真实历史状态
- 三级按钮视觉差异肉眼可辨
- favicon 三类协议图标正确
- <640px 全部功能可触达
- 所有新增 i18n key 在 zh-CN/en-US 双语言覆盖

---

### Phase 2: 自动化交互增强

**来源文档**: `docs/browser-automation-plan.md` (**待该文件写入完成后读取补充**);本章节当前基于 ADR 0004 (Proposed) 中明确的 P1/P2 决策要点与 Phase 0 已识别的交互缺陷综合撰写。
**优先级**: P0(原生回退原语) + P1(等待条件 + locator 增强) + P2(截图/Diagnostics 可靠性)
**人日预估**: ~4-6 人日 (含原生原语实现、等待条件、截图 robust 化;具体以自动化方案文档最终稿为准)
**依赖**: 与 Phase 0 共享 collector 宏;截图改动独立

#### 目标

在保持注入 JavaScript DOM 自动化基础上,补充原生回退原语 (`wait`/`scroll`/`press_key`/`type_text`/`screenshot`),增强 locator 元信息 (frame path/rect/role/tag/accessible name),添加可选等待条件,提升诊断捕获与截图可靠性,使内置浏览器成为稳定可用的 AI 自动化表面。

> **注意**: 本节标注"以 ADR 0004 为准"的任务为架构层面已确定的方向;标注"待自动化方案"的任务为具体实现细节,在 `browser-automation-plan.md` 就绪后补充对齐。

#### 具体任务清单

**P0 — 原生回退原语 (~2-3 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T2.1 | `browser_wait` | 新增 Tauri command:等待指定毫秒或条件 (URL 变化/文本出现/元素出现/network/document idle) | ADR 0004 P1 #1, #3 | Rust + browserService.ts | 中 | 等待 timeout 返回超时错误,满足条件返回成功 |
| T2.2 | `browser_scroll` | 新增 Tauri command:原生滚动 (按方向/到元素/到像素) | ADR 0004 P1 #1 | Rust + browserService.ts | 中 | 滚动后 scrollY 变化正确 |
| T2.3 | `browser_press_key` | 新增 Tauri command:原生按键 (单键/组合键,如 Control+A) | ADR 0004 P1 #1 | Rust + browserService.ts | 中 | 组合键组合正确,触发对应行为 |
| T2.4 | `browser_type_text` | 新增 Tauri command:原生文本输入 (逐字符 + 延迟) | ADR 0004 P1 #1 | Rust + browserService.ts | 中 | 文本正确输入到目标元素 |
| T2.5 | `browser_screenshot` (显式) | 新增 Tauri command:显式截图,返回 structured 错误而非泛失败 | ADR 0004 P1 #1, P2 #2 | Rust + browserService.ts | 高 | 结构化错误含原因域 (platform/window/coordinate) |

**P1 — Locator 增强 + 等待条件 (~1-2 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T2.6 | locator 元信息扩展 | 在 inspected elements 输出 frame path、role/tag/kind、accessible name/search text、visible/disabled/fillable state、approximate rect | ADR 0004 P1 #2 | browser.rs collector 宏 | 中 | 诊断输出含上述字段 |
| T2.7 | 等待条件 | URL changed / text appears / element appears / network or document idle (平台允许时) | ADR 0004 P1 #3 | Rust | 中 | 各条件在满足/超时时正确返回 |
| T2.8 | click/fill 偏好 inspected element,原生回退 | 当合成 DOM 事件失败时,尝试原生坐标/输入回退 | ADR 0004 Decision #5 | Rust click/fill 脚本 | 高 | DOM 失败时自动降级到坐标点击 |

**P2 — 诊断与截图可靠性 (~1 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T2.9 | Early console capture | 在 WebView 创建或首次导航时注入 console 捕获 (见 T0.9,与 Phase 0 共享) | ADR 0004 P2 #1 | browser.rs | 低 | 与 T0.9 合并验收 |
| T2.10 | Screenshot robustness | 检测当前 monitor 而非假设 monitor 0;处理 DPI 与窗口内容原点;截图坐标近似时加诊断标记 | ADR 0004 P2 #2 | Rust 截图相关 | 高 | DPI 100%/125%/150% 截图坐标正确;多屏对齐 |
| T2.11 | Collector 成本降低 | 缓存 overlay 结果短时间;per-root 扫描分别 cap;偏好 selector 候选而非宽泛 `querySelectorAll('*')` | ADR 0004 P1 #4 | browser.rs collector | 中 | 大页面上 overlay 启用时不显著卡顿 |

#### 改动文件清单

| 文件 | 改动内容 | 预估行数变化 |
|---|---|---|
| `src-tauri/src/commands/browser.rs` | 新增命令 + collector 增强 + 等待条件 + 截图 robust 化 | +~300 / -~30 |
| `src/services/tauri/browserService.ts` | 新命令前端函数 + 类型 | +~80 |
| `src-tauri/src-commands/*` (截图相关) | DPI/multi-monitor 处理 | +~60 |

#### 人日预估

- P0(原生原语):2-3 人日
- P1(locator+等待):1-2 人日
- P2(诊断+截图):1 人日
- **小计: 4-6 人日** (最终以 `browser-automation-plan.md` 为准)

#### 依赖关系

- T2.1-T2.5 (原生原语) 与 Phase 0 共享 collector 宏,可并行。
- T2.8 (原生回退) 依赖 T2.1-T2.5 原语已就位。
- T2.10 (截图) 与截图相关代码独立,可与 Phase 0 并行。
- T2.6 (locator) 与 Phase 0 的字段增强 (T0.2/T0.3) 重叠,建议合并实施。

#### 验收标准

- 各原生原语命令返回正确结果,超时/错误时返回结构化错误
- 大页面上 overlay 启用时 collector 成本可接受 (不显著卡顿)
- Windows 多 DPI/多屏截图坐标正确
- DOM 事件失败时 click/fill 自动回退到原生坐标

---

### Phase 3: 架构完善 (ADR 0004 落地)

**来源文档**: `docs/adr/0004-built-in-browser-hardening-and-upgrade.md` (Proposed 状态)
**优先级**: P0(正确性与状态硬化) + P1(自动化可靠性) + P2(诊断与产品体验)
**人日预估**: ~4-6 人日
**依赖**: 与 Phase 1 状态机 (T1.1) 共享状态管理理念;Phase 2 原生原语 (T2.1-T2.5) 需在此派发器上暴露;`file://` 策略与 Phase 0/1 的导航改动重叠

#### 目标

使内置浏览器成为稳定的 AI 自动化表面:消除状态漂移,明确 tab 持久化语义,统一动作派发,清理陈旧 session,制定 `file://` 策略,提升诊断与截图可靠性,保证浏览器 MCP 安全默认。

#### 具体任务清单

**P0 — 正确性与状态硬化 (~2-3 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T3.1 | `tabStore` persist 语义修复 | 添加 `partialize` 策略排除 browser tab;或明确恢复策略;加测试验证重启后不出现 ghost tab | ADR 0004 P0 #1 | tabStore.ts | 中 | 重启后无 ghost browser tab 测试通过 |
| T3.2 | `BrowserActionDispatcher` 共享派发器 | 从 `simple_ai/tools/browser.rs` 和 `ask_listener.rs` 提取共享动作名、参数解析、`agentKey` fallback、label 解析、动作执行、事件、结果塑形;MCP server 保留为 thin JSON-RPC-to-frame 适配器 | ADR 0004 P0 #2 | simple_ai + ask_listener + Rust 新模块 | 高 | 三个入口 (SimpleAI/MCP/ask-listener) 行为一致;新增动作只改一处 |
| T3.3 | 陈旧 session 清理 (stale pruning) | 在 `browser_list`/label 解析/close/unregister/WebView 查找失败时,核对 `BROWSER_SESSIONS`/`BROWSER_BOUNDS`/`BROWSER_AGENT_BINDINGS` 与实际 WebView,清理不存在的 | ADR 0004 P0 #3 | browser.rs session 管理 | 中 | 关闭 tab 后 session/bounds/binding 被清理 |
| T3.4 | `file://` 策略 | AI/MCP 发起的导航默认 deny `file://`,除非未来权限流显式允许 | ADR 0004 P0 #4 | browser.rs `normalize_url`/`ensure_ai_navigation_url_allowed` | 低 | AI 发起的 file:// 导航被拒绝,手动导航允许 |

**P1 — 自动化可靠性 (~1 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T3.5 | 原生回退原语暴露 | 确保 `browser_wait`/`browser_scroll`/`browser_press_key`/`browser_type_text`/`browser_screenshot` 在派发器上暴露 (与 T2.1-T2.5 合并) | ADR 0004 P1 #1 | 派发器 | 中 | 派发器支持全部原语 |
| T3.6 | locator 增强 | frame path/role/tag/kind/accessible name/rect 输出 (与 T2.6 合并) | ADR 0004 P1 #2 | collector | 中 | — |
| T3.7 | 等待条件 | URL/text/element/network-document idle (与 T2.7 合并) | ADR 0004 P1 #3 | Rust | 中 | — |
| T3.8 | Collector 成本降低 | overlay 结果缓存/per-root cap/selector 优先 (与 T2.11 合并) | ADR 0004 P1 #4 | collector | 中 | — |

**P2 — 诊断与产品体验 (~1 人日)**

| 编号 | 任务 | 详细说明 | 依据来源 | 文件/行号 | 复杂度 | 验收标准 |
|---|---|---|---|---|---|---|
| T3.9 | Early console capture | (与 T0.9/T2.9 合并) | ADR 0004 P2 #1 | browser.rs | 低 | — |
| T3.10 | Screenshot robustness | monitor 检测/DPI/窗口原点/近似坐标诊断标记 (与 T2.10 合并) | ADR 0004 P2 #2 | Rust 截图 | 高 | — |
| T3.11 | 所有权与审计 | 浏览器 tab 显示 AI 创建的 agent/session 所有权;非激活时仍可见最近 AI 操作 | ADR 0004 P2 #3 | BrowserPanel.tsx + 后端 | 中 | tab 标题含 agent 标识 |
| T3.12 | 浏览器故障排除页 | 覆盖 WebView 创建失败/MCP 桥失败/截图限制/Provider 历史错误 | ADR 0004 P2 #4 | 前端新页 | 中 | 帮助页含所有已知故障场景 |

#### 改动文件清单

| 文件 | 改动内容 | 预估行数变化 |
|---|---|---|
| `src-tauri/src/commands/browser.rs` | 派发器/陈旧清理/`file://` 策略 | +~200 / -~30 |
| `src/stores/tabStore.ts` | persist `partialize` | +~10 |
| `simple_ai/tools/browser.rs` | 接入共享派发器 | +~30 / -~50 |
| `src/.../ask_listener.rs` | 接入共享派发器 | +~30 / -~50 |
| `polaris-browser-mcp` | 保留 thin adapter | +~20 |
| `src/components/Browser/BrowserPanel.tsx` | 所有权显示 | +~30 |

#### 人日预估

- P0(状态硬化):2-3 人日
- P1(自动化可靠性,与 Phase 2 合并):0.5 人日 (增量)
- P2(诊断+产品):1 人日
- **小计: 3.5-4.5 人日**

#### 依赖关系

- T3.2 (派发器) 是 T3.5 的原语暴露前置;需与 Phase 2 协同。
- T3.3 (陈旧清理) 与 Phase 1 状态机 (T1.1) 配合,但可独立。
- T3.4 (`file://`) 与 Phase 0 导航改动 (T0.5 脚本扩展) 无冲突,但 `normalize_url` 改动需与现有 normalize 逻辑一致。
- T3.9/T3.10 与 Phase 0 T0.9、Phase 2 T2.10 重叠,建议**三方合并为单一实施批次**。

#### 验收标准

- 重启后无 ghost browser tab
- 三个派发入口行为一致
- 关闭 tab 后 session/bounds/binding 全部清理
- AI 发起的 `file://` 导航被拒绝
- 浏览器 tab 显示 agent 所有权
- 故障排除页上线

---

## 4. 跨 Phase 依赖关系

### 4.1 依赖关系矩阵

|  | 被 Phase 0 依赖 | 被 Phase 1 依赖 | 被 Phase 2 依赖 | 被 Phase 3 依赖 |
|--|:-:|:-:|:-:|:-:|
| **Phase 0** | — | — | 共享 collector 宏 (T2.6/T2.8) | 共享 collector 宏 (T3.6);`normalize_url` (T3.4) |
| **Phase 1** | — | — | 无 | 状态机理念 (T3.3) |
| **Phase 2** | 共享 collector 宏 | — | — | 派发器暴露 (T3.5);原生原语依赖 |
| **Phase 3** | — | — | 派发器前置 (T3.2) | — |

### 4.2 可并行 vs 必须串行

**可并行 (无强依赖):**

1. **Phase 0 (信息提取) ∥ Phase 1 (UI 重构)**:分别修改 collector 脚本/结构体 vs 前端面板组件,改动域完全不重叠。
2. **Phase 1 内部 P1 ∥ P2**:视觉分层与地址栏增强可同时进行。
3. **Phase 2 T2.10 (截图 robust) ∥ 全部其他 Phase**:截图代码独立。

**必须串行 (强依赖):**

1. **Phase 2 P1 (T2.8 原生回退) → 需 Phase 2 P0 (T2.1-T2.5 原语) 先就位**。
2. **Phase 3 P0 (T3.2 派发器) → Phase 2 原语在派发器上暴露 (T3.5)**:派发器是统一入口,先于或同步于原语暴露。
3. **Phase 3 P0 T3.3 (陈旧清理) → Phase 1 T1.1 (状态机)**:建议状态机先定,清理逻辑再与之对齐 (非硬阻塞,但耦合高)。

**三方案重叠合并 (建议三方协同实施):**

- **Console 持久化**: T0.9 (Phase 0) + T2.9 (Phase 2) + T3.9 (Phase 3) → 合并为单一批次。
- **截图 robust 化**: T2.10 (Phase 2) + T3.10 (Phase 3) → 合并为单一批次。
- **Collector 增强**: T0.2/T0.3/T0.10 (Phase 0) + T2.6/T2.11 (Phase 2) + T3.6/T3.8 (Phase 3) → 合并为单一 collector 重写批次。

### 4.3 依赖图

```
Phase 0 (信息提取)              Phase 1 (UI 重构)
┌──────────────────┐            ┌──────────────────┐
│ P0.1-P0.6 缓存/  │            │ P0.1-P0.3 状态机 │
│ 字段/脚本/超时   │  共享      │  + 错误统一      │
│                  │ collector  │                  │
│ P1.7-P1.12 扩展  │   ──→     │ P1.4-P1.7 分层   │
│                  │ 宏+字段   │  + 地址栏         │
│ P2.13-P2.15 体积 │            │ P2.8-P2.14 地址  │
└───────┬──────────┘            │  + 可发现性      │
        │                       └────────┬─────────┘
        │ 共享 collector                 │
        ▼                                │
Phase 2 (自动化交互)                    │
┌──────────────────┐                    │
│ P0.1-P0.5 原生原 │                    │
│ 语 (wait/scroll/ │                    │
│  press_key/...)  │                    │
│                  │                    │
│ P1.6-P1.8 locator│                    │
│  + 等待 + 回退   │                    │
│  (依赖 P0.1-5)   │◄── 合并 ── Phase 3
│                  │    (派发器)       │
│ P2.9-P2.11 诊断  │    ┌──────────────┘
│  + 截图 + 成本   │    │
└───────┬──────────┘    │
        │               │
        └──── 合并 ────┘  Phase 3 (架构硬化)
                          ┌──────────────────┐
                          │ P0.1-P0.4 状态   │
                          │ 硬化 + 派发器    │
                          │                  │
                          │ P1.5-P1.8 (与 P2 │
                          │  合并暴露原语)    │
                          │                  │
                          │ P2.9-P2.12 产品  │
                          │ 体验 + 所有权    │
                          └──────────────────┘
```

---

## 5. 风险与缓解

### 5.1 技术风险

| 风险 | 等级 | 描述 | 缓解措施 |
|---|---|---|---|
| **诊断/上下文 eval 超时** | 🔴 高 | 大 DOM (>5000 节点) 上 `querySelectorAll('*')` + 多次 `getComputedStyle` 导致 eval 超 3.5s 返回空;Phase 0 扩展后脚本体积增大可能加剧 | T0.1 WeakMap 缓存 + T0.6 双遍短路 + 超时 5000ms;Phase 2 T2.11 selector 候选优先 |
| **collector 脚本体积膨胀** | 🟡 中 | P0 扩展后脚本 ~435→~520 行,新增字段解析增加传输与 JIT 时间 | 性能评估已确认单次 eval ~25KB,JIT <5ms,可忽略;若后续继续膨胀,拆为多脚本 |
| **序列化体积超限** | 🟡 中 | 病态页面 (维基大表+长文档) 序列化可达 ~200KB | T0.13 `clamp_context_arrays` 总量截断;eval callback 走 IPC,<200KB 无压力 |
| **Shadow DOM 深度加深** | 🟢 低 | 深度 3→5,边际成本 <5% 节点数 | 现代组件库常嵌套 4-5 层,收益 > 成本;保留 cap |
| **原生原语跨平台兼容** | 🟡 中 | `press_key`/`scroll`/`type_text` 在不同 OS/WebView 版本行为差异 | 封装为跨平台抽象;Linux/Windows 分别测试;超时保护 |
| **截图 DPI/多屏** | 🟡 中 | Windows DPI scaling (100%/125%/150%) 与多屏导致坐标偏移 | T2.10/T3.10 检测当前 monitor + DPI 换算 + 诊断标记 |
| **状态机竞态** | 🟢 低 | `finally` 块中 `setLoading`/`setStatus`/`setError` 时序 | T1.1 `useReducer` 单一状态机消除竞态 |
| **favicon 加载失败** | 🟢 低 | 网络超时或 Google API 不可用 | 5s 超时 + AbortController + 三级回退 (native→Google→Globe2) |

### 5.2 项目风险

| 风险 | 等级 | 描述 | 缓解措施 |
|---|---|---|---|
| **改动范围过大** | 🔴 高 | `browser.rs` (~2500 行) 是核心文件,Phase 0/2/3 都涉及,改动密集 | 按 Phase 分批提交,每批独立 PR + `cargo check --lib` 门禁;优先做 P0 缓存 (收益最大,改动最小) |
| **测试覆盖不足** | 🔴 高 | collector 测试仅静态脚本检查 (含/不含字符串),无真实 DOM fixture;本机 `cargo test --lib` 无法运行 (Tauri 原生 DLL) | Phase 0 新增 6 个 P0 测试;ADR 0004 验证计划含 DOM collector fixture 测试 + Tauri smoke test + 手动 Windows 验证 |
| **自动化方案文档缺失** | 🟡 中 | `browser-automation-plan.md` 未就绪,Phase 2 任务清单基于 ADR 0004 推导 | 本方案已标注"以自动化方案为准"的位置;该文档就绪后需对齐 Phase 2 任务 |
| **多 Phase 并发冲突** | 🟡 中 | Phase 0/2/3 共享 `browser.rs` collector 宏与 session 管理 | 指定唯一 owner 实施 collector 合并批次;console/截图/collector 三方合并 |
| **`browser.rs` 行号过期** | 🟢 低 | 各文档行号基于特定版本,后续改动会偏移 | 以函数名/结构体名定位,行号仅作参考 |
| **ADR 0004 状态 Proposed** | 🟢 低 | ADR 0004 尚未 Approved,Phase 3 决策方向可能有调整 | Phase 3 启动前确认 ADR 0004 状态;P0 部分决策 (状态硬化/派发器) 已在本方案中提前部分实施 |

---

## 6. 实施建议

### 6.1 推荐执行顺序

```
Wave 1 (立即并行,~2 周)
├── Phase 0 P0 批次 (T0.1-T0.6, 1.5 人日) ── 收益最大:性能根因 + 核心字段
├── Phase 1 P0+P1 (T1.1-T1.7, 1.5 人日)   ── 体验根因:状态正确 + 视觉层次
└── Phase 2 截图 robust (T2.10, 独立)       ── 并行,无阻塞

Wave 2 (~2 周)
├── Phase 0 P1 批次 (T0.7-T0.12, 1 人日)    ── 补齐字段 + console 持久化
├── Phase 1 P2 (T1.8-T1.10, 2 人日)         ── 地址栏体验
└── Phase 2 P0 原生原语 (T2.1-T2.5, 2-3 人日) ── 自动化可靠性

Wave 3 (~2 周)
├── Phase 1 P3 + i18n (T1.11-T1.15, 0.7 人日) ── 收尾
├── Phase 2 P1+P2 (T2.6-T2.8/T2.11, 2-3 人日) ── locator + 等待 + 成本
└── Phase 3 P0 (T3.1-T3.4, 2-3 人日)        ── 状态硬化 + 派发器 + file://

Wave 4 (~1 周)
└── Phase 3 P1+P2 (T3.5-T3.12, 1.5-2 人日)  ── 产品体验 + 所有权 + 帮助页
```

**总计**: ~12-16 人日,4 个 Wave,约 5-6 周 (单人全职)。若多人并行,可压缩到 2-3 周。

### 6.2 每阶段 Go / No-Go 标准

| 阶段 | Go 标准 | No-Go 标准 |
|---|---|---|
| **Phase 0 P0** | `cargo check --lib` 零错误;`tsc --noEmit` 零错误;`cargo test` 新增 6 个 P0 测试通过;3000 节点诊断 ≤2s | 诊断 eval 仍超时;collector 脚本解析报错;TS 类型不兼容 |
| **Phase 1 P0+P1** | 状态机转换正确;后退/前进反映真实历史;三级按钮视觉差异明显;溢出菜单功能完整 | 状态机竞态;工具栏布局错乱;按钮样式无差异 |
| **Phase 1 P2** | favicon 三类协议图标正确;地址栏进度条随 loading 填充;Google API 回退生效 | favicon 加载阻塞页面渲染;进度条闪烁;超时未取消 |
| **Phase 2 P0** | 各原生原语命令返回正确结果;超时返回结构化错误;click/fill 原生回退生效 | 原语在主流页面失效;组合键行为不一致;截图崩溃 |
| **Phase 3 P0** | 重启后无 ghost tab;三派发入口行为一致;tab 关闭后 session 清理;AI file:// 被拒绝 | ghost tab 仍存在;派发入口行为不一致;清理逻辑漏 session |

### 6.3 回退方案

| 场景 | 回退策略 |
|---|---|
| Phase 0 扩展后诊断超时仍发生 | 回退到 Phase 0 前脚本;保留 WeakMap 缓存 (独立改动,可单独保留);将超时进一步升 6000ms 临时缓解 |
| Phase 1 地址栏 favicon 加载影响性能 | 回退 `useFavicon` 为惰性加载 (点击地址栏时才 fetch);保留 SecurityIndicator |
| Phase 1 状态机兼容问题 | 保留 `useReducer` 状态机,回退 UI 改动到旧布局 |
| Phase 2 原生原语不稳定 | 回退 click/fill 到纯 DOM 路径;原生原语保留但不作为默认回退;加 feature flag |
| Phase 3 派发器重构影响 SimpleAI/MCP | 回退到三路径独立实现;派发器改为增量接入 (先接入 ask-listener,再 MCP,再 SimpleAI) |
| 任意 Phase 影响 `cargo check --lib` | 立即回退该 Phase 提交;按批次最小粒度回退 (单个任务) |

### 6.4 关键门禁

1. **每批提交前**: `cargo check --lib` 零错误 + `tsc --noEmit` 零错误
2. **Phase 0 完成**: `cargo test` 全绿 (browser_script_tests)
3. **Phase 1 完成**: 前端 smoke test (浏览器 tab 打开/导航/讲解/修改/上下文/诊断 全链路)
4. **Phase 2 完成**: 原生原语 smoke test + click/fill 回退测试
5. **Phase 3 完成**: 重启后无 ghost tab 测试 + 三派发入口一致性测试
6. **合并前**: 手动 Windows 验证 (DPI 100%/125%/150%,多屏截图,模态遮罩)

---

## 7. 附录: 文件索引与行号引用

### 7.1 规划文档引用

| 文档 | 文件路径 | 状态 |
|---|---|---|
| UI 重构方案 | `docs/browser-ui-refactor-plan.md` (700 行) | ✅ 已读取 |
| 信息提取增强方案 | `docs/browser-info-extraction-plan.md` (989 行) | ✅ 已读取 |
| 自动化交互方案 | `docs/browser-automation-plan.md` | ⏳ **待写入** (三次重试后仍未就绪,Phase 2 基于 ADR 0004 撰写,待对齐) |
| ADR 0004 | `docs/adr/0004-built-in-browser-hardening-and-upgrade.md` | ✅ 已读取 (Proposed 状态) |

### 7.2 核心源码引用

| 文件 | 说明 |
|---|---|
| `src-tauri/src/commands/browser.rs` (~2500 行) | 浏览器后端命令、结构体定义、collector 脚本宏、测试模块 |
| `src/components/Browser/BrowserPanel.tsx` | 前端浏览器面板,工具栏/地址栏/状态栏/AI 面板 |
| `src/services/tauri/browserService.ts` | 前端浏览器服务,类型定义 + 命令封装 |
| `simple_ai/tools/browser.rs` | SimpleAI native 浏览器工具 |
| `src/stores/tabStore.ts` | Tab 状态管理 |
| `src/locales/{zh-CN,en-US}/common.json` | 国际化 |

### 7.3 人日汇总

| Phase | P0 人日 | P1 人日 | P2 人日 | 小计 |
|---|---|---|---|---|
| Phase 0: 信息提取增强 | 1.5 | 1.0 | 0.5 | 2.5 |
| Phase 1: UI 体验重构 | 0.5 | 1.0 | 2.5 | 4.2 |
| Phase 2: 自动化交互 | 2-3 | 2-3 | 1 | 4-6 |
| Phase 3: 架构完善 | 2-3 | 0.5 | 1 | 3.5-4.5 |
| **合计** | **6-7** | **4.5-5.5** | **5** | **15.5-17.5** |

> **去重说明**: 上表含重叠任务 (console 持久化 T0.9+T2.9+T3.9、截图 robust T2.10+T3.10、collector 增强 T0.2/3/T0.10+T2.6/11+T3.6/8) 的重复计数。合并实施后实际人日约 **12-16 人日**。

---

> **后续补充**: `docs/browser-automation-plan.md` 写入完成后,需读取并对齐 Phase 2 章节 (T2.1-T2.11),确认原生原语实现细节、等待条件参数、截图 robust 化方案是否与自动化方案文档一致,并更新人日预估。
