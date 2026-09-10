# Polaris 重构 · 第三步：转发 dispatch 规划

> 状态：规划定稿，待实施
> 日期：2026-09-10
> 目标目录：`dev/docs/sky/` 记录规划
> 原则：**先实现新骨架，再一块块替换，不着急**。旧命令照常运行，不迁移。

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
