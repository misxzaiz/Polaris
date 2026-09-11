# Polaris 重构 · 第三步：转发 dispatch 规划

> 状态：阶段 A+B 已实施（RouterBus 骨架 + 事件适配层 + demo capability，单测编译全绿）
> 日期：2026-09-10（规划定稿）/ 2026-09-11（阶段 A+B 落地）
> 目标目录：`dev/docs/sky/` 记录规划
> 原则：**先实现新骨架，再一块块替换，不着急**。旧命令照常运行，不迁移。

---

## ⏩ 实施进展（2026-09-11）

### ✅ 阶段 A：RouterBus 转发骨架
- `src-tauri/src/services/router/mod.rs` — `RouterBus` 实现契约 `Router` trait
  - `dispatch` 全链路：广播 `dispatch.start` → 权限 gate（Allow/Deny/Prompt 安全失败）→ 找句柄 → invoke → 广播 `dispatch.end`
  - `register_handle` / `subscribe` / `list_capabilities` / `plugin_config_for`（三段匹配）
  - `RealContext`：Source 由传输层注入（调用方不可自填），storage 阶段 A 可 None
  - `StaticPermission`：静态授权默认实现
- 单测：echo 往返 / 未注册 / Remote 拒绝 / Prompt 安全失败 / allow+deny 审计 / plugin_config 三段匹配 / dispatch start+end 广播

### ✅ 阶段 B：事件适配层 + demo capability
- `event_adapter.rs` — 契约 `Event` ↔ 现有生产级广播器：
  - `encode_event`：Contract `Event` → `{"event":<kind>,"payload":<payload>}`（seq 由广播器注入）
  - `broadcast`：编码交给 `web/EventBroadcaster`（2000 条/8MB 双上限 + 重放缓冲）+ in-proc 订阅（Filter 过滤）
  - `subscribe`：返回 `mpsc::Receiver<Event>`，同步可用
  - **不改 `web/event_broadcaster.rs`**（现有 WS 通道零回归）
- `demo_capability.rs`：`EchoCapability`（cap.echo）+ `FaultyCapability`（cap.faulty error 分支）
- 单测：encode 形态 / broadcast 推送匹配订阅者 / subscribe 只收匹配 kind / dispatch start+end trace

### 验证状态
| 项 | 状态 |
|---|---|
| `cargo check --lib` | ✅ 全绿，router 零告警 |
| `cargo check --tests` | ✅ 全绿（含 11 个 router 单测编译） |
| 命令层零改动 | ✅ 外部零引用 router（纯新增骨架） |
| 单测运行 | ⚠️ 受 `0xc0000139`（Tauri DLL 环境限制）挡，实测不可运行；改经独立 crate `/tmp/dispatch-verify`（复制 contracts+sqlite+router，rusqlite bundled）实际运行 **47 passed / 0 failed** |

### 遗留（阶段 C / 第四步）
- ❌ 面板阶段 C（已注册能力列表 / dispatch 测试台）— 前置：面板 → 后端新命令
- ❌ 命令层迁移到 dispatch（第四步闭环替换）
- ❌ 路由 dispatch 直连 SqliteStorage（阶段 B storage=None，ctx.storage 返回 Err）→ **已解决（P2）**

### ✅ 阶段 C 前置（P2）：第一个真实能力 cap.kv 接线

- `services/router/kv_capability.rs` — `cap.kv` 真实能力（非 demo）：经 `ctx.storage()`
  读写 SqliteStorage（domain=`kv`，数据落 `<DataRoot>/stores/kv.db`），动作协议：
  get/set/delete/list。
- `state.rs` — `AppState` 新增 `router: Arc<RouterBus>`；`create_app_state` 接线：
  `EventAdapter::from_broadcaster(event_broadcast)` 复用现有 WS 通道 + `StaticPermission` +
  `SqliteStorage` + 注册 cap.kv。`clone_for_web` 共享 router。
- `commands/router.rs` — `router_dispatch`（构造 Envelope 走 dispatch 全链路）+
  `router_list_caps`（已注册能力列表）。`lib.rs` invoke_handler 注册。
- `EventAdapter::from_broadcaster` — 复用现有广播器构造适配层（不重 new）。

**验证**：独立 crate `/tmp/dispatch-verify` 实际运行 47 passed / 0 failed + 端到端 main
（dispatch→cap.kv→SqliteStorage 落库 / 事件广播 / 未注册能力 Err）全链路真实跑通。
`cargo check --lib` / `--tests` 全绿。

### ✅ 阶段 C（P3）：契约测试面板接 RouterBus —— 已注册能力 + dispatch 测试台

- `web/api/ipc.rs` — Web/HTTP 桥接：`/api/router-dispatch` / `/api/router-list-caps`
  走 catch-all IPC bridge 分发，**Web 模式强制 `Source::Remote`**（Shell 永不获得
  Bootstrap；桌面 tauri 命令 `map_source` 保留 Bootstrap 给本地可信测试）。
- `ContractExplorerPanel.tsx` — 面板新增两块（阶段 C 落地）：
  - **dispatch 测试台**：选能力（datalist 下拉）→ 填 payload JSON → 调
    `router_dispatch` → 显示 Reply（ok / result / error / trace），支持
    Bootstrap/Remote 来源标注。
  - **已注册能力列表**：调 `router_list_caps` 展示，点击直接填入测试台（联动）。
- 安全铁律：Web 前端即使传 `source: bootstrap` 也会被后端强制 `Remote`，不可自声明
  Core 专用来源。

**验证**：`cargo check --lib` ✅ + `--no-default-features --bin polaris-web` ✅（web-only
零回归）；`tsc --noEmit` 我的文件 0 error；`eslint` 面板 0 error 0 warning。
（既有 BrowserPanel.tsx TS 错误为历史遗留，与本次无关）

### ✅ 第四步闭环替换第一块（P4）：cap.todo —— 真实业务域搬上 dispatch

- `services/router/todo_capability.rs` — `cap.todo` 真实业务能力：经 `ctx.storage()`
  读写 SqliteStorage（domain=`todo`，数据落 `<DataRoot>/stores/todo.db`），**存取格式与
  `UnifiedTodoRepository` 字节一致**（命令层能读出 cap.todo 写的数据，反之亦然）。动作协议：
  list / get / create / update / delete / start / complete / breakdown。
- `state.rs` — `create_app_state` 注册 `register_handle(Box::new(TodoCapability))`。
- **闭环语义**：命令层"list_todos/create_todo/..."与 cap.todo 双轨并存（旧通道照常），
  cap.todo 复用 TodoItem/TodoCreateParams/TodoUpdateParams/TodoStatus 模型 + RFC3339 毫秒
  时间戳（与 `UnifiedTodoRepository::now_iso` 一致），业务逻辑零重写。

**验证**：独立 crate `/tmp/todo-verify` 实际运行 **55 passed / 0 failed**（47 既有 + 8 cap.todo
新增）+ 端到端 main（dispatch→cap.todo→SqliteStorage 落库 / create→get→list→update→start
→complete→breakdown→delete / 未注册 Err / cap.todo 已注册）全链路真实跑通。
`cargo check --lib` / `--tests` / `--no-default-features --bin polaris-web` 全绿零回归。

---

## 0. 承接前两步

- **第一步**已冻结契约（`src-tauri/src/contracts/`）：`Envelope` / `Reply` / `Event` / `Filter` / `Source`（无 local 变体） / `Router` trait / `Capability` trait / `StreamingCapability` / `Permission` / `AuditSink`。
- **第二步**（规划）把 `Storage` trait 变成真实实现，统一三仓库。
- **本步**把 `Router` trait 变成真实实现：一条总线，所有调用（IPC / Web / 插件间）统一构造 Envelope 走 dispatch。

---

## 1. 关键判断：Polaris 的 EventBroadcaster 比 sky 更成熟

### 1.1 代码级核实（本步新做的）

| 维度 | sky | Polaris | 结论 |
|---|---|---|---|
| EventBroadcaster | 环形缓冲（count 上限，bytes 未跟踪）| **2000 条 + 8MB 双上限**、淘汰记 `evicted_through`、gap 判定精确 | sky 注释明写"对齐 Polaris"，**方向是 sky 抄 Polaris** |
| 事件格式 | `Event { seq, kind, payload, trace }`（强类型）| `{"seq":N,"event":"...","payload":...}`（字符串，首 `{` 后注入 seq）| 强类型统一由契约层 `Event` 提供 |
| 传输层 | in-proc channel | WS `subscribe()` + `replay_after(last_seq)` 补发 | Polaris 已成熟，直接复用 |
| 权限 gate | `dispatch()` 内统一 `permission.check` → Allow/Prompt/Deny | 分散在命令层（plugin_config.rs 有 `check_permission`）| **Polaris 缺统一的 dispatch gate** |
| 调用入口 | 只有 `dispatch(Envelope)` | **382 个 `#[tauri::command]`** + IPC bridge + executor | Polaris 的调用入口是分散的 |

### 1.2 结论

**不照抄 sky RouterBus**，而是复用 Polaris 已有的两块成熟资产：

1. **`EventBroadcaster`（web/event_broadcaster.rs）** — 生产级，含 2000 条/8MB 双上限 + gap 检测。新增一个薄适配层把契约层 `Event` → 现有 `{"seq","event","payload"}` 字符串格式，即可无缝接入现有 WS 通道。
2. **命令层不动** — 382 个 command 是既有稳定 API，本步**不迁移**，只是让新骨架 `RouterBus` 先存在并单测验证，逐步被命令层调用（第四步闭环替换）。

本步真正补缺的是：
- **统一 dispatch 骨干**：`RouterBus`（handles 注册表 + dispatch 全链路：广播 dispatch.start → 权限 gate → 找句柄 → invoke → 广播 dispatch.end）
- **Source 标注**：调用方来源（Bootstrap/Remote/Plugin），由传输层注入，调用方不可自填
- **Permission gate**：`dispatch()` 是唯一入口，所有调用统一过 gate（静态授权装配时校验；动态请求安全失败 Deny）
- **审计**：dispatch 的 deny/allow 均经 `AuditSink` 落 tamper-evident 链

---

## 2. 交付清单

### A. 新增 `RouterBus`（核心，先做 + 单测）

**文件**：`src-tauri/src/services/router/mod.rs`

```
pub struct RouterBus {
    handles: RwLock<HashMap<CapabilityHandle, Box<dyn Capability>>>,
    next_handle: AtomicU64,
    broadcaster: Arc<EventBroadcaster>,          // 复用现有生产级广播器
    permission: Box<dyn Permission>,
    storage: Arc<dyn Storage>,                    // 第二步的 SqliteStorage（可先接 MemoryStorage 占位）
    audit: Arc<dyn AuditSink>,                    // Bootstrap 直管，dispatch 落审计
}

impl Router for RouterBus {
    fn dispatch(&self, env: Envelope) -> Result<Reply, String>;
        // 0. 广播 dispatch.start（trace 全链路可观测）
        // 1. permission.check(req) → Deny/Prompt 安全失败 + audit.deny
        // 2. 找句柄（handles 按 cap.id() 匹配）
        // 3. invoke（或 StreamingCapability::invoke_stream → broadcaster）
        // 4. 广播 dispatch.end（含 status ok/error）
    fn subscribe(&self, filter: Filter) -> mpsc::Receiver<Event>;
    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String>;
}
```

**关键**：`dispatch` 内注入的 `ctx` 携带 `Source`（调用方不可自填）。`Source` 由传输层（IPC/WS 鉴权后）决定。

### B. 事件适配层（复用现有广播器）

**文件**：`src-tauri/src/services/router/event_adapter.rs`

```
impl EventAdapter {
    /// 契约层 Event → 现有 {"seq","event","payload"} 字符串
    pub fn encode(event: &Event) -> String;
    /// 订阅：契约层 Filter → 订阅并过滤 → mpsc::Receiver<Event>
    pub fn subscribe(&self, filter: Filter) -> mpsc::Receiver<Event>;
}
```

不改 `web/event_broadcaster.rs`（现有 WS 通道零回归），只在边上加转换。

### C. demo capability（验证 dispatch 全链路）

**文件**：`src-tauri/src/services/router/demo_capability.rs`

```
pub struct EchoCapability;              // cap.echo：原样返回 payload
impl Capability for EchoCapability { ... }
```

**单测**（关键：验证真实能力，非骨架）：
- dispatch echo → 返回原样
- dispatch 未注册能力 → Err
- `Source::Remote` + DenyRemotePermission → 权限拒绝 + 审计记录
- `dispatch.start`/`dispatch.end` 事件已广播（trace 匹配）
- subscribe(filter) 只收到匹配 kind 的事件

### D. 面板阶段 B：契约测试面板接 RouterBus

- `ContractExplorerPanel` 增加"已注册能力"列表（调 `list_capabilities`）
- 增加"dispatch 测试台"：选能力、填 payload、看 Reply 与事件流
- 前置：面板 → 后端新命令（`router_dispatch` / `router_list_caps` / `router_replay`）

---

## 3. 边界（做/不做）

- ✅ 新增 `RouterBus` + 事件适配层 + demo capability + 单测
- ✅ dispatch 全链路（start → gate → invoke → end）落地，单测验证
- ❌ 不迁移现有 382 个 command 到 dispatch（第四步闭环替换）
- ❌ 不改 `web/event_broadcaster.rs`（复用，零回归）
- ❌ 不碰前端（面板阶段 B 只新增面板，不改现有 UI）
- ❌ 不碰数据（复用第二步存储规划，本步不实现存储）

---

## 4. 验收标准

1. `cargo check` 通过
2. `Router` trait 实现单测通过（真实 dispatch 全链路，含权限拒绝/审计）
3. 事件适配层单测通过（契约层 Event ↔ 现有字符串格式）
4. 现有 382 个 command 零改动，应用照常运行

---

## 5. 影响面

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟡 中 | 新增 router 模块 + 事件适配层，命令层不动 |
| 命令层/前端 | 🟢 零改动 | dispatch 是新增入口，不替换现有命令 |
| 数据 | 🟢 零改动 | 复用第二步存储，本步无数据写入 |
| 风险 | 🟢 低 | 新增骨架 + 单测，不触碰现有路径 |
| 架构 | 🟢 正向 | 一条总线先存在，为第四步闭环替换铺路 |

---

## 6. 实施顺序建议（分步）

- **阶段 A**：`RouterBus` + 权限 gate + 审计 + 单测（**先做，独立验证**）
- **阶段 B**：事件适配层 + demo capability + 单测
- **阶段 C**：面板阶段 B（已注册能力 / dispatch 测试台）

不一次全改，A 验证通过再动 B。
