# PerformanceFeatures 生产级闭环 — 实施记录

> 日期：2026-08-19
> 攻坚：完成 PerformanceFeatures 性能开关体系在所有消费点的闭环（5 个真实缺口）
> 流程：20 轮分析 → 20 轮验证 → 20 轮痛点搜索 → 20 轮最终确定 → 20 轮开发 → 5 轮测试

## 背景

`docs/performance-features-default-off-plan.md` 设计了 8 个性能开关，骨架已建（Rust 结构体 + 前端 store + 设置页 + 热切换 store + 读点辅助），但勘察发现多个消费点"形同虚设"或启动路径未门控。本轮完成生产级闭环。

## 缺口与实施

### G1：MermaidDiagram 编辑器门控
- **缺口**：`src/components/Chat/MermaidDiagram.tsx`（编辑器 MarkdownEditor 使用）未读 `mermaidDiagrams` 开关，关闭时仍加载 mermaid.js。聊天路径用 `DeferredMermaidDiagram` 已门控。
- **实施**：
  - `MermaidDiagram` 加 `enabled?: boolean` prop（默认 true 向后兼容）
  - `enabled=false`：不启动 IntersectionObserver，显示"点击渲染"占位（复用 DeferredMermaidDiagram 模式），点击 `handleRequestRender` 触发渲染
  - memo 比较加 `enabled` 维度（确保开关切换重渲染）
  - `MarkdownEditor.tsx` 用 `usePerformanceFlag('mermaidDiagrams')` 读开关传入
- **文件**：`src/components/Chat/MermaidDiagram.tsx`、`src/components/Editor/MarkdownEditor.tsx`

### G2：pluginAutoStart 懒激活
- **缺口**：`pluginAutoStart=false` 时无懒激活，首次使用插件功能不会自动拉起服务，直接失败。
- **实施**：`pluginServiceManager` 新增 `ensureServiceRunning(pluginId, serviceId, contribution, installPath, workspacePath?)`：
  1. 查 `ensureInflight` Map 复用进行中 Promise（并发去重）
  2. `listStatus` 查已 running/starting → 直接返回
  3. 否则 `startService`，存入 Map，`.finally` 清理
  - **竞态修正**：把"查状态+启动"包成 IIFE promise，同步段立即 set Map，确保 get→set 间无 await（JS 单线程无竞态）
- **文件**：`src/services/pluginServiceManager.ts`、`src/services/pluginServiceManager.test.ts`（6 测试全过）

### G3：scheduler 桌面端自动启动
- **缺口**：tauri-app setup 闭包不启动 scheduler，定时任务桌面端默认永不自动执行（仅用户手动启动）。
- **实施**：
  - `commands/scheduler.rs` 新增 `start_scheduler_if_needed(app)` 共享函数（`#[cfg(all(feature="tauri-app", feature="scheduler"))]`）：
    1. `is_holding_lock` → 已运行返回
    2. 配置门控 `performance.scheduler_daemon`
    3. **懒激活**：`list_tasks().iter().any(|t| t.enabled)` 无活跃任务不启动
    4. `acquire_and_hold_lock` 锁互斥
    5. `SchedulerDaemon::start` + 存 state
  - `lib.rs` setup 闭包 `tokio::spawn` 异步调用，失败仅 warn，不阻塞启动
  - web-only 编译：`#[cfg(all(feature="tauri-app", feature="scheduler"))]` 门控
- **文件**：`src-tauri/src/commands/scheduler.rs`、`src-tauri/src/lib.rs`

### G3 衍生：schedulerDaemon 热启动
- **缺口**：`performanceHotSwitchStore` 只处理 schedulerDaemon true→false 停止，缺 false→true 热启动。
- **实施**：`handleSwitch` 加 `!prev.schedulerDaemon && next.schedulerDaemon` → `schedulerStart()`（用户主动开启=明确意图，与 setup 懒激活不同）
- **文件**：`src/stores/performanceHotSwitchStore.ts`

### G4：迁移引导横幅
- **缺口**：默认全关后老用户升级"功能突然失效"无引导（plan §3.2 风险）。
- **实施**：
  - Rust `Config` 加 `#[serde(default)] pub perf_migration_dismissed: bool`（跨设备持久化）
  - 前端 `Config` interface 加 `perfMigrationDismissed?: boolean`
  - 新建 `PerfMigrationBanner.tsx`（标题 + 文案 + "查看开关"/"知道了"按钮）
  - `PerformanceTab` 顶部：`allOff && !migrationDismissed` 时渲染横幅，dismiss → `onConfigChange({...config, perfMigrationDismissed: true})`
- **文件**：`src-tauri/src/models/config.rs`、`src-tauri/src/services/config_store.rs`、`src/types/config.ts`、`src/components/Settings/tabs/PerfMigrationBanner.tsx`、`src/components/Settings/tabs/PerformanceTab.tsx`

## 接线状态总表（闭环后）

| 开关 | 启动 | 命令/渲染 | 热切换 | 迁移 |
|------|------|-----------|--------|------|
| fileWatcher | startFileWatcher 预检 | 命令门控 | ✅ stop | — |
| lspIndex | 按需 ensureOpen | — | ✅ open/close | — |
| schedulerDaemon | ✅ G3 懒激活 | 命令门控 | ✅ G3衍生 start/stop | — |
| syntaxHighlighting | — | 渲染门控 | 响应式 | — |
| mermaidDiagrams | — | ✅ G1 编辑器+聊天 | 响应式 | — |
| katexMath | — | 渲染门控 | 响应式 | — |
| codeEditorLanguages | useAppInit 预热 | — | ✅ start | — |
| pluginAutoStart | useAppInit 门控 | ✅ G2 懒激活 | 响应式 | — |
| (迁移横幅) | — | — | — | ✅ G4 |

## 验证

- `cargo check --lib --features tauri-app,scheduler`：0 新增 error（既有 windows_sys/proxy_manager 与本任务无关）
- `pnpm tsc --noEmit`：改动文件 0 error（既有 49 个错误均非本次引入）
- `pnpm vitest run src/services/pluginServiceManager.test.ts`：6/6 通过
- 待手测：编辑器 mermaid 开关、scheduler 自动启动、横幅 dismiss

## 非目标

- 不重构开关模型（8 字段已合理）
- 不做 P2 Cargo feature 网格（独立方案）
- 不改 git/lsp-index 代码生成层
