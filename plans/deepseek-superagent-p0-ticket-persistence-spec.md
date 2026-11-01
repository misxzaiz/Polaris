# DeepSeek superagent 对照 · P0 工单持久化与重启恢复 spec

> 来源：DeepSeek `dsh-superagent-prototype`（2026-10-31 开源）对照分析。
> 对照对象：dsh-superagent 的 Ticket + Assignment + Effects 持久化与重启恢复机制。
> 状态：specd，待拍板。所有者：宿主端 `src-tauri/src/state.rs` + `services/ask_listener.rs`。
> 原则：基于现有 JSON 持久化做增量演进，**不推翻重写**；改动可分批、可回退。

---

## 一、背景：DeepSeek 怎么做的

DeepSeek superagent 把"工单（Ticket）+ 派工（Assignment）+ 副作用队列（Effects）"全部落 SQLite，核心保证：

1. **重启不丢工作上下文**：Sessions、目录、Subscriptions、未读 Inputs、已读记录都存活；中断的 Assignment 带 recovery note 重启。
2. **副作用先落库再执行**：relay / launch / delivery / reply 都 `enqueue` 进 Effects 表，提交后才执行；失败指数退避重试，同一 kind/key 替换 payload 不重复入队。
3. **局部重试不重跑全量**：`retry` 只结束当前 Assignment 起新的（同 Session、同目录、同分支、同 PR）；`restart` 带 recovery note 提示"检查 git 历史与 GitHub 后再重复任何对外动作"。
4. **并发槽治理**：并发限制 + 1 个额外槽专给人消息/状态请求，新工作不能阻塞人的续接。
5. **消息顺序保活**：同 Ticket 同会话的消息按序发送，前一条失败 3 次才阻塞后一条；不同 Ticket 互不阻塞。

> 借鉴边界：DeepSeek 是事件驱动的 GitHub/Feishu agent，Polaris 是桌面交互 agent，事件源模型不同。本 spec 只借鉴**持久化形态与恢复语义**，不引入 Source/Thread/Subscription 抽象（那是 P2，单独立 spec）。

---

## 二、Polaris 现状（2026-11-01 实测）

### 已有持久化（比预期乐观）

`state.rs:880-1070` 已实现 JSON 文件持久化，并非纯内存：

- **存储路径**：`<app_config_dir>/dispatch_tasks.json`（`state.rs:884-888`）。dev 数据根下为 `Polaris-dev/dispatch_tasks.json`，生产为 `polaris-s/dispatch_tasks.json`。
- **写入策略**：原子写（先写 `.tmp` 再 rename，`state.rs:918-928`）；每次 `insert/update/update_status` 后同步落盘（`state.rs:977/1000/1013`）。
- **容量治理**：上限 100 条，按 `updated_at` 取最近 N 条，超限裁剪内存与磁盘同步（`state.rs:891/903-912`）。
- **陈旧治理**：`active_dispatched_task_count` 忽略 30 分钟未更新的 pending/running，避免前端异常退出后并发额度被永久占用（`state.rs:1052-1069`）。
- **启动加载**：`lib.rs:906` 与 `lib.rs:1483` 两处调用 `load_dispatched_tasks()`；加载时把 pending/running **标记为 failed + summary "应用重启，任务已中断"**（`state.rs:936-970`）。

### DispatchedTask 数据结构（`state.rs:176-237`）

字段已相当完整：dispatch_id / session_id / source_session_id / title / prompt / work_dir / engine_id / depth / role / model_profile_id / model / append_system_prompt / permission_mode / **status(pending|running|completed|failed)** / summary / latest_activity / conversation_id / result_schema / roster_id / verdict / verdict_status / verdict_retry_done / created_at / updated_at。

### 现状短板（本 spec 要治的）

| 短板 | 现状 | 后果 |
|---|---|---|
| **S1 · 启动即判死** | `load_dispatched_tasks` 把所有 pending/running 一律标记 failed，无任何恢复尝试 | 宿主重启=所有在途任务终结，无法续接；长程任务不可信 |
| **S2 · JSON 单文件** | 全量重写一个 JSON；100 条上限；写入与并发计数抢同一 Mutex | 任务量上来后写放大 + 锁竞争；无历史归档（裁剪即丢失） |
| **S3 · 无 recovery note** | 标记 failed 时只写"应用重启，任务已中断"，不带原 prompt/上下文指针 | 即使想手动续接也无结构化依据 |
| **S4 · 无副作用队列** | 状态更新直接改内存+落盘，无"先入队提交后再执行"的 Effects 层 | 中途崩溃的状态更新可能落盘也可能没落盘，恢复时状态不确定 |
| **S5 · 无重启续接协议** | 前端启动派发会话后回报 conversation_id，但重启后无"用 conversation_id 续接已有会话"的链路 | conversation_id 字段存在却未被恢复路径利用 |
| **S6 · roster 中断不可续** | `nexus_pipeline.rs` 波次推进依赖成员终态事件，重启后未结束成员被标记 failed 会触发 `on_member_terminal` 推进下一波 | 重启即整条流水线"假完成"，后续波次基于错误前提推进 |

---

## 三、目标（分两期，严格可回退）

### 期 A · 恢复闭环（先做，不改存储格式）

**最小改动让重启不再"判死"在途任务**：引入 `interrupted` 中间态 + recovery note + 可选手动续接。

### 期 B · 存储升级（后做，可选 SQLite）

**把 JSON 单文件升级为 SQLite 表**，复用 `rusqlite bundled`（已入库）与 `scheduler/sqlite_task_storage.rs` 的成熟范式，消除写放大与锁竞争，并补历史归档。

> 期 A 不依赖期 B；期 A 验证恢复语义价值后再决定期 B 是否值得。**注意力经济学原则同样适用于此：不为存储而存储。**

---

## 四、期 A 接口与实现

### A1 · 新增 `interrupted` 状态

status 枚举从 `pending | running | completed | failed` 扩展为：

```
pending | running | completed | failed | interrupted
```

- `interrupted` 语义：宿主重启时发现任务仍处于 pending/running，标记 interrupted（**不判死**），等待恢复或人工处置。
- `active_dispatched_task_count` 把 interrupted 视为"不占并发额度"（等同 completed/failed），避免重启后被陈旧任务锁死额度。
- 前端 dispatch 面板新增 interrupted 桶，展示"重启时中断的任务"并提供续接/放弃操作。

### A2 · recovery note 字段

`DispatchedTask` 新增（`#[serde(default, skip_serializing_if = "Option::is_none")]`，向后兼容旧 JSON）：

```rust
/// 重启恢复注记：中断时记录的原 prompt 摘要 + 上下文指针（文件路径 / conversation_id）
#[serde(default, skip_serializing_if = "Option::is_none")]
pub recovery_note: Option<RecoveryNote>,
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryNote {
    /// 中断时间（Unix 秒）
    pub interrupted_at: i64,
    /// 中断时已完成的步骤摘要（由前端节流回报的 latest_activity 末值，若无则为空）
    pub last_activity: Option<String>,
    /// 续接提示：交给 executor 的 recovery 指令文本
    pub hint: String,
}
```

hint 默认文本（对齐 DeepSeek 的 recovery note 语义，但用中文）：
> "应用重启中断了本任务。请先检查工作目录、git 历史与已有产物，确认未重复对外动作后，从中断点继续。"

### A3 · load 改写（`state.rs:936-970`）

把"一律标 failed"改为"标 interrupted + 写 recovery_note"：

```rust
// 伪代码：保留原有解析与错误处理
for mut task in tasks {
    if matches!(task.status.as_str(), "pending" | "running") {
        task.status = "interrupted".to_string();
        task.recovery_note = Some(RecoveryNote {
            interrupted_at: chrono::Utc::now().timestamp(),
            last_activity: task.latest_activity.clone(),
            hint: DEFAULT_RECOVERY_HINT.to_string(),
        });
        // latest_activity 不清空（保留中断前最后动作供面板展示）
    }
    map.entry(task.dispatch_id.clone()).or_insert(task);
}
```

### A4 · 续接能力（最小形态）

不自动续接（避免重启后突然启动一堆后台会话）。提供**手动续接**入口：

- 新增 tauri command `resume_dispatched_task(dispatch_id)` 或走 cap 通道（见批次 A2）：
  - 校验任务状态为 `interrupted`；
  - 用 `conversation_id`（若有）走 continue 路径续接已有会话；无 `conversation_id` 则用原 prompt + recovery_note.hint 重新派发（depth 不变，复用 register_dispatch_task 逻辑）；
  - 续接成功后状态转 `running`，清空 recovery_note；
  - 续接失败转 `failed` + summary 注明原因。

### A5 · roster 中断处理（`nexus_pipeline.rs`）

重启后 roster 成员被标 interrupted 时，**不触发 `on_member_terminal` 推进下一波**（interrupted 不是终态）。新增 `roster_resume` 操作：把整条 roster 中 interrupted 成员批量续接或放弃，由用户在面板决策，不自动推进。

> 边界：不引入 DeepSeek 的 Policy 版本化 / Mandate 重验（Polaris 的 cap 权限 gate 是确定性准入，重启不改变权限模型，无需重验）。

---

## 五、期 A 迁移批次（每批独立可回退，批后跑门槛）

1. **批 A1 · 状态枚举扩展**：`status` 加 `interrupted`；`active_dispatched_task_count` / 前端 dispatch 面板 / dispatchStore 类型同步。旧 JSON 中无 `interrupted` 值，解析兼容（字符串字段，无需迁移）。
2. **批 A2 · recovery_note 字段 + load 改写**：`DispatchedTask` 加字段；`load_dispatched_tasks` 改为标 interrupted + 写 note；新增 `DEFAULT_RECOVERY_HINT` 常量。
3. **批 A3 · 续接入口**：新增 `resume_dispatched_task`（先放 commands/，后续随 cap.dispatch 上总线时再迁）；前端面板加"续接"按钮调用。
4. **批 A4 · roster 中断守护**：`nexus_pipeline` 的 `on_member_terminal` 增加状态判断——interrupted 不推进；面板 roster 视图展示 interrupted 成员。

每批门槛：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + `pnpm exec tsc --noEmit` + dispatchStore/dispatchTaskService 相关 vitest。

---

## 六、期 B · SQLite 升级（可选，期 A 价值验证后再评估）

### 触发条件（满足任一才做）

- 单 JSON 文件读写成为可见瓶颈（任务高频更新导致主线程 Mutex 竞争，可观测到掉帧或 dispatch 延迟）；
- 需要历史归档（当前 100 条上限裁剪即丢失，无法做事后审计/统计）；
- 需要按 source_session_id / roster_id / status 做索引查询（JSON 全量扫描）。

### 设计

- 新建 `dispatch_tasks` 表，字段对齐 `DispatchedTask`（serde ↔ rusqlite 手写映射，参照 `scheduler/sqlite_task_storage.rs`）；
- 路径走 `services/data_root.rs`（DataRoot 抽象），文件名 `dispatch.db`，与 `dialog.db` / `usage.db` 同根；
- 保留 JSON 导出能力（兼容/迁移用）：启动时若 `dispatch_tasks.json` 存在且 `dispatch.db` 不存在，做一次性迁移后重命名 JSON 为 `.bak`；
- 写入仍走 `afterCommit` 模式（参照 `scheduler/sqlite_task_storage.rs` 的事务写）；
- 内存 HashMap 保留为缓存层（读路径不直查 SQLite，写路径双写过渡）。

### 边界（期 B 明确不做）

- 不引入 DeepSeek 的 Effects 副作用队列（Polaris 的状态更新是单写者 + 原子 rename，无多源并发写问题，Effects 层收益不足）；
- 不改 cap 权限 gate（确定性准入无需版本化）；
- 不引入 Subscription/Thread 抽象（P2 spec 处理）。

---

## 七、验收（可执行冒烟）

### 期 A 验收

1. 三门槛全绿（上列）。
2. **中断不判死**：dev 环境派发一个任务 → 任务 running 中杀掉宿主进程 → 重启 → 任务状态为 `interrupted`（非 failed），面板可见 recovery note。
3. **续接可用**：对 interrupted 任务点"续接" → 任务转 running，executor 收到 recovery hint（若已有 conversation_id 则续接而非重派）。
4. **并发额度不锁死**：重启后 interrupted 任务不计入 `active_dispatched_task_count`，新派发可正常占用额度。
5. **roster 不假完成**：roster 中有 interrupted 成员时，下一波不被自动推进；面板可见"中断成员待处置"。
6. **向后兼容**：旧 `dispatch_tasks.json`（无 interrupted / recovery_note 字段）能正常加载，旧任务按原逻辑标 failed（recovery_note 为 None）。

### 期 B 验收（若实施）

1. 三门槛全绿。
2. 迁移正确：旧 JSON 内容完整迁入 SQLite，`.bak` 留存。
3. 性能：高频更新场景下无可见 Mutex 竞争（用 dev 环境压测：连续派发 20 任务 + 高频 status 更新）。
4. 索引查询：按 source_session_id / roster_id 列表查询走 SQL 索引而非全量扫描。

---

## 八、风险

- **R1 · interrupted 语义扩散**：新增状态会被 dispatch 链路多处判断（前端面板、roster pipeline、active 计数、check_dispatched_task 返回）。漏改任一处会导致状态卡死。**对策**：批 A1 集中改所有 `matches!(status, "pending"|"running")` 判断点，grep 全量核对。
- **R2 · conversation_id 续接依赖前端回报**：若前端启动派发会话后未回报 conversation_id（异常退出），续接只能重派而非续接已有会话。**对策**：recovery_note 记录"无 conversation_id，续接将重派"，面板提示用户。
- **R3 · roster 中断后人工决策负担**：interrupted 成员需要人手动续接/放弃，任务多时是负担。**对策**：面板提供"批量放弃 interrupted""批量续接 interrupted"操作（roster_resume 批量入口）。
- **R4 · 期 B 迁移期双写风险**：JSON → SQLite 过渡期若双写不一致可能丢数据。**对策**：一次性迁移（启动时 JSON 存在且 DB 不存在才迁），迁移后 JSON 重命名 .bak 不再写；内存 HashMap 作为过渡缓存层保证读一致。
- **R5 · 协议无运行时 schema 校验（AGENTS.md 已知缺口）**：加 recovery_note 字段是协议改动，须保守保持双边类型同步。**对策**：字段全部 `#[serde(default, skip_serializing_if)]`，前端类型同步加可选字段，旧前端读新后端不崩。

---

## 九、与 DeepSeek 设计的对照说明

| DeepSeek 概念 | 本 spec 对应 | 是否引入 | 说明 |
|---|---|---|---|
| Ticket（工单） | DispatchedTask | 已有 | 字段更丰富，无需改 |
| Assignment（派工） | 派发会话 session | 已有 | 不引入 Assignment 独立生命周期 |
| Effects（副作用队列） | — | 不引入 | Polaris 单写者+原子 rename，收益不足 |
| recovery note | RecoveryNote | **引入**（期 A2） | 核心 |
| interrupted 中间态 | status=interrupted | **引入**（期 A1） | 核心 |
| retry（局部重试） | resume_dispatched_task | **引入**（期 A4） | 手动触发，不自动 |
| Policy 版本化重验 | — | 不引入 | cap 权限 gate 是确定性准入，无需版本化 |
| Subscription fan-out | — | 不引入（P2） | 事件源模型不同，单独立 spec |
| 并发槽 + 1 人消息槽 | 现有 MAX_ACTIVE_DISPATCHES=3 | 不改 | 桌面交互场景无需额外人消息槽 |

---

## 十、下一步

1. 拍板期 A 是否实施（期 B 待期 A 验证后再议）。
2. 若实施，按批 A1→A2→A3→A4 顺序，一批一 commit。
3. 期 A 落地后，据真实使用反馈评估：① interrupted 续接是否被实际使用（若无人续接则价值不足）；② JSON 是否成为瓶颈（决定期 B 优先级）。
