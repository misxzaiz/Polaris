# Polaris 轻量化改造方案规划分析

> 状态：规划分析（不含实施代码）
> 日期：2026-08-16
> 目标：在不破坏既有功能与生态的前提下，系统性降低 Polaris 的运行时资源占用、启动体积与二进制体积，并把"按需启用"作为一等公民固化到架构中。

---

## 0. 现状基线（决定改造空间的硬事实）

### 0.1 代码体量

| 层 | 文件数 | 行数 | 备注 |
|---|---|---|---|
| 前端 TS/TSX | 700 | ~161,800 | `components/` 独占 ~79,500 行 |
| Rust | 237 | ~106,700 | `services/` 41 文件，`ai/engine/` 11 文件 |
| 合计 | 937 | ~268,500 | 单体仓库 |

前端重量大头：`Chat`(21,338) `Settings`(12,973) `GitPanel`(8,487) `Scheduler`(4,844) `Editor`(4,047)。
Rust 重量大头：`commands/browser.rs`(3,606) `commands/chat.rs`(3,512) `ai/engine/dsh.rs`(2,540) `web/api/ipc.rs`(2,507) `services/mcp_config_service.rs`(2,177)。

### 0.2 依赖体积

- 前端关键重包：`@codemirror/*`(18+ 子包) `highlight.js`(full build) `mermaid` `katex` `@xterm/*` `react-virtuoso` `@openai/codex`。
- Rust 关键重依赖：`git2`(vendored-openssl) `tree-sitter`+`tree-sitter-java` `rusqlite`(bundled) `axum`/`tower`/`tower-http` `reqwest`(blocking+rustls) `portable-pty` `xcap`+`enigo`+`uiautomation`(Windows)。
- Cargo release profile 已做 `opt-level=z` + `fat lto` + `codegen-units=1` + `strip=symbols`，二进制侧无明显压榨空间。

### 0.3 既有先期工作（必须复用，不可重造）

| 文档 | 方向 | 落地状态 |
|---|---|---|
| `performance-features-default-off-plan.md` | 8 项资源密集功能开关默认关 + 热切换 | **P0 主体已实施**——`PerformanceFeatures` 结构体在 `config.rs:1621`、Config 字段 `config.rs:1605`、Default `config.rs:1730`；后端命令门控齐全（`file_watcher.rs:22`/`lsp.rs:145,221`/`scheduler.rs:341`）；前端 `usePerformanceFlag` hook + `PerformanceTab` 设置面板 + `performanceHotSwitchStore` 热切换 + `useAppInit` 注册。**唯一原缺口**：`codeEditorLanguages` 零消费点，已补预加载路径 |
| `capability-seam-upgrade-design.md` / `-implementation-plan.md` | 内置能力(shell/fs/compaction/subagent)可被插件替换 | **P1/P2/P3 已实施**——四 trait seam + CapabilityRegistry + UI Slot + 4 demo 插件 |
| `git-plugin-extraction-plan.md` | Git 功能外迁为外部插件 | **部分实施**——主项目内置 GitPanel 保留，编辑器 git 集成 + polaris-git 插件已落地 |
| `manualchunks-circular-dep` 记忆 | 前端 chunk 拆分循环依赖 | 已修：Editor+Settings+LSP 合并，`lru-cache`/`syntaxHighlight` 并入 `app-editor-settings` |
| Mermaid 已 `dynamic import` | 图表懒加载 | **已实施** |
| katex 已 `dynamic import` + 块识别门控 | 公式懒加载 | **已实施**（`cache.ts:35,126`） |
| 编辑器语言包已 `dynamic import` | 语言包按需加载 | **已实施**（`Editor.tsx:87-109`） |

> **P0 实施度修正**：原方案判断"`PerformanceFeatures` 未实施是最大缺口"与代码现实不符。逐项核查证实 P0 主体已全面落地。唯一真正缺口是 `codeEditorLanguages` 开关——query 函数已定义但零调用点，开关可切换但开启无效果。已补齐（见 §3.3）。

- 桌面 Tauri exe、Web 独立服务(`polaris_web` bin)、Android APK(`polaris-mobile`)、Pocket 精简端并存。
- Cargo `default = ["tauri-app"]`，`--no-default-features` 可产 Web-only 服务（所有 `#[tauri::command]` 已门控 `tauri-app`）。
- 平台条件依赖已就位：Windows 的 `enigo/xcap/uiautomation`、非 Android 的 `portable-pty`、非 Windows 的 `libc` 均按 target 门控。

---

## 1. 问题诊断：为什么"重"

轻量化不是无脑删代码，而是消除"**用户用不到的能力仍在常驻/被打进包里**"。Polaris 当前四类重量来源：

### 1.1 运行时常驻（CPU/内存）
- `file_watcher` 启动即 500ms 轮询递归扫描 + 独立线程。
- `lsp_index` 首次构建打满多核 tree-sitter 解析，每 workspace 一份 SQLite + 缓存常驻。
- `scheduler_daemon` 10s 轮询，即使无任务。
- 插件服务 `autoStartAll`：每个插件一进程 10–50MB。
- `highlight.js` full build 常驻内存。

**根因**：缺少**默认关闭 + 懒激活**机制，所有能力都"装好即开"。

### 1.2 打包即进（前端 bundle）
- `highlight.js` full import（`import hljs from 'highlight.js'`）→ 整包进主 chunk。
- 12 个 `@codemirror/lang-*` 预加载，无论用户是否编辑对应语言。
- `katex` 常驻主包。
- `Chat`(21k行)/`Settings`(13k行) 单块组件，首屏即全量加载，无路由级懒加载。

**根因**：缺少**按需 import 边界**，重型展示能力未与首屏解耦。

### 1.3 二进制耦合（Rust）
- `git2`(libgit2) + `tree-sitter`+`tree-sitter-java` + `rusqlite`(bundled sqlite) 无条件编进所有 target，即便 Web-only 用户不用 git/不用 LSP。
- `axum`/`tower` HTTP 层在桌面单机场景也常驻（LAN 访问用）。
- 单一 `default` feature 无法表达"我只要聊天不要 git/LSP/调度器"。

**根因**：**Cargo feature 粒度太粗**，只区分 `tauri-app`/Web，不区分功能域。

### 1.4 单体组件膨胀
- `components/Chat` 21k 行混了输入/历史/卡片/渲染/上下文/压缩——单 chunk 难拆。
- `stores/conversationStore` 8k 行单文件，承载所有会话状态。
- 跨域耦合：`viewStore`/`tabStore` 硬编码 `TabType='git'`，核心 store 知道具体功能域。

**根因**：核心层与功能域**双向耦合**，功能域不能独立"拿掉"。

---

## 2. 改造总方针

一句话：**让每个能力都能"不在场"**——不在内存、不在 bundle、不在二进制。

四个抓手，按 ROI 与独立性排序：

| 抓手 | 解决的重量类型 | 既有基础 | ROI |
|---|---|---|---|
| A. 功能开关默认关 + 热切换 | 运行时常驻 | `performance-features-default-off-plan.md` 设计完整，**待实施** | 极高 |
| B. 前端按需 import 边界 | bundle 体积 | Mermaid 已验证、manualChunks 已修 | 高 |
| C. Cargo 功能域 feature 网格 | 二进制耦合 | `tauri-app` 门控 + 平台条件依赖已就位 | 中高 |
| D. 功能域与核心解耦 | 单体膨胀 | Capability Seam + view contribution 插件化已做大半 | 中（长期） |

**原则**：
1. **零行为变更**——未改配置时系统行为与现状完全一致（向后兼容是硬约束）。
2. **默认关 ≠ 删功能**——所有能力保留，只是不在启动时激活。
3. **每步可独立交付、可独立回滚**——抓手之间无强依赖。
4. **复用先期工作**——A 复用 perf-plan 文档设计，D 复用 capability-seam 架构，不另起炉灶。

---

## 3. 抓手 A：功能开关默认关 + 热切换（首要、最高 ROI）

### 3.0 实施现状（P0 已完成）

逐项核查证实 P0 主体已全面落地，**无需从零实施**：

| 开关 | Rust 门控 | 前端消费 | 热切换 | 状态 |
|---|---|---|---|---|
| fileWatcher | ✅ `file_watcher.rs:22` | ✅ | ✅ hotSwitch stop | ✅ 完整 |
| lspIndex | ✅ `lsp.rs:145,221` | ✅ `IndexStatusBadge` | ✅ 双向热启停 | ✅ 完整 |
| schedulerDaemon | ✅ `scheduler.rs:341` | ✅ | ✅ hotSwitch stop | ✅ 完整 |
| syntaxHighlighting | —（前端） | ✅ `CodeBlock.tsx:205` | ✅ 下次调用生效 | ✅ 完整 |
| mermaidDiagrams | — | ✅ `DeferredMermaid:122` | ✅ 下次调用生效 | ✅ 完整 |
| katexMath | — | ✅ `cache.ts:35,126` | ✅ 下次调用生效 | ✅ 完整 |
| codeEditorLanguages | — | ⚠️ 原零消费点 | ✅ 已补热预加载 | ✅ 已补齐 |
| pluginAutoStart | — | ✅ `useAppInit:147` | ✅ 下次调用生效 | ✅ 完整 |

### 3.1 定位
P0 的实际工作是**补齐 `codeEditorLanguages` 的唯一缺口**：开关 query 函数 `isCodeEditorLanguagesEnabled` 已定义但零调用点，开关在 UI 可切换但开启无效果。编辑器语言包本已是 dynamic import（默认关=按需加载=当前行为，轻量目标已满足），缺的是"开启=预加载全部语言包"的路径。

### 3.2 已补实施

**`src/components/Editor/Editor.tsx`**：
- 导出 `LANGUAGE_LOADERS`（13 语言的 dynamic import 加载器，与 `getLanguageExtension` 的 langMap 一致）。
- 导出 `preloadLanguageExtensions()`：并行触发所有加载器、`Promise.allSettled`、失败仅 warning（单点 import 兜底）。

**`src/hooks/useAppInit.ts`**：
- config 加载后、`performance.codeEditorLanguages=true` 时，`requestIdleCallback`（不支持则降级立即）触发预加载，不与首屏抢资源。

**`src/stores/performanceHotSwitchStore.ts`**：
- `handleSwitch` 补 `codeEditorLanguages` false→true 热预加载（动态 import Editor 模块调 `preloadLanguageExtensions`）；true→false 无需动作（已加载模块留缓存，自然降级）。

### 3.3 关键修正（相对 perf-plan 的设计迭代）
1. **懒激活优先于纯开关**：`scheduler_daemon`、`plugin_auto_start` 已是"命令触发/首次调用时启动"而非 setup 自动拉起——开关退化为上限闸门，默认体验不变。
2. **降级路径保活**：`lsp_index=false` 时 `find_definition` 已有 `regex_fallback`，关闭仍可跳转（精度降低）。
3. **前端等效热切换**：后端无 `config-changed` 监听端，但 `performanceHotSwitchStore` 通过前端 listen + 调用后端 stop 命令实现等效热切换，后端监听非必需。
    pub plugin_auto_start: bool,
}
### 3.4 风险
- 热切换状态机复杂度：服务 stop 必须可重入、必须释放资源（线程/句柄/DB 连接）。`performanceHotSwitchStore` 已实现 fileWatcher/scheduler stop + lspIndex 双向，幂等性由各 service stop 保证。
- 配置迁移：旧 config 无 `performance` 字段，`#[serde(default)]` 已兜底，无破坏性。

---

## 4. 抓手 B：前端按需 import 边界

### 4.0 已实施：hljs core 化（2026-08-16 提交 `259d5294`）

**收益实测**（esbuild bundle 对比，minify）：
- full `import hljs from 'highlight.js'`：**1,055 KB**
- core + 15 种语言：**79 KB**
- **节省 ≈ 976 KB（约 90%，gzip 后约 250 KB）**

**改动**：新增 `src/utils/highlight.ts`（highlight.js/lib/core + 15 语言单次注册 + 补 yaml + 共享缓存/显示名），三处消费方（CodeBlock/MarkdownEditor/syntaxHighlight）全量 import → 都改走统一实例。消除语言清单三处漂移（yaml 此前完全未注册）。全量 import 已清零。

**待办**：katex/codemirror lang 按需加载已在 P0 就位；非首屏面板路由懒加载（§4.2）尚未实施。

### 4.1 高亮/公式/图表三件套
- ✅ `highlight.js`：core 化完成（§4.0）。
- ✅ `katex`：P0 已按需（`cache.ts` dynamic import + 块识别门控）。
- ✅ `@codemirror/lang-*`：P0 已按需（`Editor.tsx` 打开文件时 dynamic import，`codeEditorLanguages` 控制 idle 预加载）。
- ✅ 抓手 A 的 `syntax_highlighting=false` 直接跳过 hljs，与 B 的按需注册**正交叠加**。

### 4.2 路由级 / 面板级懒加载
- ✅ **已实施**：`App.tsx` 21 个非首屏面板全部 `React.lazy`（GitPanel/SchedulerPanel/TerminalPanel/BrowserSidebarPanel/AgentGalleryPanel/PersonalHubPanel/RequirementPanel/NotificationCenterPanel/VoiceCompanionOverlay/FocusOverlay 等）。首屏静态 import 仅 Layout/FileExplorer/TopMenuBar/Chat 核心 + 少量 overlay。
- ✅ **mermaid/katex 隔离验证**：精确分析 main chunk（1.46MB raw），`mermaid.initialize/flowchart-v2/classDiagram`、`katex.renderToString` 等 API 特征**均 absent**——首屏未被污染。mermaid(295K)+mermaid-core(3MB) 与 katex(260K) 独立 chunk 均动态加载。
- ✅ **stores/conversationStore**：Chat/index 导出均为聊天核心组件，无重面板拖累。
- ⚠️ mermaid-core 3MB 偏大但已隔离在首屏外，深水区分按需图表注册（registerDiagram）留后续评估（价值：优化首次图表渲染延迟，非启动指标）。

### 4.3 风险
- 懒加载引入首交互延迟（mermaid/hljs 动态 import 约 50–200ms），用骨架屏 + 预取(prefetch idle) 缓解。
- `stores/conversationStore` 8k 行单文件若被 Chat 之外的轻量入口引用，会拉回重依赖——需审计 store 的消费方，把重型 store 按域拆分（见抓手 D）。

---

## 5. 抓手 C：Cargo 功能域 feature 网格

### 5.1 定位
现有 `tauri-app`/Web 二分太粗。目标是把**可独立的能力域**表达为 Cargo feature，让桌面精简版/Web-only 服务能**不编进** git/LSP/调度器等重依赖。

### 5.2 候选 feature 网格（待评估可独立性）

| feature | 携带依赖 | 独立性 | 备注 |
|---|---|---|---|
| `git` | `git2`(vendored-openssl) | 高 | commands 已全门控；git-plugin-extraction 已将部分能力外迁，主项目可降级为可选 |
| `lsp-index` | `tree-sitter`+`tree-sitter-java`+`rusqlite`+`rayon`+`xxhash` | 高 | regex_fallback 兜底，关 feature 走降级 |
| `scheduler` | `cron` | 高 | 后台调度可整体可选 |
| `web-server` | `axum`/`tower`/`tower-http`/`if-addrs` | 中 | Web-only 与桌面单机的分叉点 |
| `computer-control` | Windows 的 `enigo/xcap/uiautomation` 已门控 | 已就位 | 仅补 feature 开关 |
| `pty` | `portable-pty` | 中 | 非编辑器用户可关 |
| `integrations` | `tokio-tungstenite` 等(钉钉/飞书/QQ) | 高 | 三平台机器人可整体可选 |

### 5.3 实施约束（避免破坏）
1. **默认全开**：`default = ["tauri-app","git","lsp-index","scheduler","web-server","integrations"]`，保证现状不变。
2. **每个可选 feature 必须有 `#[cfg(feature=...)]` 双向门控**：模块声明 + `invoke_handler` 注册 + `mod.rs` re-export 三处同步（参考 `web-only-tauri-command-gate` 记忆的教训）。
3. **Web-only 路径不动**：`--no-default-features --features web-server` 仍需编译通过，这是回归底线。
4. **体积收益实测**：feature 加/减前后用 `cargo build --release` 对比 exe 体积，记录到方案文档。

### 5.4 风险
- feature 组合爆炸：用 CI 矩阵覆盖 `{default, web-only, 精简桌面}` 三档即可，不穷举全部组合。
- `git2` vendored-openssl 编译耗时，关 `git` feature 能显著加速 CI，但需确认无其他 crate 隐式依赖 `git2` 类型。

---

## 6. 抓手 D：功能域与核心解耦（长期、渐进）

### 6.1 定位
让 `GitPanel`/`Scheduler`/`Browser` 等**功能域能像插件一样被移除而不动核心**。复用 capability-seam P2/P3 的 seam + UI Slot 架构，把"内置功能域"逐个降格为"默认安装的内置插件"。

### 6.2 解耦信号灯
核心层(`viewStore`/`tabStore`/`CenterStage`)当前仍**硬编码** `TabType='git'`、`tab.type==='git'` 渲染分支。解耦的判据：
- 核心不再 `import` 任何具体功能域组件，全部走 `view contribution` / `panel registry`。
- 功能域的 store、组件、命令能整体置于 `#[cfg(feature)]` / `lazy()` 后而不触发核心编译错误。

### 6.3 迁移路径（最小风险）
1. 先把 **Git** 走完插件化全程（`git-plugin-extraction-plan.md` §2 方案 B/C 的剩余步骤），作为"功能域外迁"的参照样板。
2. 复刻到 **Scheduler** / **Browser**，每个域独立 PR、独立回滚。
3. 核心 store 的 `TabType` 由硬编码枚举改为 `string + registry`，保持 TS 向后兼容。

### 6.4 风险
- 这是**最重投入**的抓手，单 PR 影响面大，必须排在 A/B/C 之后，且每域独立交付。
- 与既有插件生态已有 seam 高度重合，要避免"又造一套"——能复用 `pluginRegistry`/`chatCardRegistry`/`toolProviders` 就不新建抽象。

---

## 7. 分阶段路线图

| 阶段 | 抓手 | 交付物 | 验收 | 预计 |
|---|---|---|---|---|
| **P0** | A | `PerformanceFeatures` + 8 开关热切换 + 设置页"性能"面板 | 关闭全部开关后启动内存/CPU 显著下降；功能可手动恢复 | 3–5 人日 |
| **P1** | B | hljs core 化 + katex/语言包按需 + 非首屏面板 lazy | 首屏 chunk 体积下降（需量化对比）；首交互延迟 < 200ms | 4–6 人日 |
| **P2** | C | Cargo 功能域 feature 网格 + 三档 CI 矩阵 | `--no-default-features --features <精简集>` 编译通过；exe 体积对比记录 | 5–8 人日 |
| **P3** | D | Git 完整外迁（样板）→ Scheduler/Browser 复刻 | 核心不再 import 功能域；移除某域核心仍编译通过 | 10–15 人日（分多 PR） |

**依赖关系**：A/B 可并行且独立；C 可在 A 之后（开关机制先就位，feature 才有"关闭"语义对照）；D 依赖 C（feature 网格是功能域可移除的前置）。

---

## 8. 验收与度量基线

轻量化必须有可度量的胜利标准，否则"感觉变快"无法验收。建议建立基线仪表盘：

| 指标 | 测量方法 | 目标（P0–P2 后） |
|---|---|---|
| 冷启动驻留内存 | Tauri 启动后 30s 进程 RSS | 较基线下降 ≥ 25% |
| 冷启动 CPU 峰值 | 启动后 10s 均值 | 较基线下降 ≥ 40% |
| 首屏 JS bundle | `vite build` 报告 main chunk | 较基线下降 ≥ 15% |
| release exe 体积 | `cargo build --release` 产物 | 精简 feature 较全量下降 ≥ 15% |
| 首交互延迟 | hljs/mermaid dynamic import 耗时 | < 200ms |
| 功能完整性回归 | 关闭开关后逐项手测 + 回归测试 | 所有功能可手动恢复，无数据丢失 |

度量结果记入本文档附录，作为后续回归基线。

---

## 9. 与既有方案的关系映射

| 本方案抓手 | 对应既有文档 | 关系 |
|---|---|---|
| A 功能开关 | `performance-features-default-off-plan.md` | 直接落地该文档设计（补 `PerformanceFeatures` 结构体 + 热切换） |
| B 按需 import | Mermaid 已实施 + `manualchunks` 记忆 | 推广 Mermaid 模式至 hljs/katex/lang-*，复用 manualChunks 簇策略 |
| C feature 网格 | `web-only-tauri-command-gate` 记忆 + `git-plugin-extraction-plan.md` | 扩展 `tauri-app` 二分为功能域网格；git feature 化是 git-plugin 外迁的 Rust 侧配套 |
| D 功能域解耦 | `capability-seam-*` + `git-plugin-extraction-plan.md` | 复用 seam/UI Slot，Git 作样板，不新建抽象 |

**结论**：本方案不引入新架构，而是把四份既有设计/记忆**整合为统一执行路线**并补齐缺失环节（`PerformanceFeatures` 未实施是最大缺口）。

---

## 10. 决策建议

1. **立即启动 P0（抓手 A）**：成本最低、收益最高、零架构风险，且文档已设计完整，纯属补实施。
2. P1（抓手 B）紧随其后，与 P0 在前端设置开关上天然协同。
3. P2（抓手 C）排 P0 之后，因 feature 关闭的语义需要开关机制对照才有意义。
4. P3（抓手 D）按域拆分、长线推进，每域独立 PR，Git 先行作样板。

**不推荐做的**：
- 不要为了"轻"而删功能或删依赖——`git2`/`tree-sitter` 等即使做 feature 化也默认开启，只是给"精简用户"一个关闭选项。
- 不要重新设计插件抽象——capability-seam 已完成 P1–P3，复用即可。
- 不要把 `PerformanceFeatures` 与 Cargo feature 混为一谈——前者是**运行时开关**（包还是全的，只是不启动），后者是**编译期开关**（不编进包）。两者正交，A 与 C 不冲突。

---

## 附录 A：待量化基线（实施时补填）

| 指标 | 基线值(当前) | P0 后 | P1 后 | P2 精简档 |
|---|---|---|---|---|
| 启动 RSS | _待测_ | | | |
| 启动 CPU 峰值 | _待测_ | | | |
| 首屏 bundle | _待测_ | | | |
| release exe | _待测_ | | | |

## 附录 B：关键锚点文件

- 后端配置：`src-tauri/src/models/config.rs`(1,829 行，需加 `PerformanceFeatures`)
- 后端启动：`src-tauri/src/lib.rs`(1,196 行，`invoke_handler` + 服务初始化门控点)
- 性能开关设计源：`docs/performance-features-default-off-plan.md`
- 能力 seam：`docs/capability-seam-upgrade-design.md` / `-implementation-plan.md`
- Git 外迁：`docs/git-plugin-extraction-plan.md`
- 前端高亮：`src/components/Chat/CodeBlock.tsx`(hljs 全量 import 改造点)
- 前端组件重量：`src/components/`(各二级目录体积见 §0.1)
- Web IPC 桥接：`src-tauri/src/web/api/ipc.rs`(2,507 行，feature 门控需同步)
