# PerformanceFeatures 生产级闭环 — 20 轮最终验证确定（阶段4）

> 综合 stage1 分析 + stage2 验证 + stage3 痛点，定型最终实施方案。
> 每轮一个确定决策，附精确文件路径、接口、验收点。

---

## 轮次 1：实施总顺序确定
**顺序**：G4 → G1 → G2 → G3 + G3衍生 → 文档同步
**依据**：风险递增、依赖零交叉。每项独立 commit。

## 轮次 2：G4 迁移横幅接口定型
**文件**：
- `src-tauri/src/models/config.rs` Config 结构体加 `#[serde(default)] pub perf_migration_dismissed: bool`，默认值函数加 `perf_migration_dismissed: false`
- `src/types/config.ts:389` Config interface 加 `perfMigrationDismissed?: boolean`
- 新建 `src/components/Settings/PerfMigrationBanner.tsx`
- `src/hooks/useAppInit.ts` 检测条件渲染
**检测逻辑**：`config.performance` 全字段 false（或字段缺失）**且** `!config.perfMigrationDismissed` → 显示横幅。dismiss → `updateConfigPatch({ perfMigrationDismissed: true })`。
**文案**：中性引导（非"升级"），适用新老用户："性能优化：以下资源密集型功能默认关闭以获得最佳体验，按需开启"。按钮"去设置"+"知道了"。

## 轮次 3：G1 MermaidDiagram 门控接口定型
**文件**：`src/components/Chat/MermaidDiagram.tsx` + `src/components/Editor/MarkdownEditor.tsx`
**决策**（验证6修正）：`MermaidDiagram` 接收新 prop `enabled: boolean`，由父层 `MarkdownEditor` 用 `usePerformanceFlag('mermaidDiagrams')` 读取传入。
- `enabled=false`：渲染与 DeferredMermaidDiagram 空状态一致的"点击渲染"占位（代码 + 按钮），点击调 renderDiagram
- `enabled=true`：保持现有自动渲染
**memo 修正**：自定义比较函数加 `enabled` 维度：`prev.enabled===next.enabled && prev.code===next.code && prev.id===next.id`
**不引入循环依赖**：`usePerformanceFlag` 在父层调用，MermaidDiagram 只接 prop。

## 轮次 4：G2 ensureServiceRunning 接口定型
**文件**：`src/services/pluginServiceManager.ts`
**新增方法**：
```ts
private startingPromises = new Map<string, Promise<PluginServiceStatus>>();
async ensureServiceRunning(pluginId, serviceId, contribution, installPath, workspacePath?) {
  const key = `${pluginId}:${serviceId}`;
  const existing = this.startingPromises.get(key);
  if (existing) return existing;
  const statuses = await this.listStatus();
  const running = statuses.find(s => s.pluginId===pluginId && s.serviceId===serviceId && s.running);
  if (running) return running;
  const p = this.startService(pluginId, contribution, installPath, workspacePath)
    .finally(() => { this.startingPromises.delete(key); });
  this.startingPromises.set(key, p);
  return p;
}
```
**验证7修正**：`set` 在 `startService` 调用后、`.finally` 清理。
**注意**：`listStatus` 是异步点，去重 map 须在 listStatus 后、startService 前的同步段设置——上面实现里 `existing` 检查在前，`p` 创建+set 在 startService 调用同一同步段（startService 返回 Promise 但已 set），并发安全。

## 轮次 5：G3 共享函数接口定型
**文件**：`src-tauri/src/commands/scheduler.rs` 抽取
```rust
#[cfg(all(feature = "tauri-app", feature = "scheduler"))]
pub async fn start_scheduler_if_needed(app: &AppHandle) -> Result<bool> {
    if crate::utils::is_holding_lock() { return Ok(true); }
    // 配置门控
    let perf = { /* read config.performance.scheduler_daemon */ };
    if !perf { return Ok(false); }
    // 懒激活：有 enabled 任务才启动
    let config_dir = app.path().app_config_dir()?;
    let repo = UnifiedSchedulerRepository::new(config_dir, None);
    let has_active = repo.list_tasks()?.iter().any(|t| t.enabled);
    if !has_active { return Ok(false); }
    // 锁
    if !crate::utils::acquire_and_hold_lock()? { return Ok(false); }
    let mut daemon = SchedulerDaemon::new(config_dir, None);
    daemon.start(app.clone())?;
    let state = app.state::<AppState>();
    *state.scheduler_daemon.lock().await = Some(daemon);
    Ok(true)
}
```
**scheduler_start 命令重构**：命令体调 `start_scheduler_if_needed` 后包装成 SchedulerStatus（保留现有返回语义，但补"懒激活无任务"提示）。
**注意**：命令层原逻辑是"无条件 acquire"（用户手动启动意图明确），与 setup 的"懒激活"不同。**决策**：命令层保持无条件启动（用户手动=明确意图），setup 闭包用懒激活版本。两路径共享锁逻辑但各自语义。**修正**：不强行合并，setup 直接内联懒激活逻辑，命令层不动。

## 轮次 6：G3 setup 闭包插入定型
**文件**：`src-tauri/src/lib.rs` setup 闭包，config 加载后（~690行后）
```rust
#[cfg(all(feature = "tauri-app", feature = "scheduler"))]
{
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        match commands::scheduler::start_scheduler_if_needed(&app_handle).await {
            Ok(true) => tracing::info!("[Startup] 调度器守护进程已自动启动"),
            Ok(false) => tracing::debug!("[Startup] 调度器未自动启动（开关关闭或无活跃任务）"),
            Err(e) => tracing::warn!("[Startup] 调度器自动启动失败: {}", e),
        }
    });
}
```
**不阻塞**：spawn 异步，失败仅 warn。

## 轮次 7：G3 衍生 热启动定型
**文件**：`src/stores/performanceHotSwitchStore.ts` handleSwitch
```ts
if (!prev.schedulerDaemon && next.schedulerDaemon) {
  log.info('schedulerDaemon 开启，热启动调度器');
  // 懒激活：调 schedulerStart，后端会判断有无活跃任务
  schedulerStart().catch((err) => log.warn('热启动调度器失败', { error: String(err) }));
}
```
**import**：加 `schedulerStart` from `@/services/tauri/schedulerService`（同 schedulerStop 源）。
**注意**：schedulerStart 命令层无条件 acquire，热启动会拉起——但若用户开了开关却无任务，守护进程空转 10s 轮询。**决策**：热启动也走懒激活，改调一个前端封装 `ensureSchedulerRunning()`，先 list_tasks 查有无 enabled 任务才 start。但前端 list_tasks 也要 IPC。**简化决策**：热启动直接 schedulerStart，信任用户开关意图（用户开了=想要守护进程运行），无任务空转开销极低（10s 一次轻查询）。与 G3 setup 的懒激活略不同——setup 是"被动启动"，热切换是"用户主动开启"。可接受。

## 轮次 8：web-only 编译门控定型
- G3 共享函数 `#[cfg(all(feature="tauri-app", feature="scheduler"))]`
- G3 setup 闭包块同上门控
- 命令层 `scheduler_start` 已 `#[cfg(feature="tauri-app")]`，不动
- 验证：`cargo check --lib --no-default-features --features web-server` 须通过（memory `web-only-tauri-command-gate`）

## 轮次 9：i18n 文案定型
- G1 复用 `chat:mermaid.clickToRender` / `viewSourceCode`（已有）
- G4 新增 `settings:performance.migrationBanner.*`（title/body/goSettings/dismiss）
- 加到 `src/i18n/locales/zh-CN/settings.json` + `en-US/settings.json`

## 轮次 10：configStore 持久化链路定型
G4 dismiss：`useConfigStore.updateConfigPatch({ perfMigrationDismissed: true })` → 后端 `update_config_patch` → 写 config.json → emit config-changed。复用现有链路，无新基础设施。

## 轮次 11：G1 回滚点定型
还原 `MermaidDiagram.tsx`（去 enabled prop + 还原 memo）+ `MarkdownEditor.tsx`（去 usePerformanceFlag 传入）。单 commit 可回滚。

## 轮次 12：G2 回滚点定型
还原 `pluginServiceManager.ts`（删 ensureServiceRunning + startingPromises）。调用点未强制迁移，回滚零影响。

## 轮次 13：G3 回滚点定型
还原 lib.rs setup 新增块 + scheduler.rs start_scheduler_if_needed 函数 + hot switch store 新增段。三处但隔离。

## 轮次 14：G4 回滚点定型
还原 config.rs 字段 + config.ts 字段 + PerfMigrationBanner.tsx（删文件）+ useAppInit 检测段。

## 轮次 15：验收矩阵定型
见 stage1 轮次19 + 新增：
- `cargo check --lib` 0 新增 error
- `cargo check --lib --no-default-features --features web-server` 通过
- `pnpm tsc --noEmit` 0 新增 error（基线 7 个既有不计）
- 手测：编辑器 mermaid 开关、插件懒激活、scheduler 自动启动、横幅

## 轮次 16：文档同步定型
- `docs/performance-features-default-off-plan.md` Phase 0-3 勾选项打勾（G1-G4 对应）
- `docs/lightweight-refactor-plan.md` 接线表更新（mermaid 编辑器门控补全）
- 新增 `docs/perf-features-closure-impl.md` 实施记录

## 轮次 17：测试策略定型
- 单元：ensureServiceRunning 去重（mock listStatus/startService）
- 集成：手测为主（本机 cargo test --lib 不可用，见 memory）
- 类型：tsc 把关

## 轮次 18：风险残留确认
- G3 scheduler 自动启动杀软误报风险：已有 tracing + 开关默认关，残留可接受
- G2 ensure 无失败抑制：后端 maxRestarts 兜底，残留可接受
- G4 横幅对老用户首次升级才显示：方案用 dismiss 持久化，残留可接受

## 轮次 19：实施就绪确认
全部接口定型、回滚点清晰、验收矩阵明确。无阻塞项。

## 轮次 20：Go 决策
**进入开发阶段**。按 G4→G1→G2→G3→文档 顺序执行。
