# AI 自我管理能力域：cap.self（透视 / 操作 / 改造）

> 目标（goal 衍生）：支持 AI 清楚 Polaris 的内容，支持对自身任意操作与改造。
> 状态：**已实现（2026-10-19）**
> 日期：2026-10-19
> 依赖：`plans/dynamic-capability-registry.md`（cap.registry 已落地，动态能力 E2E 13/13）

## 1. 需求解读（用户原话 → 设计结论）

> 「支持 AI 清楚 Polaris 的内容，支持对自身任意操作与改造」

三层：
1. **透视（inspect）**：AI 能"看清楚"Polaris——能力清单、存储布局、会话/数据/配置、运行状态。
2. **操作（manage）**：AI 能"清除"——删会话/清缓存/重置配置等，破坏性动作受控且可审计。
3. **改造（mutate）**：AI 能"加装/调整"——扩展既有 UI 部件、注册动态能力（不重启）。

**设计原则**：能复用既有 cap 绝不新造；新造只补真实缺口；破坏性动作必须显式受控。

## 2. 现状盘点（已核实的既有能力）

| 能力 | 覆盖的子需求 | 结论 |
|---|---|---|
| `cap.help` | 全能力 describe 清单（透视入口） | 复用，无需改 |
| `cap.registry` | 动态能力注册/持久化/重启重建（改造·能力） | 复用，E2E 已验 |
| `cap.history` | 会话 list/delete/purge（操作·会话） | 复用 |
| `cap.data_root` | 数据根布局（目录信息，透视） | 复用 |
| `cap.fs` | 只读文件浏览（透视） | 复用；**保持只读**是安全边界 |
| `cap.config` | 读写配置（操作·配置） | 复用 |
| `cap.ui.*` | 主题/对话/输入区参数调节（改造·UI） | 复用 |
| **无** | **运行状态汇总、存储占用、健康自检** | **缺口 → 新造** |
| **无** | **UI 部件级（组件插槽）注入/替换** | **缺口 → 新造** |

## 3. 目标架构

```
AI 会话
  │ cap_dispatch / cap_list（cap 总线已有通道）
  ▼
RouterBus（统一 gate + 审计）
  │
  ├─ cap.self.inspect   （新）运行状态 / 存储占用 / 健康自检
  ├─ cap.self.mutate    （新）具名组件插槽注入/替换/移除（前端渲染）
  └─ 复用：cap.help / cap.registry / cap.history / cap.data_root / cap.fs / cap.config / cap.ui.*
```

**不新造**管理面的通用写通道（cap.fs 保持只读；清理走专用 cap），避免「能删任意/写任意」成为破坏面。

## 4. 契约设计

### 4.1 `cap.self.inspect`（新后端能力，无状态，只读）

```
sum: 自身管理·透视：运行状态 / 存储占用 / 健康自检
actions:
  status       {} → { version, uptimeSec, dataRoot, engineCount, capCount, storeCount? }
  diskUsage    {} → { dataRootBytes, dialogsBytes, storesBytes, cacheBytes, logsBytes }
  capabilities {} → { total, bySource: { builtin, dynamic, plugin } }
  health       {} → 关键子系统自检（存储可读/审计可写/调度器状态）
```

- 语义：把 AI 需要的"这台机器长什么样"一次性给全，减少多趟拼接。
- 数据来源：全部只读汇总（data_root 目录尺寸、bus 注册表、version 常量），不新增写路径。

### 4.2 `cap.self.mutate`（新后端能力，配前端组件插槽注册表）

```
sum: 自身管理·改造：具名 UI 部件插槽注入/替换/移除
actions:
  listSlots   {} → { slots: [{ id, current: "builtin" | {source,kind,ts} | null }] }
  setSlot     { slotId, kind }                            → 设置插槽组件（本地内置 or 远程注入）
  clearSlot   { slotId }                                  → 移除插槽组件（回落内置）
```

- **插槽是白名单具名组件**（如 `input-floating`、`app-badge`、`message-extra`），不开放任意 HTML/脚
  本注入——安全边界与 `cap.ui.*` 一致的"预置能力调参"升级为"预置部件加装"。
- 前端：新增 `uiSlotStore`（Zustand，持久化），`uiDispatchService` 白名单追加 `cap.self.mutate`，
  消费 `setSlot/clearSlot` → 具名插槽渲染点（App 壳/输入区/消息列表）拉取 store 渲染。
- 后端：与 cap.ui.input 同型（无状态，校验 + 审计 + describe；状态真相在前端 store）。

### 4.3 清理类

**复用 `cap.history.delete_session`**（已存在），不新造。若需要"清空全部会话"加一个
`cap.history.delete_all`（显式确认字段 `confirm: "DELETE-ALL"` 防误触）。本轮先不加，保持克制。

## 5. 边界与不做（克制清单）

- **cap.fs 保持只读**。任何「清理/写文件」不并入 cap.fs；会话清理走 cap.history，其他清理后续按需加专用能力。
- **不做任意 HTML/脚本注入**。组件只能填白名单插槽，禁止内联 style 之外的原生能力。
- **不做配置级远程放行**。`cap.self.*` 默认遵循 policy_permission 现有分层：Remote 默认按需（inspect 可放行，mutate 属 UI 域与 cap.ui 同处理，clear/删除类保持受控）。
- **不引入新调度**。mutate 状态存前端 store（与 inputUIStore 同模式），重启保留靠 localStorage。

## 6. 实施步骤

**阶段 A：cap.self.inspect（后端，只读，无前端）**
1. `services/router/self_capability.rs`（或拆 `self_inspect`）：status/diskUsage/capabilities/health
2. state.rs 装配；describe 对齐 cap.help 索引
3. 单元测试 + `cargo check --tests --lib`

**阶段 B：cap.self.mutate（后端 + 前端）**
4. `services/router/self_mutate_capability.rs`：listSlots/setSlot/clearSlot（校验 + 审计）
5. state.rs 装配；`uiDispatchService` 白名单 + `applySelfMutateAction`
6. 前端 `uiSlotStore.ts` + 插槽渲染点（输入区先做 1 个示范插槽）
7. vitest + `cargo check` + 真实运行 E2E（复用 dynamic-capability E2E 通道）

## 7. 验收标准

1. AI 经 `cap_dispatch → cap.self.inspect status/diskUsage/capabilities/health` 拿到运行状态汇总。
2. AI 经 `cap_dispatch → cap.self.mutate setSlot` 让输入区出现/替换/移除部件（前端可见即时变化）。
3. `cap.self.*` 全部过 RouterBus gate + 审计落盘。
4. `cargo check --tests --lib`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、`pnpm exec tsc --noEmit`、vitest 全绿。
5. 真实运行环境（headless polaris-web + HTTP router_dispatch）E2E 通过。

## 8. 实现记录（2026-10-19）

### 阶段 A：cap.self.inspect（已实现，E2E 21 断言绿）
- `services/router/self_capability.rs`：`SelfInspectCapability`（注入 `router: Arc<RouterBus>`），
  动作 status / diskUsage / capabilities / health，纯只读聚合，能力索引复用
  `RouterBus::described_capabilities()`（与 cap.help 同源）。
- `mark_boot()` 静态函数在 state.rs 装配时调用，uptime 从此计算。
- 单测 5 个（status/capabilities 分类/diskUsage 结构/health 结构/未知动作）。

### 阶段 B：cap.self.mutate（已实现，E2E 18 断言绿）
- `services/router/self_mutate_capability.rs`：`SelfMutateCapability`（无状态，前端为真相），
  动作 setSlot / clearSlot / listSlots，白名单 `SLOT_IDS` + `SLOT_KINDS` + `PROPS_KEYS`
  双端校验（后端 Rust 常量 + 前端 uiSlotStore 常量对齐）。
- 前端 `uiSlotStore.ts`（Zustand persist）+ `uiDispatchService` 白名单加 `cap.self.mutate`
  + `UiSlot.tsx` 白名单渲染器 + ChatInput 挂载 `input-extra` 示范插槽。
- 单测 4 个 + 前端 vitest 12 个（store 动作 + applySelfMutateAction 协议）。

### 权限收紧（spec §5 落地为代码）
- `policy_permission.rs` 内置收紧新增 `("cap.self.mutate", true)`：
  Remote 默认 deny（与 cap.ui 同域语义，防远程旁路控制本地面板）。
- `cap.self.inspect` 只读 → Remote 默认放行（"看清这台机器"是远程 AI 刚需）。
- config `permissions.rules` 精确 allow 可覆盖（特异性 2 > 内置通配 deny 特异性 1，已验证）。

### 审计链路
- 写动作（setSlot/clearSlot）经 `ctx.storage().begin() → append_audit → commit` 落盘
  `stores/self.mutate.db` 的 `domain_audit` 表，source 记录为 Remote。
- dispatch 层由 RouterBus 统一写 `audit/dispatch.jsonl`（哈希链连续，45 条验证通过）。
- **修复过 1 个真 bug**：初版只 `append_audit` 未 `commit`，Drop 自动 ROLLBACK 导致审计丢失；
  对照 cap.kv 事务模式补 `commit()`（commit 失败 warn 不阻塞改造）。

### 真实运行 E2E（headless polaris-web + HTTP router_dispatch）
- 功能链路 39/39 绿（19831 数据根 + config 精确 allow 覆盖）：
  inspect 四动作结构断言 + mutate setSlot/clearSlot/listSlots + 非法注入拒绝三连 + 未知动作。
- 权限边界 3/3 绿（19832 默认数据根）：inspect 放行 / mutate deny / cap.ui.input 对照 deny。
- 审计：self.mutate.db domain_audit 3 条（setSlot.input-extra / setSlot.app-badge /
  clearSlot.app-badge，source=Remote）；dispatch.jsonl 哈希链连续。

### 验证命令
- `cargo check --tests --lib` ✓
- `cargo check --no-default-features --bin polaris-web` ✓（发布门控）
- `pnpm exec tsc --noEmit` ✓
- `pnpm exec eslint` 改动文件 0 errors（2 存量 warning 非本次引入）
- `pnpm exec vitest run` uiSlotStore + inputUIStore 26 绿
- 真实运行 E2E：功能 39 + 权限 3 + 审计 3 全绿