# Spec：存储归一化 v1（收敛范围版）

> 状态：**已实施**（2026-10-22，投票定案 2:1 甲胜出后直接实施）
> 日期：2026-10-22
> 实施记录：F1/F2/F3/F4/F5 全部落地。新增 `services/legacy_storage_migrate.rs`（迁移 7 测试 + 明细）；Rust 侧单测（compact ×4、legacy_migrate ×7）本机 `cargo test --lib` 不可用，进 CI 执行。验证：cargo check ✅ / --no-default-features web+mcp ✅ / build polaris-mcp ✅ / clippy 新增 0 / tsc ✅ / lint 0 error / 相关 vitest ✅（src/services 3 个失败文件经 HEAD 基线对照确属存量失败，与本实施无关）。
> 所有者：**TBD（待指派）** —— 刍议候选：负责 commands/router 的后端同伴
> 审查记录：事实核对员证实骨架、揪出迁移无路径（scan_legacy 不含 stores/）、config 五个未收编直写旁路、plugin_state 后端消费面；红队反转 P3 权威定夺、重写迁移语义、砍 46-key 迁移；挑战者砍 P2/P3 立项并产锚「不动清单」；终审以本机实存反例补 4 处漏洞（见「终审补丁」标记）。

---

## 一、目标（Why）

消灭「配置根私有落点」造成的同类数据双目录分裂与静默失效，共 5 个修复项；不做架构级收敛（RouterBus 化、会话权威定夺、localStorage 存量迁移全部另立，见第五节）。

核心判定依据（对抗审查实证）：
1. **compact 检查点在生产默认路径 100% 丢失**：`compact.rs:616-625` 只在 `profile.custom_env["POLARIS_DATA_ROOT"]` 或进程 env 存在时写盘；POLARIS_DATA_ROOT 是 dev/test 隔离变量（AGENTS 3.3），正式桌面运行二者皆空 → 静默不写。**影响最高**。
2. **requirement 双落点已实际分裂**：桌面命令写 `%APPDATA%\com.polaris.app\stores\requirement.db`（`commands/requirement.rs:46,118,210,266,299,327,358`），而 AI/MCP 读 `%APPDATA%\Polaris\stores\requirement.db`（`mcp_config_service.rs:645-849` 经 `{{appConfigDir}}` 注入）。本机实盘：legacy 侧 20480B 活库，DataRoot 侧无库。存储体为 **SQLite（SqliteStorage, domain=requirement）+ 原型 blob 目录 + workspaces.json**（`unified_requirement_repository.rs:1-16`）——不是单文件。
3. **Claude settings.json 级联是真实 bug**：`model_profile_service.rs:236` 注释自称 `~/.claude`，实现写 `dirs::config_dir()/claude` = `%APPDATA%\claude`（`:240-244`），Claude CLI 根本不读该文件；本机实存该垃圾文件（423B, 含 ANTHROPIC 键）。
4. polaris-mcp 兜底 `com.polaris.app`（`bin/polaris_mcp.rs:233-239`）命中率低但属错误默认；C 端 stale exe 会在错误根重建平行库。
5. 小死代码：PromptStore::default 相对路径、historyService 'local' 残壳。

## 二、不动清单（Do-Not-Touch，缺则越界——挑战者定锚）

| # | 不动项 | 依据 |
|---|---|---|
| 1 | 会话双轨：JSONL（轮末前端写、恢复权威）+ messages.db（流式期后端权威、多端共享影子）；「禁版本升级只能 CREATE TABLE IF NOT EXISTS」纪律 | `turn_persist.rs:1-17`、`historyService.ts:33-36`、session_state.rs:36-38 |
| 2 | 中断/幂等链路（晚到 stop、中断消费） | AGENTS 4.2 高危区 |
| 3 | bridge 双根探测（Polaris/Polaris-dev 判活）与旧格式单参解析分支本身 | `ask_listener_meta.rs:73-148` |
| 4 | bus-mcp 独立审计链 `dispatch-mcp.jsonl` | `bus_mcp_server.rs:4-7` |
| 5 | cap.fs 只读门面语义 | `fs_capability.rs:26-29` |
| 6 | 共享层/实例层两轨、scheduler 共享层不隔离 | `data_root.rs:238-284` |
| 7 | 工作区层 `<workdir>/.polaris/`（todos.json / requirements.json / prompt 模板路径 `models/prompt.rs:293-305`、skills/agents/tasks/附件/previews/workspace mcp.json）+ LSP db —— AI 直接读写，改路径即会话行为漂移 | prompt 模板硬编码 |
| 8 | EBWebView 与实例命名 `com.polaris.app[.dev|.test|.instN]` | `instance.rs:97-123` |
| 9 | transport/auth、OPFS 迁移标记、zustand persist 的存量 localStorage | 多端连接刚需/设计内降级 |
| 10 | dialog 直连命令现状（dialog_* 命令族） | 本期不动，见第五节 A |
| 11 | usage.db 借位 dialogs 目录 | 终审核实无破坏面（rebuild 只扫 `*.jsonl`，删除按精确名），记已知限制即可 |

## 三、修复项（Do）

### F1 — compact 检查点路径归一（优先级 1）
- 位置：`src-tauri/src/ai/engine/simple_ai/compact.rs:616-625`。
- 改法：抽纯函数 `resolve_checkpoint_root(custom_env: &Option<HashMap<String,String>>) -> Option<PathBuf>`：
  1. `custom_env["POLARIS_DATA_ROOT"]`（显式覆盖，保留——终审证实全仓无程序化写入方、插件仓零引用）；
  2. 主路径走 `data_root()`（simple_ai 是进程内模块，`data_root()` OnceLock 可用，同模块 `mod.rs:95/agent.rs:41/185` 已有先例）；
  3. **任何失败/缺失不 panic**：`DataRoot::resolve` 链含 `expect`（data_root.rs:342），须降级为 `tracing::warn!` + 跳过——检查点是「回查/对比归档，不可用于恢复」（`store.rs:12`），绝不能打死对话线程。
- 行为变化（spec 明示）：生产环境将从「从不写」变为写 `<DataRoot>/simple-ai/context-checkpoints/`（低频，compact 仅超窗触发）；**当前无清理机制，磁盘积累列为已知限制**。
- 等价性：`data_root()` 自身就是 env 优先（`data_root.rs:165`），custom_env > data_root() 与现语义无冲突。

### F2 — requirement 双落点收口 + 遗留迁移（与 F3 同一提交窗口）
- 改法 A（写口）：`commands/requirement.rs` 7 处 → 统一传 `data_root().config_dir()`（repository 签名 `new(config_dir, workspace)` 不变，命令层零结构改动）。OnceLock 时机问题随直取 data_root 自然消解；web dispatcher（`ipc.rs:1554`）两端 setup 先设根再启 server，无同步窗口（终审验证，不动）。
- 改法 B（迁移，**终审补丁版**）：
  - **不把 "stores" 整目录进 scan_legacy 列表**：本机实存 `%APPDATA%\com.polaris.app\stores\` 内有 requirement.db **和 scheduler.db**，整目录迁移会覆写/旁支活 scheduler.db。改为**专用单文件 LegacySource**：`com.polaris.app/stores/requirement.db`，allowlist={requirement.db}，显式排除 `*.db-wal / *.db-shm`。
  - `requirements/` 目录（prototypes/*.html + workspaces.json）已在扫描列表（`data_root.rs:413` 有 "requirements"），但**不能用默认 overwrite=false 否则 stale-wins**：本机实存 `DataRoot\requirements\workspaces.json` 为 09-09 陈旧中间产物，legacy 侧才是 10-21 活数据 → 对这两个源用 **source-authoritative 冲突规则**（dst 冲突时改名 `.stale-{ts}` 归档再落 source）。
  - 迁移执行顺序（防半截库闭环）：copy 到 `<新根>/stores/requirement.db.incoming-{ts}` → `PRAGMA integrity_check`（VACUUM INTO/backup API 产快照，rusqlite bundled ≥3.27；失败→删 incoming、保留源、不 tombstone、warn）→ 原子 rename 顶替 → 源改名 `requirement.db.migrated-{ts}` **保留不删**（≥1 版本周期）→ tombstone 元数据**带目标 root 路径**（防 anchor 切换窗口重复判「未迁移」）。禁止跨卷 `fs::rename` 删源。
  - 时机：冷启动 setup 阶段幂等 best-effort，失败不阻塞启动；另一侧 web 无迁移逻辑但读新根——copy 半途的 race 由 incoming+rename 原子发布挡住。量级：20480B，耗时可忽略。
  - **dev 变体承诺修正（终审补丁 3）**：`validate_source` 只认 scan_legacy_data 返回集，而 scan 仅扫 `com.polaris.app`。要么为 `com.polaris.app.dev/.test`（tauri.dev.conf.json:4 / tauri.test.conf.json:5）注册独立 legacy 根，要么**删除「dev 各自为源」承诺**（默认：不注册 → dev 数据不自动迁移，spec 二选一须写死；建议后者，保持范围最小）。
  - `files_equal`（data_root_capability.rs:265-280）仅 ≤4MB 内容比对，requirement.db 判等不得依赖它（用快照 + integrity 取代）。

### F3 — polaris-mcp 兜底升级（与 F2 同一提交窗口）
- `bin/polaris_mcp.rs:233-239` `get_default_config_dir()` 的 `com.polaris.app` 字面量移除；单参兼容分支保留，兜底优先级：**显式参数 > `data_root()`（冷启动 lazy，anchor 可达）> `ask_listener_meta::candidate_roots()`（已 pub，:107 pid 判活）**；双 stale/不可判定时一律落正式版根 `Polaris`，并在 warn 中披露选择依据（pid 复用风险对策）；比较 `started_at` 做 tie-break。
- requirements MCP server 读兜底（**终审语义定夺：fallback 时写报错优于写落新库**）：显式传入的 config_dir ≠ DataRoot 且旧库存在 → list/read 允许读旧库 + `tracing::warn!` 披露；**create/update/delete 直接返回明确错误**「旧库只读，请重启主应用完成迁移/重新生成 MCP 配置」。不做双写。
- 顺带声明：同函数兜底也作用于 prd-preview/agnes/ph，统一 DataRoot 优先（一句带过）。
- **门控：本窗口必须 `cargo build --bin polaris-mcp`**（AGENTS 五节 schema/exe 陈旧纪律），否则 stale exe 在错误根重开平行库。

### F4 — Claude settings.json 级联修复（真 bug）
- `model_profile_service.rs:240-244` cascade 目标从 `dirs::config_dir()/claude` 改回 `home/.claude`（与其自注释一致）。
- **终审事实更正**：写方实际只有两处（不是三处）——`commands/claude_settings.rs::write_claude_settings(:61-78)`现为裸 `fs::write`（连原子写都没有）+ `add_claude_permission_rules(:88-107)`；以及 model_profile_service 的 cascade/clear 两 fn。`mcp_manager_service.rs` 对该文件**只读**，不属写方。
- 共享写原语收敛以上两处写方：复用 `model_profile_service.rs:294-303` 的 tmp+rename+备份；**tmp 名唯一化 `{pid}-{ts}.tmp`**（终审补丁：固定 `settings.json.tmp` 跨进程可发布对方半截文件）+ 同进程 Mutex；与 Claude CLI 并发是已知 lost-update 窗口（spec 明示，不解决）。
- `clear_claude_settings_env`（:334-336）从删整个 env 节改为**只删 Polaris 管理三键**（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL，键集取自 EnvKeyMapping），保户自放 env。
- 存量垃圾处置：启动检测 `%APPDATA%\claude\settings.json` 含 Polaris 管理键 → 改名 `settings.json.legacy-polaris-{ts}`（不删除，防误伤），记 audit 日志。

### F5 — 小清理（顺手，两个独立小提交）
- 删 `prompt_store.rs:299-305` Default（相对路径 `.polaris/prompt_config.json`，全仓无调用方，终审证实安全）。
- historyService 'local' 死分支**四处同步摘除**：类型联合 `historyService.ts:94` `'local'` + 删除分支 `:714-720` + 面板分支 `SessionHistoryPanel.tsx:556` + 过时注释 `:521`（只删分支留 union 会编译错，反之亦然）。

## 四、验收谓词（可执行）

| 项 | 谓词 |
|---|---|
| F1 | `resolve_checkpoint_root` 单测：custom_env 优先、缺失 warn 不 panic；`cargo check --no-default-features --bin polaris-web`（compact 无 feature 门控进此构建） |
| F2 | 单测：legacy `scheduler.db`/`kv.db`/`-wal`/`-shm` 不被复制；tempdir 端到端：迁移→tombstone→二次启动零操作→投毒半截文件后重启自愈；实机：DataRoot `stores/requirement.db` integrity ok；legacy 已改名 `.migrated-{ts}`；`com.polaris.app\stores\scheduler.db` 未被复制；UI 需求历史可见；workspaces.json 含 10-21 工作区（防 stale-wins） |
| F3 | `cargo build --bin polaris-mcp`；旧式单参调用日志落 DataRoot（判活）；显式 com.polaris.app 时写工具返回「旧库只读」错误；list 读旧库 + warn |
| F4 | 单测断言 cascade 目标 `home/.claude/`；实机：profile 改动后 `~/.claude/settings.json` 更新且 `.bak` 产生；`%APPDATA%\claude\settings.json` 被改名 `.legacy-polaris-*` |
| F5 | `pnpm exec tsc --noEmit` 无孤悬比较错误；`pnpm test:run`（historyService/SessionHistoryPanel 相关）通过 |
| 门控 | `cargo check`；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；`cargo clippy --lib` 无新增 warning；前端涉改加 `pnpm lint` |

## 五、移出另立（不属于本主题，防战线拉长）

| 代号 | 内容 | 关键已探明约束（供立项时复用） |
|---|---|---|
| A：写通道总线收敛 | dialog→cap.dialog；plugin_state 归宿；config 直写旁路收编 | ① dialog 低频（全仓 1 个 saveConversation 调用点），但 cap.dialog 必须复用 `dialog_storage::*_inner`（否则 FTS/索引增量维护被绕过）且保持「前端给完整 body」协议（压缩态合并保护在前端）；② **plugin_state 不并入 cap.kv**：state.json 承载 mcpToolGates 门控镜像（state.rs:427、mcp_tool_gates.rs、mcp_config_service.rs:786）与 plugin.lifecycle 广播副作用链，SQLite 化将静默砍掉生命周期事件——保持 JSON 原子写，如上总线走专用域动作；③ config 旁路实为 **5+ 个**（set_work_dir / reset_cli_config / set_personal_hub_session / plugin_set_config / set_logging_enabled），且 `plugins[pluginId]` 段不在 cap.config 白名单；收敛前必须先补 Web 桥 AppHandle 副作用缺口（state.rs:502），否则 Web patch modelProfile 会静默丢级联激活；非敏感段先收，modelProfiles 敏感段后置。④ cap 契约变更须三处同步（后端 router + 前端 service + Polaris-plugin 仓库）并重建 polaris-mcp bin |
| B：会话协议 schema 校验 | AIEvent/对话协议运行时校验（第九节已知缺口） | 新立项为协议契约工程，不在归一化内顺手做 |
| C：前端 localStorage 规范 | 只立规范不动存量：新增写点必须经 prefsService 收口、统一 `polaris.` 前缀（仓库已有先例 newSessionPrefsService.ts:10「不引入 localStorage」） | 46+ key 五类风格存货**不迁移**：i18n_language/themeEngine 亮度为同步引导关键（async 化首帧闪变）；transport/auth 是多端连接刚需且含 token 派生；OPFS 迁移标记重搬会引发重复迁移；zustand persist 水合路径全面返工，ROI 为负。可选：未来确有多设备同步具体偏好诉求时，对个别同步型 key 走「旧 key 双读→新 key 写→半年删读」窄窗口 |
| D：history 双实现合并 | `ai/history_claude.rs`（provider 分页版）与 `ai_history_core.rs` 内嵌全量解析并存 | 合并前先出 SessionMeta/ClaudeSessionMeta **字段对齐表**，重点保 sessionHandoff 依赖字段（claudeProjectName 等）与 `ClaudeHistoryProvider::get_claude_dir` pub 签名（dialog_index.rs:523,749 依赖）；旧结构 alias 不删字段防 camelize 漂移 |

## 六、风险登记

1. **WAL 半截文件 / 跨卷 rename**：已由 incoming+integrity+rename+tombstone 顺序与「禁 rename 删源」覆盖。
2. **桌面+web 同根双开迁移 race**：原子发布挡住；未纳入「用户确认弹窗」（数据量小 + 保留源副本更灯笼）。
3. **anchor 切换窗口重复导入**：tombstone 带目标 root 路径判幂等。
4. **stale polaris-mcp exe**：F2+F3 同窗口强制重建门。
5. **deployment 现实**：本机实存内 DataRoot 无 requirement.db → 首次收口必须走 F2 迁移，非可选步骤。
6. **F1 生产行为变化**：检查点从从不写到低频落盘，无清理机制（已知限制，后续可加滚动保留 N 份）。

## 七、提交切分

1. `fix(simpleai): 检查点路径走 DataRoot 单例并消除静默丢失`（F1）
2. `fix(requirement): 统一 requirement 存储根至 DataRoot 并迁移遗留库`（F2+F3 同窗口，含 polaris-mcp 重建）
3. `fix(model-profile): Claude settings 级联目标修正为 ~/.claude 并处理存量`（F4）
4. `chore: 清理 PromptStore 默认死代码与 history local 残渣`（F5，两处可拆）
5. `docs(spec): 本文件前置提交`

追认依据：AGENTS 二-4（spec 先行）、二-5（根因注释）、五（cap 三处同步/若触碰）、七（验证清单）、八（clippy 无新增）。
