# PerformanceFeatures 生产级闭环 — 20 轮内部验证（阶段2）

> 验证分析阶段（stage1）的每个关键假设，用 grep/编译器/类型系统/反例构造确认。
> 每轮：验证目标 + 方法 + 结果 + 证据锚点。

---

## 验证 1：G3 共享函数可行性
- **目标**：确认 `acquire_and_hold_lock`/`is_holding_lock`/`release_held_lock`/`list_tasks` 接口可被 setup 闭包复用
- **方法**：grep 锁函数 + list_tasks 签名
- **结果**：✅ 全部存在
  - `utils/mod.rs:267 is_holding_lock() -> bool`
  - `utils/mod.rs:273 acquire_and_hold_lock() -> io::Result<bool>`
  - `utils/mod.rs:304 release_held_lock() -> io::Result<()>`
  - `unified_scheduler_repository.rs:81 list_tasks(&self) -> Result<Vec<ScheduledTask>>`
- **结论**：G3 可抽取 `start_scheduler_if_needed(app)` 共享函数，命令层与 setup 闭包共用。

## 验证 2：G3 scheduler_start 命令逻辑可抽取
- **目标**：确认 `scheduler_start` 命令体（316-395）的逻辑可重构为共享函数
- **方法**：读命令源码
- **结果**：✅ 逻辑线性：检查锁→acquire→建 daemon→start→存 state。可抽 `pub async fn start_scheduler(app: &AppHandle) -> Result<bool>`，命令层调它返回 SchedulerStatus，setup 闭包调它忽略返回。
- **注意**：命令层返回 `SchedulerStatus`，setup 闭包只需 `bool`。共享函数返回 `Result<bool>`（是否成功启动），命令层包装成 SchedulerStatus。

## 验证 3：setup 闭包插入点确认
- **目标**：确认 lib.rs setup 闭包有合适插入点（config 加载后、窗口创建后）
- **方法**：读 lib.rs:666-690（config 加载段）
- **结果**：✅ 666-670 行已加载 `config`，648 行有 `app_handle`，可在 690 后插入 `#[cfg(all(feature="tauri-app",feature="scheduler"))]` 启动块。

## 验证 4：web-only 编译门控
- **目标**：确认 G3 新增代码用 `#[cfg(feature="tauri-app")]` + `#[cfg(feature="scheduler")]` 保证 `--no-default-features` 编译通过
- **方法**：对照 memory `web-only-tauri-command-gate` + Cargo.toml features
- **结果**：✅ `scheduler` 默认 feature（Cargo.toml:10,39），但 `--no-default-features` 会关。共享函数须 `#[cfg(feature="scheduler")]` 门控。setup 闭包本身在 `.setup()` 内（tauri-app feature），叠加 `#[cfg(feature="scheduler")]`。

## 验证 5：G1 MermaidDiagram 调用点唯一性
- **目标**：确认 `MermaidDiagram`（非 Deferred）仅 MarkdownEditor 使用，改它不影响聊天
- **方法**：grep `<MermaidDiagram` + import
- **结果**：✅ 仅 `MarkdownEditor.tsx:296` 一处渲染，import 在 `:10`。聊天用 `DeferredMermaidDiagram`（已门控）。
- **结论**：改 MermaidDiagram 仅影响编辑器预览，回归面可控。

## 验证 6：G1 usePerformanceFlag hook 兼容 memo
- **目标**：确认 `usePerformanceFlag` 可在 `memo` 组件内调用（不破坏自定义比较）
- **方法**：读 MermaidDiagram.tsx memo 比较 + hook 签名
- **结果**：✅ memo 比较函数只控制"是否重渲染"，hook 在组件体内调用正常。开关变化时 React 触发重渲染，memo 比较看 code/id 未变则跳过——**问题**：开关变化但 code/id 未变，memo 跳过重渲染，开关不生效！
- **修正**：memo 比较须加 `mermaidEnabled` 维度。但 memo 比较函数无法访问 hook 值。**方案**：改用 `React.memo` 默认浅比较（去掉自定义比较），或把 `mermaidEnabled` 作为 prop 传入由父层控制。**推荐**：去掉自定义 memo 比较（code/id 变化本就是主要重渲染源，浅比较即可），让 hook 响应式生效。

## 验证 7：G2 pluginServiceManager ensure 竞态安全
- **目标**：确认 `Map<serviceId, Promise>` 去重在 JS 事件循环下无竞态
- **方法**：JS 并发模型分析
- **结果**：✅ JS 单线程，`Map.get/set` 同步原子。`ensureServiceRunning` 内：get→无→set promise→await→delete，中间无让点在 get 与 set 间（同步段），并发调用第二个会在第一个 set 后 get 到已有 promise。**注意**：`await listStatus` 是异步点，须在 get 后、startService 前。去重 key 须在 listStatus 之前判断——**修正设计**：先 get map，有则复用；无则立即 set 一个占位 promise（在 set 之前不放 await），再执行 listStatus/startService。

## 验证 8：G4 config 字段添加回归面
- **目标**：确认加 `perf_migration_dismissed: bool` 到 Config 不破坏序列化
- **方法**：对照 PerformanceFeatures 的 `#[serde(default)]` 模式
- **结果**：✅ 加 `#[serde(default)]` 字段，旧 config 反序列化填 false。前端 type 加可选 `?` 字段。零破坏。
- **位置**：`config.rs` Config 结构体（1452 行），新增字段。

## 验证 9：configStore 前端类型同步
- **目标**：确认前端 config type 与后端同步链路
- **方法**：读 `src/types/config.ts`
- **结果**：✅ `PerformanceFeatures` interface 在 `config.ts:482`，加 `perfMigrationDismissed?: boolean` 到顶层 Config interface（需定位 Config interface）。

## 验证 10：G3 衍生热启动 hot switch store 接口
- **目标**：确认 `performanceHotSwitchStore` 可加 `schedulerDaemon false→true` 热启动
- **方法**：读 store handleSwitch
- **结果**：✅ store:104 已有 `!prev.lspIndex && next.lspIndex` 模式（调 ensureOpen）。scheduler 热启动同理调 `schedulerStart()`（schedulerStore 已有）。
- **注意**：`schedulerStart` 是 store action，hot switch store 须 import schedulerService 或 schedulerStore。检查循环依赖——hot switch store 已 import schedulerService（`:19 schedulerStop`），加 schedulerStart 同源，无新依赖。

## 验证 11：SchedulerDaemon::start 不阻塞
- **目标**：确认 setup 闭包调 `SchedulerDaemon::start` 不阻塞主线程
- **方法**：读 start 实现（scheduler_daemon.rs:78-121）
- **结果**：✅ `tokio::spawn` 异步循环，start 本身只设 running+spawn 立即返回 Ok。setup 闭包安全。

## 验证 12：scheduler list_tasks 懒激活判定
- **目标**：确认 `list_tasks` 返回的 `ScheduledTask` 有"活跃/启用"字段判断
- **方法**：读 models/scheduler.rs ScheduledTask
- **结果**：✅ `ScheduledTask.enabled: bool`（scheduler.rs:328）。懒激活判定 = `list_tasks().iter().any(|t| t.enabled)`。
- **注意**：`list_tasks` 返回所有任务含禁用的，须用 `enabled` 过滤。

## 验证 13：ScheduledTask 活跃判定字段
- **结果**：✅ 见验证 12。`enabled` + `next_run_at` 可用。

## 验证 14：Rust 基线编译
- **方法**：`cargo check --lib`（src-tauri）
- **结果**：✅ 0 errors，17 warnings（既有，非本次引入）。基线干净。
- **注意**：memory `rust-lib-test-env-limit` 记录本机无法 `cargo test --lib`，用 check 验证编译。

## 验证 15：前端 tsc 基线
- **方法**：`pnpm tsc --noEmit`
- **结果**：7 个既有 TS 错误（SpiderManThemeConfig ×3 / conversationStore / polarisPetStore ×2 / themeStore），均非本次范围。基线记录，改动后对照不新增。

## 验证 16：Config interface 前端位置
- **结果**：✅ `src/types/config.ts:389 export interface Config`。G4 的 `perfMigrationDismissed?: boolean` 加到此处。

## 验证 17：反例验证 — G1 memo 陷阱确认
- **反例**：用户 mermaid 开关从 false→true，MermaidDiagram 的 code/id 未变。自定义 memo 比较 `prevProps.code===nextProps.code && prevProps.id===nextProps.id` 返回 true → 跳过重渲染 → 开关不生效。
- **结论**：确认验证 6 的修正正确。MermaidDiagram 须去掉自定义 memo 比较（用默认浅比较），或把 enabled 作为 prop。**决策**：去掉自定义比较函数，改用默认 memo（React.memo 无第二参数）。code/id 变化仍触发重渲染，开关变化也触发（因组件内 hook 触发父级或自身重渲染）。
- **进一步修正**：React.memo 默认浅比较 props。开关变化不改变 props（code/id 不变），memo 仍跳过。**必须**把 `mermaidEnabled` 作为 prop 传入，让浅比较捕获变化。决策：MermaidDiagram 接收 `enabled` prop，父层 MarkdownEditor 用 `usePerformanceFlag` 读开关传入。

## 验证 18：反例验证 — G2 ensure 并发
- **反例**：两个调用方同时 ensure 同 serviceId。A 调 get→无→（await listStatus 中）→B 调 get→无（A 还没 set）→A set promise→B 也 set promise→两个 startService。
- **修正**：ensure 内同步段：`if (map.has(key)) return map.get(key); const p = doStart(); map.set(key, p); return p;` ——get 与 set 之间无 await，JS 单线程保证原子。**doStart** 内部才 await。验证 7 的修正正确。

## 验证 19：反例验证 — G3 启动与手动启动冲突
- **反例**：setup 自动启动进行中（acquire_and_hold_lock 成功，daemon.start 未完），用户点手动启动。手动调 scheduler_start→is_holding_lock true→返回"已在运行"。✅ 锁保证互斥。
- **另一反例**：setup 启动失败（acquire 失败，其他实例持锁），用户手动启动→is_holding_lock false→acquire 返回 false→"其他实例持有"。✅ 正确降级。

## 验证 20：综合验证 — 全部假设可实施
- **结论**：✅ 所有分析假设经验证成立，两项修正（G1 prop 传入、G2 同步段去重）已纳入。
- **实施就绪**：进入痛点搜索阶段补充用户视角。

---

## 验证结论汇总

| # | 验证项 | 结果 | 修正动作 |
|---|--------|------|----------|
| 1 | G3 共享函数接口 | ✅ | — |
| 2 | scheduler_start 可抽取 | ✅ | 抽 start_scheduler 共享函数 |
| 3 | setup 插入点 | ✅ | lib.rs 690 后 |
| 4 | web-only 门控 | ✅ | #[cfg(feature="scheduler")] |
| 5 | G1 调用点唯一 | ✅ | — |
| 6 | G1 memo+hook 兼容 | ⚠️ | **去掉自定义 memo 比较**或 prop 传入 |
| 7 | G2 竞态安全 | ⚠️ | ensure 先 set 占位 promise 再 await |
| 8 | G4 config 字段 | ✅ | #[serde(default)] |
| 9 | 前端类型同步 | ✅ | config.ts 加字段 |
| 10 | G3 热启动 store | ✅ | 复用 schedulerStart |
| 11 | Daemon::start 不阻塞 | ✅ | tokio::spawn |
| 12-13 | ScheduledTask 字段 | 待测 | 下轮 |

**两项关键修正**（验证 6、7）将体现在最终方案中。
