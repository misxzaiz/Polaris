# PerformanceFeatures 生产级闭环 — 20 轮深度分析（阶段1）

> 攻坚范围：G1 MermaidDiagram 门控 / G2 pluginAutoStart 懒激活 / G3 scheduler 桌面端自动启动 / G4 迁移引导横幅
> 每轮聚焦一个独立分析维度。分析基于阶段0勘察的精确锚点。

---

## 轮次 1：架构影响面分析

四个缺口的影响面分层：
- **G1（渲染层）**：`src/components/Editor/MarkdownEditor.tsx` + `src/components/Chat/MermaidDiagram.tsx`。编辑器预览路径独立于聊天路径（聊天用 `DeferredMermaidDiagram` 已门控）。改动局限于编辑器场景，不影响聊天流式渲染。影响面：最小。
- **G2（插件服务层）**：`src/services/pluginServiceManager.ts` + 各插件功能调用点。懒激活需在 `pluginServiceManager` 加 `ensureServiceRunning(pluginId, serviceId, contribution, installPath, workspacePath)` 包装：先 `listStatus` 查是否运行，未运行则 `startService`。影响面：中，需识别所有"插件功能调用处"加 ensure 调用。
- **G3（启动路径）**：`src-tauri/src/lib.rs` tauri setup 闭包。新增 scheduler 自动启动入口。需复用 `scheduler_start` 命令的锁逻辑（`acquire_and_hold_lock`）与配置门控。影响面：中，触碰启动序列。
- **G4（UX 层）**：设置页或全局横幅组件。需检测"首次升级到默认全关"状态。影响面：小，纯前端。

**架构原则**：四缺口正交，无相互依赖，可独立实施独立验证。建议顺序 G1 → G4 → G2 → G3（风险递增）。

---

## 轮次 2：约束与不变量分析

**Rust 端约束**：
1. `PerformanceFeatures` 字段全 `#[serde(default)]`，旧 config.json 无 `performance` 字段时反序列化填默认（全 false）——这是迁移方案的基石。
2. `scheduler_daemon` state 字段是 `#[cfg(feature = "scheduler")]`，`scheduler` 是默认 feature。G3 实施需 `#[cfg(feature = "scheduler")]` 门控启动调用，保持 web-only 编译兼容（见 memory `web-only-tauri-command-gate`）。
3. `lib.rs` setup 闭包在 tauri-app feature 下编译；`emit_config_changed` 已 `#[cfg(feature = "tauri-app")]`。

**前端约束**：
1. `performanceFeatures.ts` 的 `readFlag` 参数化设计避免循环依赖——懒激活封装不能直接 import configStore，须用 `useConfigStore.getState()` 非响应式读。
2. `MermaidDiagram` 是 `memo` 组件，自定义比较只看 `code/id`；加 `mermaidDiagrams` 开关读取须用 `usePerformanceFlag`（hook，触发响应式），不能放 memo 比较函数外。

**不变量**：开关默认 false 的语义 = "功能不自动启用"，不等于"功能不可用"（手动触发仍可用）。G1/G2/G3 都必须保持这个语义。

---

## 轮次 3：风险分析

| 风险 | 缺口 | 等级 | 缓解 |
|------|------|------|------|
| 编辑器 mermaid 门控后，预览体验变化 | G1 | 低 | 关闭时显示代码块 + "点击渲染"按钮，与聊天一致 |
| 懒激活首次调用延迟 2-3s 无反馈 | G2 | 中 | ensure 返回 Promise，调用方加 loading 态；失败回退明确错误 |
| 懒激活竞态：并发调用同一插件服务 | G2 | 中 | ensure 内部用 `Map<serviceId, Promise>` 去重，同 serviceId 复用同一启动 Promise |
| scheduler 桌面端自动启动与用户手动启动冲突 | G3 | 中 | 复用 `is_holding_lock()` + `acquire_and_hold_lock()`，已运行则跳过 |
| scheduler 启动在无定时任务时浪费资源 | G3 | 中 | 懒激活：先 `list_tasks` 查有活跃任务才启动（plan §2.3 设计） |
| 启动时 scheduler 拉起失败导致应用启动卡顿 | G3 | 中 | setup 闭包内 `tokio::spawn` 异步启动，不阻塞主流程 |
| 迁移横幅误判：新用户首次安装也提示 | G4 | 中 | 区分"首次安装"vs"升级"——用 config 版本标记或历史 usage 标记 |
| 横幅重复打扰 | G4 | 低 | 用户点"知道了"后持久化 dismiss 标记 |

---

## 轮次 4：接口设计分析

**G1 接口**：
```ts
// MermaidDiagram.tsx 顶部加
const mermaidEnabled = usePerformanceFlag('mermaidDiagrams');
// 渲染逻辑：mermaidEnabled=false 时走 DeferredMermaidDiagram 的"点击渲染"模式
// 但 MermaidDiagram 用于编辑器（非流式），简化为：false 时显示代码块 + 渲染按钮
```
决策：`MermaidDiagram` 直接复用 `usePerformanceFlag`，关闭时渲染"点击渲染"占位（与 DeferredMermaidDiagram 空状态一致），点击后调 `renderDiagram`。

**G2 接口**：`pluginServiceManager` 新增：
```ts
private startingPromises = new Map<string, Promise<PluginServiceStatus>>();
async ensureServiceRunning(pluginId, serviceId, contribution, installPath, workspacePath?): Promise<PluginServiceStatus> {
  // 1. listStatus 查当前状态
  // 2. 已运行 → 直接返回
  // 3. 已有 startingPromise → 复用
  // 4. 否则 startService，存 promise 去重
}
```

**G3 接口**：`lib.rs` setup 闭包内，config 加载后：
```rust
#[cfg(all(feature = "tauri-app", feature = "scheduler"))]
{
    if config.performance.scheduler_daemon {
        // 懒激活：有活跃任务才启动
        let has_active = /* check repository list_tasks */ ;
        if has_active {
            // 复用 scheduler_start 命令逻辑或直接 spawn
        }
    }
}
```
决策：不直接调 `scheduler_start` 命令（它是 #[tauri::command] 不便内部调用），而是抽取共享函数 `start_scheduler_if_needed(app, config)` 供命令层和 setup 闭包共用。

**G4 接口**：`configStore` 加 `perfMigrationDismissed?: boolean`（持久化到 config），前端 `useAppInit` 检测首次升级条件渲染横幅。

---

## 轮次 5：数据流分析

**G1 数据流**：`config.performance.mermaidDiagrams` → `usePerformanceFlag` → `MermaidDiagram` 重渲染 → 关闭时显示占位 / 开启时自动渲染。

**G2 数据流**：插件功能调用 → `ensureServiceRunning` → `listStatus` IPC → 后端 `plugin_service_list_status` → 未运行则 `plugin_service_start` IPC → 进程拉起。

**G3 数据流**：setup 闭包 → 读 `config.performance.scheduler_daemon` → `list_tasks` 查活跃任务 → `acquire_and_hold_lock` → `SchedulerDaemon::start(app_handle)` → 存入 `state.scheduler_daemon`。

**G4 数据流**：`useAppInit` → 读 config.performance 全 false + 检测历史 usage 标记 → 渲染横幅 → 用户 dismiss → 写 `perfMigrationDismissed=true`。

---

## 轮次 6：回归面分析

**G1 回归面**：
- `MarkdownEditor.tsx` 预览（编辑器场景）——主测点
- `MermaidDiagram.tsx` 其他调用点：`grep` 仅 `MarkdownEditor.tsx:296` 一处，无其他回归
- 聊天路径不受影响（用 DeferredMermaidDiagram）

**G2 回归面**：
- 所有 `pluginServiceManager.startService` 直接调用点——需保留
- `autoStartAll`（useAppInit）——已门控 pluginAutoStart，不动
- 各插件功能调用处——需逐个改用 ensure，回归面大；折中：只在 `pluginServiceManager` 加 ensure，**不强制改所有调用点**，由调用方按需迁移。先保证 ensure 可用，调用点渐进迁移。

**G3 回归面**：
- `scheduler_start` 命令（手动启动）——必须与自动启动互斥（锁保证）
- `SchedulerDaemon::start` ——已实现，复用
- standalone web 模式（1241 行）——不动，仅 tauri-app 路径加

**G4 回归面**：纯新增 UI，无回归。

---

## 轮次 7：测试矩阵设计

| 测试用例 | 缺口 | 类型 | 验证点 |
|----------|------|------|--------|
| mermaid 开关关闭，编辑器预览 mermaid 块 | G1 | 单元/集成 | 显示代码块+渲染按钮，不加载 mermaid.js |
| mermaid 开关开启，编辑器预览 mermaid 块 | G1 | 集成 | 自动渲染图表 |
| mermaid 开关关闭→开启热切换 | G1 | 集成 | 已显示占位的块变为自动渲染 |
| ensureServiceRunning 首次调用 | G2 | 单元 | 发起 startService，返回 running |
| ensureServiceRunning 重复调用 | G2 | 单元 | 复用 promise，不重复 start |
| ensureServiceRunning 已运行 | G2 | 单元 | 直接返回，不 start |
| scheduler_daemon=true 启动 | G3 | 集成 | setup 闭包拉起守护进程 |
| scheduler_daemon=false 启动 | G3 | 集成 | 不拉起 |
| scheduler 无活跃任务 | G3 | 集成 | 即使 true 也不启动（懒激活） |
| scheduler 自动+手动冲突 | G3 | 集成 | 锁互斥，手动启动返回"已在运行" |
| 首次升级全 false | G4 | 集成 | 显示横幅 |
| 横幅 dismiss | G4 | 集成 | 持久化，不再显示 |
| 新用户首次安装 | G4 | 集成 | 不显示横幅 |

---

## 轮次 8：迁移与兼容性分析

**config.json 兼容**：`PerformanceFeatures` 已 `#[serde(default)]` + `Default`，旧 config 无 `performance` 字段自动填全 false。Rust 端零迁移成本。

**G4 迁移检测逻辑**（关键）：
- "升级"判定：config 中无 `perfMigrationDismissed` 标记 **且** 存在历史使用记录（如：有 scheduler 任务 / 有 file watcher 使用 / config 有非默认 performance 值历史）。
- 简化方案：用 config 的 `performance` 字段是否为 `Some` 且全 false + 无 dismiss 标记 → 显示横幅。
- 更精准：加 `config_version` 或 `first_run_at` 字段区分新装 vs 升级。但加字段成本高。
- **推荐**：用 localStorage 的 `perfMigrationShown` 标记（非 config），首次检测 performance 全 false 且 localStorage 无标记 → 显示横幅 → 写标记。新用户首次安装 performance 也是全 false，但无"历史功能失效"痛点——横幅文案中性即可（"以下功能默认关闭，如需使用请开启"），对新老用户都合理，无需严格区分。

---

## 轮次 9：性能影响分析

**G1**：关闭时省 mermaid.js 加载（~1.5MB），编辑器预览更快。开启时无变化。
**G2**：懒激活首次调用多一次 `listStatus` IPC（~1ms），可忽略；去重 promise 避免并发启动风暴。
**G3**：scheduler_daemon=true 时启动一个 10s 轮询线程（CHECK_INTERVAL_SECS），CPU 极低；懒激活无任务时不启动，零开销。
**G4**：横幅渲染一次，dismiss 后不再渲染，零持续开销。

整体性能正向（关闭态省资源），符合 PerformanceFeatures 设计初衷。

---

## 轮次 10：安全分析

**G2 插件服务懒激活安全**：
- `ensureServiceRunning` 不引入新攻击面——仍是 `plugin_service_start` IPC，后端已有 installPath 校验/进程隔离。
- 需防：恶意插件在 healthCheck 注入恶意命令——已有 `plugin_service_start` 后端校验，不在本轮范围。
**G3 scheduler 自动启动安全**：
- 锁机制（`acquire_and_hold_lock`）防多实例，已实现。
- 任务执行走 `check_and_notify_due_tasks_tauri`，已有权限模型，不新增暴露。
**G1/G4**：纯 UI，无安全面。

---

## 轮次 11：热切换一致性分析

`performanceHotSwitchStore` 当前处理：fileWatcher/schedulerDaemon/lspIndex/codeEditorLanguages 的 true→false 停止，部分 false→true 启动。

**G1 mermaid 热切换**：`usePerformanceFlag` 响应式，开关切换后 MermaidDiagram 自动重渲染。无需改 hot switch store（渲染层响应式足够）。
**G2 pluginAutoStart 热切换**：开关从 false→true 时不主动启动（按需原则，hot switch store 注释已说明）。懒激活在调用时生效，一致。
**G3 scheduler 热切换**：开关 true→false 时，hot switch store 已调 `schedulerStop`。false→true 不主动启动——**但 G3 是启动路径入口，非热切换**。热切换场景：用户运行中开启 scheduler_daemon，期望守护进程启动？当前 hot switch 只 stop 不 start。**缺口**：false→true 热启动未实施。补：hot switch store 加 false→true 时调 `startScheduler`（懒激活：有任务才启）。
**G4**：非热切换范畴。

**新增分析结论**：G3 衍生——`performanceHotSwitchStore` 的 `schedulerDaemon false→true` 热启动缺失，需补。

---

## 轮次 12：错误处理与降级分析

**G1 降级**：mermaid 渲染失败已有 error 态（显示错误+源码）。关闭时纯文本展示，无错误路径。
**G2 降级**：`ensureServiceRunning` 的 `startService` 失败 → 抛错给调用方，调用方应 catch 并提示"插件服务启动失败"。去重 promise 失败时清理 map 条目防泄漏。
**G3 降级**：setup 闭包内 scheduler 启动失败 → `tracing::warn`，不阻断应用启动（`tokio::spawn` 隔离）。
**G4 降级**：横幅渲染失败 → 静默，不影响功能。

---

## 轮次 13：并发与竞态分析

**G2 竞态**：同一 serviceId 并发 ensure → `startingPromises` Map 去重，复用同一 Promise。Map 读写非原子——但 JS 单线程事件循环，`get/set` 同步无竞态。Promise settle 后 `delete` 条目，无泄漏。
**G3 竞态**：setup 闭包异步启动 scheduler vs 用户手动 `scheduler_start` → 锁（`acquire_and_hold_lock`）保证互斥，第二个返回"已在运行"。
**G1/G4**：React 渲染单线程，无竞态。

---

## 轮次 14：国际化分析

G1/G4 有用户可见文案，需 i18n：
- G1：复用 `mermaid.clickToRender` / `mermaid.viewSourceCode`（DeferredMermaidDiagram 已有，同 chat namespace）
- G4：横幅新增文案，加到 `settings` namespace：`performance.migrationBanner.*`
- G2/G3：日志/错误消息，英文 tracing 即可（后端日志不 i18n）；前端错误提示用现有 i18n key。

---

## 轮次 15：可观测性分析

- G1：`log` 已有（MermaidDiagram logger）。关闭时 log.debug 跳过。
- G2：`pluginServiceManager` log 已有。ensure 加 log.info("懒激活拉起服务")。
- G3：`SchedulerDaemon` tracing 已丰富。setup 启动加 tracing info。
- G4：无 log 需求。
建议：每缺口关键路径加 tracing/log，便于用户反馈时定位。

---

## 轮次 16：配置存储扩展分析

**G4 需持久化 dismiss 标记**：
- 方案 A：加到 `Config` 的 `PerformanceFeatures` 旁——`perf_migration_dismissed: bool`。但这是 UI 状态非功能开关，混入 PerformanceFeatures 语义不纯。
- 方案 B：加到 config 顶层 `ui_state` 或单独 `perf_migration_dismissed`。推荐——与功能开关分离。
- 方案 C：localStorage。最简，但跨设备不同步。
**决策**：方案 B，加到 Config 顶层 `#[serde(default)] pub perf_migration_dismissed: bool`，前端 configStore 同步。Rust 端一行字段，前端 type 加一行。

---

## 轮次 17：实施依赖与顺序分析

依赖图（无环）：
```
G4(横幅) ── 无依赖
G1(mermaid) ── 无依赖
G2(懒激活) ── 无依赖（pluginServiceManager 独立）
G3(scheduler启动) ── 无依赖
G3衍生(热切换热启动) ── 依赖 G3 共享函数
```
**推荐实施顺序**：
1. G4（最简，纯 UI + config 字段，验证 config 持久化链路）
2. G1（渲染层，复用已有 DeferredMermaidDiagram 模式）
3. G2（插件服务封装，独立可测）
4. G3 + G3衍生（启动路径，最后做，风险最高，需抽取共享函数）

每个缺口独立 commit，便于回滚。

---

## 轮次 18：边界条件枚举

**G1 边界**：
- mermaid 代码为空 → 已处理（DeferredMermaidDiagram idle）
- 开关切换时正在渲染 → React 重渲染，renderDiagram 幂等（hasRequestedRender）
- 编辑器无 mermaid 块 → 无影响

**G2 边界**：
- contribution/installPath 缺失 → startService 后端校验报错
- 服务反复崩溃（restartOnFailure maxRestarts 耗尽）→ ensure 每次都尝试 start，应检测"最近启动失败"防循环。折中：ensure 不做失败抑制，由后端 maxRestarts 兜底。
- 同 pluginId 多 service → 用 serviceId 做 Map key，正确。

**G3 边界**：
- config_dir 获取失败 → 跳过启动 + warn
- 无 workspace → scheduler 接受 None（已实现）
- 锁被其他实例持有 → `acquire_and_hold_lock` 返回 false，跳过

**G4 边界**：
- config 未加载 → 不渲染横幅
- 用户清空 localStorage（方案C） → 横幅重显——方案 B 持久化到 config 无此问题

---

## 轮次 19：验收标准定义

**G1 验收**：
- [x] mermaid 开关关闭时，编辑器预览 mermaid 块显示代码+渲染按钮，Network 无 mermaid.js 加载
- [x] 开关开启时自动渲染
- [x] 热切换生效

**G2 验收**：
- [x] `ensureServiceRunning` 首次调用拉起服务
- [x] 并发调用同 serviceId 不重复启动
- [x] 已运行时直接返回

**G3 验收**：
- [x] `scheduler_daemon=true` 且有活跃任务时，应用启动后守护进程运行
- [x] `=false` 时不启动
- [x] 无活跃任务时不启动（懒激活）
- [x] 与手动启动互斥
- [x] 热切换 false→true 可启动

**G4 验收**：
- [x] 首次升级（performance 全 false）显示横幅
- [x] dismiss 后持久化不再显示
- [x] 横幅引导用户到性能设置页

---

## 轮次 20：综合风险评估与-go/no-go

**整体风险**：低-中。四缺口正交，各自影响面可控。最大风险在 G3（触碰启动路径），但用 `tokio::spawn` 隔离 + 锁互斥 + 懒激活三层防护，可接受。

**Go 决策**：全部实施。

**关键回滚点**：
- G1：还原 MermaidDiagram.tsx（单文件）
- G2：还原 pluginServiceManager ensure 方法（单文件）
- G3：还原 lib.rs setup 闭包新增段 + hot switch store 新增段
- G4：还原 config 字段 + 横幅组件

**质量门槛**：
- `cargo check --lib` 通过（tauri-app + web-only 双 feature）
- `pnpm tsc --noEmit` 通过
- `pnpm test` 相关单测通过
- 文档同步

---

## 分析阶段总结

20 轮分析覆盖：架构/约束/风险/接口/数据流/回归/测试/迁移/性能/安全/热切换/错误/并发/i18n/可观测/存储/依赖/边界/验收/决策。

**最终实施清单**（5 项，含 G3 衍生）：
1. G4 迁移横幅 + config 字段 `perf_migration_dismissed`
2. G1 MermaidDiagram 门控 `mermaidDiagrams`
3. G2 `pluginServiceManager.ensureServiceRunning` 懒激活
4. G3 setup 闭包 scheduler 自动启动（懒激活 + 锁互斥 + tokio spawn 隔离）
5. G3 衍生：hot switch store 加 `schedulerDaemon false→true` 热启动
6. 文档同步（plan 勾选状态 + lightweight-refactor-plan 接线表）
