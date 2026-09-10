# Polaris 重构 · 第一步：契约冻结实施规划

> 状态：实施中
> 日期：2026-09-10
> 目标目录：`dev/docs/sky/` 记录规划；`src-tauri/src/contracts/` 实施代码
> 原则：**先实现新骨架，再一块块替换，不着急**。旧数据不迁移，旧系统照常运行。

---

## 0. 总体路线（四步走）

| 步骤 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **第一步** | **契约冻结**（Envelope/Source/6+1 trait） | `src-tauri/src/contracts/` | ← **本文件** |
| 第二步 | 存储实现（按域分库） | `Storage` trait 实现，替换 3 个 JSON 仓库 | 待实施 |
| 第三步 | 转发实现（单入口 dispatch） | `RouterBus` + `EventBroadcaster` + demo 能力 | 待实施 |
| 第四步 | 闭环替换（一块块搬） | 调度→Todo→AI→浏览器 逐个迁 | 待实施 |

**前置决策**（已确认）：
- **不保留旧数据**：会话/todo/需求/调度历史全部可弃，旧 JSON/SQLite 数据作为 AI 后续可读的历史资料，不迁移不兼容。
- **DataRoot/anchor 沿用**：`src-tauri/src/services/data_root.rs` 已是收敛资产（9 处硬编码已消除、anchor.json、OnceLock），sky 也采纳它，不重写。
- **命令层不动**：`new(config_dir, workspace)` 签名保持，仓库内部实现切换，命令层零改动。
- **先实现再替换**：每一步先立新骨架并自证，再一块块搬旧功能。

---

## 1. 第一步：契约冻结

### 1.1 目标

把 sky 打磨过的契约层请进 Polaris，作为所有后续能力（存储/转发/AI）的统一基座。**这一层不接任何现有代码，纯粹"立规矩"。**

### 1.2 交付清单

**新增 `src-tauri/src/contracts/` 模块**（不依赖现有模块，只依赖 serde）：

| 类型/接口 | 来源 | 说明 |
|---|---|---|
| `CapabilityId` / `PluginId` / `MsgId` / `TraceId` | sky | 路由键 = 能力 id，非插件名 |
| `Value` = `serde_json::Value` | sky | 跨 WASM 可序列化 |
| `Envelope` { id, source, target, payload, trace } | sky | 统一信封 |
| `Reply` { msg_id, result, trace } | sky | 路由回复 |
| `Event` { seq, kind, payload, trace } | sky | 事件（seq 从第一行就有） |
| `Filter` { kind, trace } | sky | 事件订阅过滤 |
| **`Source` 枚举**（Bootstrap/Remote/Plugin） | sky | **无 local 变体**——治"本地沾光远程" |
| `PermissionRequest` / `PermissionVerdict` | sky | Allow/Deny/Prompt |
| `Item` / `Id` / `Query` | sky | 存储项/标识/查询 |
| `AuditEntry` | sky | 审计条目（prev_hash 防篡改链） |
| `CapabilityHandle` = u64 | sky | 跨 WASM 边界可传 |
| **`trait Context`** | sky | resolve_cap/storage/check_permission/source/caller_id/plugin_config |
| **`trait Plugin`** | sky | init/name/version/capabilities/required_permissions/shutdown |
| **`trait Capability`** | sky | id/invoke/dependencies/drain |
| **`trait StreamingCapability`** | sky | invoke_stream（返回 Receiver<Event>） |
| **`trait Storage`** + `Transaction` | sky | root/store/load/query/delete/begin；commit/rollback/append_audit |
| **`trait Router`** | sky | dispatch/subscribe/register_handle（无 invoke） |
| **`trait Permission`** | sky | check |
| **`trait Session`** | sky | start/end/on_orphan/grace_timeout |
| **`trait Scheduler`** | sky | schedule/cancel |
| `ScheduledTask` | sky | 调度任务定义 |
| `AuditSink` / `LocalSecretProvider` | sky | Bootstrap 直管 trait |
| `AssemblyManifest` / `PluginRef` / `PluginView` / `AssemblyError` / `Profile` | sky | 装配清单与错误模型 |

### 1.3 代码量预估

约 **500–600 行**（类型 + trait + 测试），全部新文件，**零改动现有代码**。

### 1.4 边界（做/不做）

- ✅ 定义类型 + trait + 测试
- ❌ 不接 `AppState`、不接任何 command、不接现有 `capabilities/` 实现
- ❌ 不碰 `models/`（现有业务模型，非契约）
- ❌ 不碰 `services/data_root.rs`、`dialog_index.rs`、unified 仓库

### 1.5 验收标准

1. `cargo check --lib` 通过（新模块编译，现有代码零改动）—— **已验证** ✅
2. `cargo test --lib contracts::` —— **本机受限** ⚠️（见下）
3. 现有 284 个 command 一个都没动，应用照常编译运行 —— **已验证** ✅（cargo check 全量过）

**关于本机测试限制**（已核实）：
- `cargo test --lib` 的 **test profile 编译成功**（3m04s），但运行测试二进制时因 `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) 崩溃——本机缺 Tauri 运行时 DLL 入口，是已知环境约束（见 memory `rust-lib-test-env-limit`：本机 cargo test --lib 无法启动 Tauri DLL）。
- 契约模块是纯 serde 类型（只依赖 serde/serde_json/tokio），逻辑是序列化 roundtrip，无 Tauri 依赖；测试代码已就位，需在具备 Tauri 运行时的环境（CI / 正确配置的机器）验证。
- 编译期已验证：契约模块 `cargo check` 零警告。

---

## 2. 影响面（诚实评估）

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟢 零改动 | 纯新增模块，不 touch 任何现有文件 |
| 编译时间 | 🟢 几乎无 | serde 已在依赖树，无新依赖 |
| 运行时 | 🟢 零影响 | 未接线，应用行为完全不变 |
| 架构 | 🟡 意义重大 | 契约层是后续所有能力的地基，冻结后不可随意改 |
| 风险 | 🟢 最低 | 不碰现有逻辑，随时可回滚（删模块即可） |
| 数据 | 🟢 零影响 | 不碰任何存储/数据 |

**为什么影响这么小却值得做**：它是唯一一个可以在完全不碰现有系统的情况下、为整个重构定调 的步骤。后续存储/转发/AI 全部依赖这一层的 `Source` / `CapabilityId` / `trait` 冻结——契约先立，后面才能"先实现新骨架，再一块块替换"。

---

## 3. 与现有结构的关系

```
src-tauri/src/
  ├── contracts/          ← 新增（契约定义层，本步）
  ├── capabilities/       ← 现有（能力 seam：shell/fs/compaction/subagent）
  ├── models/             ← 现有（业务模型：todo/scheduler/requirement...）
  ├── services/           ← 现有（data_root/dialog_index/unified_*）
  └── commands/           ← 现有（284 个 command）
```

契约层是**最底层**：`capabilities/`（现有能力 seam）和 `models/`（业务模型）将来会**实现或依赖** `contracts/`，但第一步契约层不反向依赖任何现有模块。

---

## 4. 后续步骤速览（第二步起）

- **第二步 存储**：实现 `Storage` trait 的按域分库实现；3 个 unified JSON 仓库（todo/requirement/scheduler）`new()` 内部切换，命令层零改动；会话索引 `dialog_index.rs` 底层切换。
- **第三步 转发**：`RouterBus` + `EventBroadcaster`（seq + 环形缓冲 + replay）；demo 能力 `cap.echo` 经 dispatch 端到端；两端（Tauri/Web）各接一个 handler。
- **第四步 闭环替换**：调度器→Todo/需求→AI 引擎→浏览器 一块块搬，每块独立验证后摘除旧通道。
