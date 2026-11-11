# Scheduler 域插件化迁移 spec（core-slimdown B1-6）

> 状态：实施中 · 日期：2026-11-11 · 分支：`feat/scheduler-plugin-extraction`（worktree `Polaris-slim-scheduler`）
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §4.1 B1-6（总纲），本文件为该项独立 spec。
> 插件落位：Polaris-plugin 仓 `plugins/ai-scheduler`（v2 定案：插件一律落插件仓）。

---

## 1. 目标与定位

把主仓「AI 定时任务」域（前端 ~4.3k + Rust ~6.7k + 连带 executor 子系统 ~1.1k，合计 **净删 ≥13k 行**）整体外移为插件仓 `ai-scheduler` 插件（MCP stdio + 常驻服务 + 面板三件套）。

**顺带修复两个存量问题**（迁移的行为修复，非行为变更）：
1. **自动触发断链**：`schedulerStore.handleTaskDue` 用裸 `start_chat` 命令（后端 invoke_handler 已摘除）——当前 main 上自动触发的 chat 任务必然失败并反复重试（interval 型无限失败循环）。迁移后触发链后端化走 `cap.ai.chat`（与手动路径同通道），断链消除。
2. **死代码出仓**：`services/scheduler/local_file_storage.rs`（1,122 行）生产路径从不接入（`UnifiedSchedulerRepository` 无条件 sqlite）。

**与 task-runner 的边界**（防功能混淆）：task-runner=轻量定时动作台（notify/http/ai供应商直连/command，无会话语义）；ai-scheduler=AI **会话级**定时任务（宿主引擎执行、协议模式任务书、提示词模板、工作区绑定、after_completion 链式触发）。两者并存，README 声明分工。

## 2. 架构定案（事实依据见 §6）

```
┌─ 插件仓 plugins/ai-scheduler ──────────────────────────────┐
│ mcp/server.js    stdio 7工具（金标=主仓 scheduler_mcp_server.rs）│
│                  任务键 aisched.task.* 直读写 cap.kv          │
│ service/main.js  常驻 http 服务（2s tick，contributes.services）│
│   ├ engine.js   纯函数调度核心：once/cron/interval/after_completion│
│   ├ protocol.js 协议文档 TS 移植（金标=protocol_task.rs 测试）  │
│   ├ executors.js chat=cap.ai.chat(HTTP)；command=spawn；http=fetch│
│   │            plugin 型 v1 不支持（触发时跳过+日志）          │
│   ├ wsclient.js WS 订阅 session_end/error（contextId=scheduler-*）│
│   │            →终态回收→kv 重算 next_run_at；30min 自愈兜底   │
│   └ migrate.js  首启只读导入 <appConfigDir>/stores/scheduler.db │
│                  → kv → 重命名 .migrated（防重复导入）         │
│ dist/panel.js    面板（10 组件搬迁+数据层重写为 cap.kv/命令信箱）│
└──────────────────────────────────────────────────────────────┘
        │ router-dispatch + Bearer md5(token)（kvclient 自发现）
        ▼
┌─ 宿主 ─ cap.kv / cap.ai.chat / WS 事件流 ─ AI 引擎（不动）──┐
└──────────────────────────────────────────────────────────────┘
```

**关键语义对照（现状 → 迁移后）**：

| 现状（前端驱动） | 迁移后（服务驱动） |
|---|---|
| daemon 置 Running + 发 `scheduler-task-due` 事件 | 服务 tick 直接触发（无事件中转） |
| 前端 `handleTaskDue` 构建 prompt（协议/模板/简单三态） | 服务进程构建（protocol.js/engine.js，金标移植） |
| 前端 `start_chat` 裸命令（**已断链**）/ 手动走 cap.ai.chat | 统一走 cap.ai.chat `action:start`（含手动，经命令信箱） |
| 前端 EventRouter 订阅 `scheduler-<id>` → session_end/error → updateRunStatus | 服务 WS 订阅同事件同过滤 → kv 状态回收 |
| Running 30min 自愈重置 Failed | 同语义保留（STALE_RUNNING_SECS=1800） |
| contextId=`scheduler-<id>`，会话呈现在宿主 Chat | **不变**（会话域基础设施保留） |
| 47 个 Tauri/HTTP 命令 + sqlite 直连 | MCP 7 工具（AI 面）+ cap.kv（面板面）+ 命令信箱（手动执行） |

**执行时序图（chat 任务）**：

```
service tick ─→ engine.dueTasks ─→ protocol/engine 构建 prompt
    │                                    │
    │                    POST /api/router-dispatch (cap.ai.chat, action:start,
    │                                    │  contextId='scheduler-<id>', engineId, workDir)
    │                                    ▼
    ├─ kv: state.<id> = Running ──→ 宿主 AI 引擎跑会话（AIEvent 流照常广播）
    │                                    │
    ▼                                    ▼
wsclient ←──────── WS session_end / error（contextId 匹配）──────────┘
    │
    └─ kv: state.<id> = Success|Failed；hist 追加；after_completion → now+interval 重算
兜底：Running 超 timeout_minutes(默认30min) → 重置 Failed 允许重触发
```

## 3. 存储与单写者

键空间 `aisched.*`（cap.kv，读写分离=每键空间一个所有者）：
- `aisched.task.<id>` — 任务定义（所有者：MCP server + 面板，CRUD 直写）
- `aisched.state.<id>` — 运行态 lastRunAt/status/nextRunAt/runCount（**服务单写**，面板/MCP 只读）
- `aisched.hist.<n>` — 执行历史分块（**服务单写**，25 条/块+索引键，照 task-runner）
- `aisched.meta` — 服务心跳（服务单写）
- `aisched.cmd.run.<nonce>` / `aisched.result.<nonce>` — 手动执行命令信箱（先删后做幂等，照 task-runner）
- `aisched.settings` — 服务设置（面板写，30s 热更）

冲突边界：MCP/面板写任务定义时若该任务 Running，服务下 tick 读到新定义自然生效（与现状 update_task 语义一致）；运行态永不与任务定义混键。

**数据迁移**：服务首启（`aisched.settings.migrated` 无值时）：
1. 只读打开 `<appConfigDir>/stores/scheduler.db`（node:sqlite readonly，不锁不写）；
2. 逐任务导入为 `aisched.task.<id>` + `aisched.state.<id>`（原 next_run_at/last_run_status 保真）；
3. 成功后重命名为 `scheduler.db.migrated`（防重复导入）；打开失败（不存在/无 sqlite）→ 记 `migrated: none` 跳过。
4. plugin 型执行器任务导入后标 `unsupportedExecutor: true`，触发时跳过并记日志（面板可见）。

## 4. 主仓删除清单（worktree 内，commit 序列）

### Rust（`src-tauri/src/`）
| 目标 | 行数 | 说明 |
|---|---|---|
| `services/scheduler/`（6 文件） | 3,229 | 含 local_file_storage 1,122 死代码 |
| `services/scheduler_daemon.rs` | 550 | |
| `services/scheduler_mcp_server.rs` | 450 | 金标已抄入插件 |
| `services/unified_scheduler_repository.rs` | 364 | |
| `models/scheduler.rs` | 1,040 | 协议类型随域走（插件侧 TS 定义） |
| `commands/scheduler.rs` | 1,055 | 47 命令全删 |
| `services/executor/` | 925 | 唯一消费者=scheduler 域（§6-4） |
| `commands/executor.rs` | ~105 | executor_list/execute 命令 |
| `web/api/ipc.rs` scheduler+executor 分支 | ~900 | dispatch_scheduler_* 12 处 + executor 桥 |
| `lib.rs` 启动/健康监控/注册 | ~200 | 桌面懒激活+web 无条件启动+47 注册行 |
| `state.rs` daemon 槽位+executor_registry | ~40 | |
| `mcp_config_service.rs` scheduler 条目 | ~40 | builtin registry 4→3、SCHEDULER 常量、subcommand 分支 |
| `bin/polaris_mcp.rs` scheduler 子命令 | ~10 | |
| `models/config.rs` scheduler_daemon | ~10 | 性能开关随域走 |
| `models/plugin.rs` executors 引用 | ~20 | PluginExecutor 注册机制 |
| `tests/scheduler_integration_test.rs` | ~14 tests | 删（等价断言进插件仓） |

### 前端（`src/`）
| 目标 | 行数 | 说明 |
|---|---|---|
| `components/Scheduler/`（13 文件） | 4,906 | 含 3 个组件测试 |
| `stores/schedulerStore.ts` | 840 | 触发逻辑由服务接管；`schedulerStoreUtils.ts` **保留**（dispatchTaskService 用） |
| `services/tauri/schedulerService.ts` | 401 | |
| `services/executorService.ts` | ~60 | 仅 TaskEditor 使用 |
| `types/scheduler.ts` | 660 | 纯函数随迁插件 |
| `plugins/scheduler/manifest.ts` + builtinPlugins 注册 | ~90 | 摘壳 |
| `hooks/useAppEvents.ts` task-due 块 | ~20 | |
| `configStore.ts` 热切换 + `performanceFeatures` + PerformanceTab 开关 | ~60 | |
| `ToolSwitcher` 'scheduler' 引用 + toolSwitcherData | ~5 | panelType 改 ai-scheduler（插件贡献自动注册） |
| `viewStore` schedulerLogDrawerHeight | ~3 | 随面板走 |
| i18n scheduler 命名空间（zh-CN/en-US） | ~200 | 面板内置文案 |
| `errorMapping` scheduler.errors.* | ~22 | |
| `types/executionConsole.ts`/store 'scheduler' origin | ~10 | 观测源随域走 |

**保留不动**（边界）：`schedulerStoreUtils.ts`（parseEventToLog→dispatchTaskService）、`eventRouter`/`sessionStoreManager` 的 `scheduler-` 前缀路由（迁后服务启动的会话仍用该 contextId）、`cap.prompt_snippet`、`types/promptSnippet.ts`（实施时按引用面定去留）、dispatch 域。

## 5. 验收（目标测试）

### 插件仓（合并前置）
- [ ] `npm test`（test/run-tests.mjs）：调度核心断言 ≥40 全绿——**金标**：cron/interval/once/after_completion 的 next_run_at 计算用例从 Rust `sqlite_task_storage.rs`/`unified_scheduler_repository.rs` 测试翻译；协议文档生成/extract_user_content 从 `protocol_task.rs` 测试翻译
- [ ] MCP 离线测试：7 工具 × 内存 kv stub（create/list/get/update/delete/toggle/breakdown）
- [ ] SSR 渲染验证通过（面板无 Invalid hook call）
- [ ] `smoke-real.mjs` 真桥全链路：宿主在线时 MCP initialize→tools/list→create_task→服务触发→WS 终态回收→hist 落键→清理（宿主离线明确跳过）
- [ ] esbuild 面板 bundle 成功、zip 打包成功

### 主仓（worktree 合并前置）
- [ ] `pnpm typecheck` 全绿
- [ ] `pnpm lint` 无新增 error
- [ ] `cargo check` 全绿
- [ ] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿（命令门控双方向）
- [ ] `pnpm test:run` 受影响套件全绿（scheduler.* 3 文件删除、case-5/mcp.test/pluginStore/ToolSwitcher/configDispatchService/turnFilter 改写后全绿）
- [ ] 行数对账：净删除 ≥13k（±20%），无半拆残留（孤儿组件/死 manifest/死 i18n key/死命令注册）
- [ ] `AGENTS.md` §五 MCP/bin 清单同步（polaris-mcp scheduler 子命令摘除）

### 功能等价回归清单（真宿主手动冒烟项，写入插件 README）
1. AI 经 MCP create_task 建任务 → 面板可见
2. once 任务到点触发 → cap.ai.chat 会话启动（contextId=scheduler-<id>）→ 会话出现在宿主 → 终态回收 Success
3. 协议模式任务触发 → prompt 含协议文档+补充+记忆（与主仓 build_protocol_prompt 输出对照）
4. after_completion 链式重算
5. 手动执行（面板按钮）→ 命令信箱 → 服务执行
6. 旧 scheduler.db 数据导入
7. 桌面 + Web 双模式服务/面板可用

## 6. 关键事实依据（已核实，防返工）

1. **断链**：`schedulerStore.ts:492` `transportInvoke('start_chat')`；lib.rs:1102 invoke_handler 无 start_chat；transport/index.ts:280 仅 git_* 转 router_dispatch 无 fallback；ipc.rs 无 start_chat 分支（默认 404）。手动路径 `aiChatDispatch→router_dispatch→cap.ai.chat→start_chat_inner` 两端可达。
2. **cap.ai.chat dispatch**（ai_chat_capability.rs:307/836）：`start_chat_inner(...).await → Ok(json!(sid))`，经 router-dispatch HTTP 可触发；AI 事件经 EventBroadcaster→WS 广播（httpTransport listen 按 event 分发）——服务进程 WS 订阅终态通道成立。
3. **MCP 注册**：`builtin_mcp_contribution_registry()` 4 条含 polaris.scheduler（trusted builtin），真实 spawn=polaris-mcp bin 子命令 `scheduler`；manifest 前端声明仅契约对齐。摘除点：mcp_config_service.rs:157-165 + server_name_to_subcommand:938-959 + bin/polaris_mcp.rs:62-64。
4. **executor 子系统唯一消费者**：registry.execute 调用方=scheduler_daemon:436 + commands/executor.rs:25（executor_execute，前端零调用）+ ipc.rs:3049 桥；前端仅 TaskEditor 用 executor_list。→ 整链删除。
5. **存储**：`UnifiedSchedulerRepository::new` 无条件 SqliteTaskStorage（失败 panic!），scheduler.db=`<config_dir>/stores/scheduler.db`，config_dir=data_root().config_dir()。legacy_storage_migrate 明确不触碰 scheduler.db（迁移护栏照旧）。
6. **插件仓配方**：kvclient.js（router-dispatch+md5(token)+anchor 自发现）为服务进程调宿主成熟通道；MCP 零依赖换行 JSON-RPC（task-runner/server.js 94 行模板）；历史插件 `polaris-scheduler`（git 80eadbc，2026-08）为无状态透传版已删——本方案为真外移（主仓删码）。
7. **cron 语义**：自写解析移植时以主仓 next_run_at 计算代码+Rust 测试用例为金标，逐用例翻译断言。

## 7. 风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| WS 终态订阅失效 → AfterCompletion 卡 Running | 中 | 30min 自愈兜底（现状同款）+ 服务日志落盘 + smoke-real 断言终态回收 |
| 协议/模板 TS 移植行为漂移 | 中 | Rust 测试用例逐条翻译为 node:test 金标断言（§5） |
| 数据迁移丢任务 | 中 | 只读打开+重命名护栏+导入计数日志+面板可见 |
| plugin 型执行器任务失效 | 低 | v1 明确不支持（README+触发日志+面板标记）；存量导入不丢数据 |
| 双写者（MCP 直写任务键 vs 服务运行态） | 低 | 键空间读写分离（§3），服务对任务键只读 |
| 旧 12 内置壳摘除影响 plugin-system 契约测试 | 低 | mcp.test fixture/pluginStore 断言随摘除改写 |

---

## 8. 实施与验收记录（2026-11-11 回填）

### 主仓（commit a755f3fb）
- 净删 **17,907 行**（73 文件，+104/-18011），超出 spec §4 预估（~13k，executor 子系统连带 + ipc.rs 78 臂全删 + 巨型 local_file_storage 死代码）
- 门禁全绿：`cargo check` 0 错 / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` Finished / `tsc --noEmit` 0 错 / `eslint` 0 error / 受影响 vitest 套件（mcp 3+pluginStore 26+configDispatch·turnFilter 10+case-5 17+dispatchTask 12）全绿
- spec §4 外发现：snippet 五函数是独立功能（cap.prompt_snippet，ChatInput/Settings 消费）——救出至 `snippetService.ts` 随宿主保留

### 插件仓（commit c22ad8e + 8656dda）
- `plugins/ai-scheduler` v1.0.0：MCP 七工具 + 常驻服务 + 面板三件套；测试四层（金标对拍 46 / MCP 18 / SSR 渲染 / 构建）全绿
- 真桥冒烟抓出三 bug（离线单测全绿但组合语义错，全部已修）：
  1. tick 用 `listTasks`（纯定义）判 isDue → 永假；改 `listTaskViews`（合并视图）
  2. markRunning 后 30s 任务缓存未失效 → once 任务每 tick 重复触发；触发后立即失效
  3. wsclient 按扁平形状解析 chat-event → AIEvent 实为嵌套 `{contextId, payload: AIEvent}`，session_end 永远收不到；改嵌套解析
- **E2E 闭环验证**：建 12s 到期 once 任务 → tick 触发 → cap.ai.chat 会话启动 → WS session_end → 终态回收 `success (reason=completed)` → 历史落账，全程 18s
- 数据迁移真桥验证：从主仓 scheduler.db 只读导入 1 条用户存量任务（数学世纪难题验证，after_completion 型），保真成功

### 发布记录（2026-11-11 回填）
- 插件仓 commit `ab056ec`：`index.json` 新增 ai-scheduler 条目（共 132 插件）、`ai-scheduler.zip` 入库、tag `ai-scheduler-v1.0.0`；`git push origin main` 与 `git push origin ai-scheduler-v1.0.0` 均成功。
- 发布前修掉三处偏差：① `plugins/ai-scheduler/.gitignore` 放行 `ai-scheduler.zip`（原 `*.zip` 规则会让 tag 内无包，CDN downloadUrl 必然 404）；② `plugin.json` / `update.json` 的 `origin.updateUrl` 由误指 `plugin.json` 改指 `update.json`、`origin.downloadUrl` 由 `@main` 改为 `@ai-scheduler-v1.0.0`（对齐 PUBLISHING.md 的 tag 钉住策略）；③ 分发包重打（18 文件 / 66970 B / sha256 `705ecfebceab4c1d8c7979026183a69c04ad9a2a9e352669dda111712f72fbcf`）并回填 `index.json`。
- `node scripts/validate.js` 通过（132 插件）；zip 内 18 文件结构与修正后的 manifest 已核对。
- 环境备注：`scripts/publish-plugin.mjs` 在本机被文件删除保护拦截（脚本内 `rmSync` 清理临时目录/旧 zip 时超时），分发包改用 PowerShell `Compress-Archive` 生成、sha256 手工回填；**发布流程与脚本本身未改动**，换到无该保护的机器仍可走脚本一条龙。

### 遗留（下一轮）
- CDN 生效后做一次 `curl -sL <tag zip> | sha256sum` 与 index.json 比对（jsDelivr 首次拉取有传播延迟）。
- plugin 型执行器 v1 不支持（README 声明 + 面板标记 + 触发跳过）
