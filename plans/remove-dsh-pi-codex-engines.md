# 移除 dsh / pi / codex 引擎规划

> 状态：已决策为方案 A（彻底删除），开始实施
> 目标版本：v10.6.0（或下一主版本）
> 相关文档：`docs/engine-plugin-architecture-plan.md`、`docs/lightweight-refactor-plan.md`（Feature 网格）
> 决策前提：Simple AI 保留；插件引擎的 pi 风格协议（PiRpc/SessionFlags::Pi/PiExtension）保留
> 用户决策（2026-09-24）：**彻底删除**（含 EngineId 枚举成员）；老会话数据一并放弃

## 1. 问题陈述

当前 Polaris 内置 5 个引擎：Claude Code、Codex、Simple AI、Pi、DSH（+ 运行时插件引擎）。
其中 Codex / Pi / DSH 三个引擎：

- 维护成本高（Rust 实现合计约 **4700 行** + 前端适配 + 设置 UI + 历史/统计/调度联动）
- 与核心类型 `EngineId` 枚举深度耦合，任何引擎调整都要动核心 match 分支
- 用户侧实际只依赖 Claude Code + Simple AI（+ 插件引擎）
- 编译体积 / 二进制体积 / 启动检测逻辑均被这三引擎拖累

**目标**：从代码库中移除 dsh / pi / codex 三个引擎的实现与 UI 入口，
降低维护面与二进制体积，同时**不破坏存量会话历史、插件引擎协议、IM 集成 API**。

**不做**：不删除 `EngineId::Custom(_)`（插件引擎基础）；不删除 Simple AI；
不删除插件引擎的 Pi 风格协议枚举（`SessionFlags::Pi` / `RpcProtocol::PiRpc` / `McpConsumptionStrategy::PiExtension`）。

## 2. 关键认知与风险

### 2.1 EngineId 是 Single Source of Truth

`src-tauri/src/ai/traits.rs` 明确声明 EngineId 是引擎标识的唯一来源。
`Codex` / `Pi` 是枚举固有成员；删成员必须同步 `known()` / `as_str()` / `aliases()` / `is_known()` 及**所有 match**。

**好消息**：`EngineId::parse_any` 对未知字符串自动落 `Custom(id)`。
存量会话/配置里存的 `"codex"` / `"pi"` 字符串，反序列化后自动变成 `Custom("codex")` 等，
**不会崩溃**，只是不可再新建/续聊原生会话。

### 2.2 dsh 是 Custom 引擎，不是枚举成员

`DshEngine` 以 `EngineId::Custom("dsh")` 注册（`dsh.rs:1814`），
不占枚举成员，但 `ai_chat_core.rs` 有 3 处 `id == "dsh"` 特判（1317、1657、1824），需一并清除。

### 2.3 pi 深深嵌在插件系统里（保留语义 vs 删实现）

插件引擎的通用机制**不是 pi 专属**，必须保留：
- `SessionFlags::Pi`（`--session-id`/`--session` 风格，插件引擎默认值）
- `RpcProtocol::PiRpc`（Pi 兼容 JSONL 协议，插件引擎默认值）
- `McpConsumptionStrategy::PiExtension`（Pi Extension 桥接风格）
- `plugin-system/types.ts`、`registry.ts`、`pluginDiscoveryService.ts` 中这些默认值的引用

删除对象是 **PiEngine 本身**（`ai/engine/pi.rs` 1148 行）与 pi 专属配置字段
（`pi_code`、`pi_provider_config`、`pi_model`、`pi_available`/`pi_version`）。

### 2.4 配置字段删除的连锁反应

`models/config.rs` / `config_store.rs` 有 `codex_code` / `pi_code` 等字段及迁移逻辑。
Serde 对未知字段默认忽略，删字段本身不崩；但 `config_store` 的读写/迁移代码需同步清理，
否则留下死代码。

### 2.5 历史兼容决策（待用户拍板）

`services/codexHistoryService.ts`（读 `~/.codex/sessions`）与 `historyService.ts` 的
`codex-native` 分支：删除后存量 codex 会话无法再续聊。
**建议**：保留只读兼容（历史列表仍显示旧会话，点击提示"引擎已移除"），
或彻底删除（历史一并清掉）。

## 3. 跨层引用盘点（文件级清单）

### 3.1 Rust 后端（`src-tauri/src/`）

| 类别 | 文件 | 动作 |
|------|------|------|
| 引擎实现 | `ai/engine/codex.rs`、`codex_parser.rs`、`pi.rs`、`dsh.rs` | **删**（~4700 行） |
| 注册入口 | `lib.rs:562,568,571` 与 `lib.rs:1360,1362,1363` | 删 6 行 |
| 枚举/类型 | `ai/traits.rs` | 删 `EngineId::Codex`/`Pi` 成员 + match 分支；`SessionOptions` 删 codex/pi 字段 + builder |
| 核心路由 | `ai/launcher.rs:151,169`、`ai/registry.rs`(mock)、`services/ai_chat_core.rs`(多处 + dsh 特判 3 处)、`integrations/commands.rs`(IM 命令) | 删分支 |
| 配置模型 | `models/config.rs`、`services/config_store.rs` | 删字段 + 迁移 |
| 附属服务 | `services/model_profile_service.rs`、`mcp_config_service.rs`、`contracts/mod.rs`、`models/cli_info.rs`、`integrations/manager.rs`、`web/api/ipc.rs` | 删 pi/codex 分支 |
| 引擎导出 | `ai/mod.rs`（若 export CodexEngine/PiEngine/DshEngine） | 删 export |

### 3.2 前端（`src/`）

| 类别 | 文件 | 动作 |
|------|------|------|
| 引擎实现 | `engines/codex/`（3 文件）、`core/engine-bootstrap.ts` 的 codex 工厂 | 删 |
| 引擎选择器 | `Chat/input/ChatInput.tsx`、`NewSessionButton.tsx`、`CreateSessionModal.tsx`、`CompactHandoffModal.tsx`、`SessionConfigSelector.tsx`、`SessionTabContextMenu.tsx`、`GitPanel/CommitInput.tsx`、`Scheduler/TaskEditor.tsx`、`Common/AIPopover.tsx`、`Common/ClaudePathSelector.tsx` | 列表收敛 |
| 设置页 | `Settings/tabs/AIEngineTab.tsx`、`EngineExpandDetail.tsx`、`DispatchSettingsSection.tsx`、`ModelProviderTab.tsx`、`TokenStatsTab.tsx`、`SettingsPage.tsx` | 删条目/筛选 |
| 类型定义 | `types/config.ts`、`types/session.ts`、`types/modelProfile.ts`、`types/chat.ts` | 收敛（保留 string 兜底） |
| 工具函数 | `utils/engineHealth.ts`、`engineDisplay.ts`、`engineCapabilities.ts`、`toolConfig.ts`、`diffExtractor.ts`、`patchParser.ts` | 删 pi/codex 分支 |
| 服务层 | `services/historyService.ts`、`codexHistoryService.ts`、`unifiedHistoryService.ts`、`sessionHandoff.ts`、`conversationPackager/`、`contextCompactHandoff.ts`、`webReconnectResync.ts` | 收敛/只读兼容 |
| 存储/状态 | `stores/configStore.ts`、`modelProfileStore.ts`、`conversationStore/*` | 收敛 |
| i18n | `locales/en-US/settings.json`、`locales/zh-CN/settings.json` | 删条目 |
| 插件系统 | `plugin-system/types.ts`、`registry.ts`、`pluginDiscoveryService.ts` | **保留**（默认值语义） |

### 3.3 测试（~15 文件）

`plugin-system/registry-regression.test.ts`、`services/historyService.test.ts`、
`utils/cache.test.ts`、`engineDisplay.test.ts`、`engineHealth.test.ts`、
`dispatchTaskService.test.ts`、`stores/conversationStore/*.test.ts`、
`dialogStorage/service.test.ts`、`transport/httpTransport.test.ts`、
`ai-runtime/task.test.ts`、`ai/registry.rs` 内嵌测试等。

## 4. 方案选型

### 方案 A：彻底删除（含枚举成员）✅ 已选定
- 删引擎实现 + `EngineId::Codex/Pi` 枚举成员 + 所有 match 分支 + 历史服务 + 配置字段
- 优点：最干净，类型系统层面彻底移除
- 缺点：核心类型变更面大，风险高；存量数据语义变化（老会话变 Custom / 不再可恢复）

### 方案 B：删实现 + 保留枚举成员
- 删引擎实现文件、注册入口、UI 入口、配置字段
- **保留** `EngineId::Codex/Pi` 枚举成员 + `known()` 等（或从 known() 摘除但保留解析别名）
- 优点：`parse_any` 兼容路径不变，存量会话反序列化行为稳定；改动集中、风险可控
- 缺点：枚举里留两个"死成员"，不算 100% 干净

### 方案 C：Feature 门控（编译期可选）
- 加 `codex` / `pi` / `dsh` Cargo feature，默认关闭，代码保留但不编译
- 优点：可逆，未来可一键恢复
- 缺点：代码仍在仓库里，"简化"不彻底；维护死代码

## 5. 实施计划（分阶段，每阶段独立可验证）

### P1 后端删实现 + 不注册（风险最小，收益最大）
- [ ] 删 `ai/engine/codex.rs`、`codex_parser.rs`、`pi.rs`、`dsh.rs`、`pi_parser.rs`
- [ ] `ai/engine/mod.rs`、`ai/mod.rs` 删模块声明与 export
- [ ] `lib.rs` 两处注册入口去掉 6 行
- [ ] `traits.rs`：删 `EngineId::Codex`/`Pi` 成员 + `known()`/`as_str`/`aliases`/`is_known` 分支；
      `SessionOptions` 删 `codex_config_args`/`pi_provider_config`/`pi_model` + 对应 builder
- [ ] 用 `cargo build` 的错误列表作为精确待改清单，逐个清 match 分支
- **验收**：`cargo build` 通过；`cargo test` 通过

### P2 后端附属清理
- [ ] `models/config.rs`、`config_store.rs` 删 codex/pi 字段 + 迁移逻辑
- [ ] `ai_chat_core.rs` 删 dsh 特判（3 处）+ codex/pi 分支
- [ ] `launcher.rs`、`integrations/commands.rs` 删引擎分支（IM 命令参数收敛）
- [ ] `model_profile_service.rs`、`mcp_config_service.rs`、`contracts/mod.rs`、`models/cli_info.rs`、`web/api/ipc.rs` 收敛
- [ ] `ai/mod.rs` 删引擎 export
- **验收**：`cargo build` + `cargo test` 全绿

### P3 前端 UI 清理
- [ ] 删 `engines/codex/` 目录 + `core/engine-bootstrap.ts` 的 codex 工厂
- [ ] 10 个引擎选择器组件收敛为 claude-code / simple-ai（+ 插件引擎动态）
- [ ] 设置页：`AIEngineTab.tsx` 删 3 条目、`EngineExpandDetail.tsx` 删 pi MCP 桥接、
      `DispatchSettingsSection.tsx` / `ModelProviderTab.tsx` / `TokenStatsTab.tsx` 收敛
- [ ] 类型定义收敛（`EngineId` / `ProfileTargetEngine` / `ALL_ENGINES`，保留 string 兜底）
- [ ] 工具函数删 pi/codex 分支（`engineHealth` / `engineDisplay` / `engineCapabilities` / `toolConfig` / `diffExtractor` / `patchParser`）
- [ ] i18n 删条目（en-US / zh-CN）
- **验收**：`pnpm build` 通过；`pnpm test:run` 通过

### P4 服务层兼容 + 收尾
- [ ] 历史服务：`historyService.ts` codex-native 分支与 `codexHistoryService.ts`
      → 按决策：只读兼容（保留 service，UI 不新建）或彻底删
- [ ] `sessionHandoff.ts` / `conversationPackager/` / `contextCompactHandoff.ts` / `webReconnectResync.ts` 收敛
- [ ] 删/改 ~15 个测试文件相关用例
- [ ] 冒烟：启动应用 → 引擎列表只剩 Claude / Simple AI（+ 插件引擎）；历史列表旧会话正常显示
- **验收**：四绿（cargo build / cargo test / pnpm build / pnpm test:run）

## 6. 回滚与风险预案

- 全程使用小步提交（每阶段一个 commit），任一阶段失败可 revert
- P1 是最大改动，先单独提交；P2~P4 依赖 P1 的编译错误清单，顺序不可颠倒
- 若 P1 遇到枚举删除导致大量 match 泄漏，可回退到"枚举成员保留 + 仅摘除 known()"
  （即方案 B 的保守子集），继续后续阶段

## 7. 验收标准（总）

1. `cargo build` 通过（桌面 + web 两个入口）
2. `cargo test` 通过
3. `pnpm build` 通过
4. `pnpm test:run` 通过
5. 引擎设置页仅显示 Claude Code / Simple AI / 插件引擎
6. 存量会话历史可正常浏览（codex/pi 显示为不可续聊的旧会话，或按决策隐藏）
7. 插件引擎（OMP 等）注册、MCP 桥接、会话恢复功能不受影响
8. IM 集成命令不再响应 codex/pi/dsh 引擎切换

## 8. 遗留决策（已确认）

- [x] 老会话数据：**彻底删除**（不再保留 codex 历史只读兼容）
- [x] `EngineId` 枚举成员：**彻底删除**（方案 A）
- [ ] 是否顺手清理根目录临时文件（`pelican_bicycle.html`、`voxel_construction_site.html`、`_vision_test.html`）— 待 P4 收尾时确认
