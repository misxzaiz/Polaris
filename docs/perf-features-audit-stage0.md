# PerformanceFeatures 开关接线状态诊断（阶段0 勘察结论）

> 本轮自治攻坚的选定需求：**完成 `PerformanceFeatures` 性能开关体系的"生产级闭环"**
> 选型依据：memory 记录"PerformanceFeatures 未实施是最大缺口"；最近 5 个 commit（P0-P4 性能优化）为主线。
> 勘察结论：骨架已建（8 开关 + Config + 前端 store + 设置页 + 热切换 store + 读点辅助），**多数开关消费点已接线**，但存在若干"形同虚设"与"启动路径未门控"的真实生产缺口。

---

## 一、8 开关接线状态精确画像

| 开关 | Rust 字段 | 读点位置 | 接线状态 | 缺口 |
|------|-----------|----------|----------|------|
| `fileWatcher` | `file_watcher` | `commands/file_watcher.rs:22` 命令层 | ✅ 已门控 | 命令层门控，但**启动时是否自动 start 取决于前端调用**，需核实 |
| `lspIndex` | `lsp_index` | 前端 `performanceHotSwitchStore` + `lspIndexStore` | ✅ 已门控 | 热开启/关闭均有；启动时**按需 ensureOpen**，默认不自动打开 ✅ |
| `schedulerDaemon` | `scheduler_daemon` | `commands/scheduler.rs:341` `scheduler_start` 命令 | ⚠️ 命令层门控 | **tauri-app 启动路径根本不启动 scheduler**（仅 standalone web 模式 1241 行启动）。意味着桌面端定时任务默认永不自动执行——这是真实缺口或设计意图，需确认 |
| `syntaxHighlighting` | `syntax_highlighting` | `utils/syntaxHighlight.ts:26` | ✅ 已门控 | 关闭时返回 `escapeHtml(code)` 纯文本 ✅ |
| `mermaidDiagrams` | `mermaid_diagrams` | `DeferredMermaidDiagram.tsx:122` | ✅ 已门控 | 聊天管线用 DeferredMermaidDiagram（非 MermaidDiagram），关闭时不自动渲染、显示"点击渲染"按钮 ✅。但 `MermaidDiagram.tsx`（MarkdownEditor 用）**未读开关**，始终自动渲染——部分缺口 |
| `katexMath` | `katex_math` | `utils/cache.ts:35,128,145` | ✅ 已门控 | tokenizer/renderer/start 三处门控，关闭时不加载 katex ✅ |
| `codeEditorLanguages` | `code_editor_languages` | `useAppInit.ts:183` + hot switch | ✅ 已门控 | 默认不预热，按需 dynamic import ✅ |
| `pluginAutoStart` | `plugin_auto_start` | `useAppInit.ts:148` | ✅ 已门控 | 关闭跳过 autoStartAll ✅。但**懒激活**（首次调用拉起）未实施——plan §2.8 要求的"首次调用检查服务是否运行"缺 |

---

## 二、真实生产级缺口清单（本轮攻坚目标）

### 缺口 G1：`MermaidDiagram.tsx` 未门控 `mermaidDiagrams`
- 位置：`src/components/Chat/MermaidDiagram.tsx:68`
- 现状：`MarkdownEditor.tsx:296` 使用的 `MermaidDiagram` 组件**无条件懒加载渲染**，不读 `isMermaidDiagramsEnabled`
- 影响：在编辑器预览中，关闭 mermaid 开关后仍会加载 mermaid.js（~1.5MB）并渲染图表，开关在编辑器场景形同虚设
- 修复：复用 DeferredMermaidDiagram 模式，关闭时显示"点击渲染"

### 缺口 G2：`pluginAutoStart` 懒激活未实施
- 位置：插件功能调用处（各 `pluginServiceManager` 调用点）
- 现状：关闭后**无懒激活**——首次使用插件功能时不会自动拉起服务，直接失败
- 影响：用户体验断裂——开关描述承诺"首次使用时才按需启动"，实际关闭后插件功能不可用
- 修复：在 `pluginServiceManager.ensureRunning(name)` 加懒激活包装，首次调用拉起

### 缺口 G3：scheduler 守护进程桌面端无自动启动入口
- 位置：`lib.rs` tauri-app setup 闭包
- 现状：桌面端启动时**完全不调 `scheduler_start`**，定时任务默认永不执行（除非用户手动点启动）
- 影响：与 `schedulerDaemon` 开关语义不一致——开关关闭=不启动（合理），但开关开启时桌面端也无自动启动路径
- 修复：setup 闭包内，`scheduler_daemon=true` 时调 `scheduler_start`（懒激活：有活跃任务才启）

### 缺口 G4：老用户升级迁移引导横幅未实施（plan §3.2 Phase 3）
- 位置：设置页 / 全局通知
- 现状：默认全关后，老用户升级"文件监听/调度器突然失效"，**无任何引导提示**
- 影响：静默破坏现有功能，用户不知为何功能消失
- 修复：首次检测到 `performance` 字段为默认全 false 且有历史活跃任务/监听使用记录时，显示横幅

### ~~缺口 G5：fileWatcher 启动路径门控不完整~~（已撤销）
- 勘察修正：`fileExplorerStore.ts:731 startFileWatcher` **已在调用前预检 `isFileWatcherEnabled()`**，关闭时直接 return，不发起 IPC。命令层双重门控是冗余保险，非缺口。
- 结论：fileWatcher 接线完整，无需改动。

---

## 三、本轮攻坚范围（生产级闭环）

**核心目标**：让 8 个 PerformanceFeatures 开关在**所有消费点**（启动 / 命令 / 渲染 / 热切换 / 迁移）形成完整闭环，无"形同虚设"的开关。

**实施项**（按风险与依赖排序）：
1. G1 MermaidDiagram 门控（渲染层，低风险）
2. G2 pluginAutoStart 懒激活（插件服务层，中风险）
3. G3 scheduler 桌面端自动启动入口（启动路径，中风险，需复用锁逻辑）
4. G4 迁移引导横幅（UX，低风险）
5. 文档同步：更新 `docs/performance-features-default-off-plan.md` Phase 0-3 勾选状态 + `docs/lightweight-refactor-plan.md` 接线表

**非目标**（明确排除）：
- 不重构开关模型（8 字段已合理）
- 不做 P2 Cargo feature 网格（独立方案，memory 记录在 `lightweight-p2-feature-grid-analysis.md`）
- 不改后端 git/lsp-index 代码生成层

---

## 四、验证基线（每轮分析/验证需对照）

- **编译**：`cargo check --lib`（本机 lib 测试无法运行，见 memory `rust-lib-test-env-limit`）+ `pnpm tsc --noEmit`
- **类型**：前端 `PerformanceFeatures` 类型在 `src/types/config.ts:484+`
- **测试**：`pnpm test` 相关单测
- **锚点文件**：
  - `src-tauri/src/models/config.rs:1614-1685`（结构体 + 默认值）
  - `src/utils/performanceFeatures.ts`（读点辅助）
  - `src/stores/performanceHotSwitchStore.ts`（热切换）
  - `src/components/Settings/tabs/PerformanceTab.tsx`（设置页）
