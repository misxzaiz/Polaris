# DeepSeek superagent 对照 · P1 结构化 Report 状态机 spec

> 来源：DeepSeek `dsh-superagent-prototype`（2026-10-31 开源）对照分析。
> 对照对象：dsh-superagent 的 6 种 Report + Attention 结构化问题协议。
> 状态：specd，待拍板。所有者：宿主端 `state.rs` + `services/ask_listener.rs` + `services/nexus_verdict.rs`；前端 `services/dispatchTaskService.ts` + `stores/dispatchStore.ts`。
> 前置：本文与 [[deepseek-superagent-p0-ticket-persistence-spec]] 独立，可单独实施；两者字段同源（都改 DispatchedTask），若同期实施须合并批改。
> 原则：**复用已有 verdict 机制**，不重造结构化裁决；把分散字段收敛成统一 Report 信封。

---

## 一、背景：DeepSeek 怎么做的

dsh-superagent 的 executor 向主 Session 只产 **6 种结构化 Report**（`docs/001-domain.md` Decision/Report 枚举）：

| Report | 语义 |
|---|---|
| `progress` | 进展（中间态，不叫人） |
| `waiting` | 本轮做完等 Trigger（idle，不叫人） |
| `ready` | 结果就绪，可被 review/使用（叫人） |
| `blocked` | 受阻，需要人介入才能继续（叫人） |
| `failed` | 失败，无法继续（叫人） |
| `dropped` | 无需处理（请求不复现/已被取代，静默结束） |

需要人决策时，Report 携带 **`Attention` 结构化字段**——一个具体问题，不是自由文本推断（`docs/003-execution.md` 明确拒绝"从报告自由文本推断 waiting on a person"）。主 Session 据此决定面板展示：`person` 阶段（answer/review/blocked/failed）才占面板首行，`working`/`idle` 不打扰人。

关键设计：**Report 是状态机的转移条件**，不是日志。`ready` + 有 PR = awaiting review；`blocked`/`failed` + 无人消息 = 待人工；人消息到达即释放 blocked/failed 给 executor 继续。

---

## 二、Polaris 现状（2026-11-01 实测）

### 已有结构化裁决（比预期乐观）

`nexus_verdict.rs` 已实现 5 种 verdict schema，**这是现成的结构化结果机制，不重造**：

- `qa-pass`：QA 通过，含 acceptance{passed,failed,total} + evidence + next
- `qa-fail`：QA 失败，含 issues[]{severity,expected,actual,evidence,fix_instruction,file_to_modify} + next
- `qa-verdict`：QA 任务自选 pass/fail（校验时按内层 schema 字段分派）
- `phase-gate`：阶段门，含 criteria[]{name,pass,evidence} + risks + carry_over
- `escalation`：升级报告，含 attempts[] + root_cause + recommendation(reassign|decompose|revise|accept|defer) + impact

派发时设 `resultSchema`（`ask_listener.rs:1101-1107`），完成时从会话末消息提取 verdict 并 `validate`（`nexus_verdict.rs:120-187`），解析状态 `verdict_status: structured|unstructured`，校验失败可自动重试一次（`verdict_retry_done`）。

### 现状短板（本 spec 要治的）

| 短板 | 现状 | 后果 |
|---|---|---|
| **S1 · status 仅 4 态** | `pending \| running \| completed \| failed`（`state.rs:209`，前端 `dispatchStore.ts:15`） | 无法表达"等待 Trigger""受阻""无需处理"；blocked 任务只能塞进 failed 混淆语义 |
| **S2 · status 是自由 String** | `pub status: String`（`state.rs:209`），无枚举约束 | 漂移风险：任何调用方可写任意字符串，前端判断点分散且易漏 |
| **S3 · 三字段分离** | status / summary / latest_activity / verdict / verdict_status 各自独立 | 没有统一 Report 信封；check_dispatched_task 返回拼装散乱，前端面板要同时看 5 字段 |
| **S4 · 无 Attention** | executor 需要人决策时塞进 summary 自由文本 | 无法结构化提取"一个问题"；面板无法区分"人必须决策"vs"普通进展" |
| **S5 · 无 progress/waiting 区分** | running 期 latest_activity 是节流摘要，但本轮做完等 Trigger 无独立态 | 面板把"做完等 Trigger"和"正在跑"都显示 running，打扰人 |
| **S6 · 无 dropped 语义** | 请求不复现/被取代时只能报 failed | 噪音：面板出现"失败"但其实无需人处理 |
| **S7 · DispatchReport 已存在但太薄** | 前端 `DispatchReport` 只有 dispatchId/title/status/summary 四字段（`dispatchStore.ts:42-47`） | 报告入队回流来源会话时丢失 verdict/attention 信息 |

---

## 三、目标

把分散的 status + summary + latest_activity + verdict 收敛成**统一 Report 状态机**，补 DeepSeek 的中间态与 Attention，但**复用 verdict 已有 5 schema** 不重造。

### Report 枚举（对齐 DeepSeek，删并）

Polaris 桌面交互场景下，DeepSeek 6 态映射为：

| Report.kind | 语义 | 是否叫人 | 对应旧 status | 新增 |
|---|---|---|---|---|
| `progress` | 执行中进展（中间态） | 否 | running 的 latest_activity | — |
| `waiting` | 本轮做完，等外部 Trigger/消息 | 否 | — | **新** |
| `ready` | 结果就绪可 review | 是 | completed | — |
| `blocked` | 受阻，需人决策或资源 | 是 | — | **新** |
| `failed` | 失败，无法继续 | 是 | failed | — |
| `dropped` | 无需处理，静默结束 | 否 | — | **新** |

> 删并说明：DeepSeek 的 `ready`（有 PR = awaiting review）在 Polaris 对应 completed + verdict；Polaris 不区分有无 PR，统一 ready。旧 `pending` 不进 Report 枚举（pending 是任务创建后、执行器启动前的内部态，不是 executor 产的 Report）。

### Report 信封结构

```rust
/// 统一执行报告（executor → 主会话）。收敛旧 status/summary/verdict 三字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchReport {
    pub dispatch_id: String,
    pub kind: ReportKind,
    /// 进展摘要（progress）/ 结果摘要（ready）/ 失败原因（failed）/ 中断原因（dropped）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 单行最新动作（仅 progress，面板展示用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<String>,
    /// 结构化裁决（复用 nexus_verdict 5 schema；仅 ready/failed 携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_status: Option<String>,
    /// 人必须决策时携带的一个结构化问题（仅 blocked/failed）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
    pub reported_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReportKind {
    Progress,
    Waiting,
    Ready,
    Blocked,
    Failed,
    Dropped,
}

/// 结构化问题（对齐 DeepSeek Attention：一次一个问题，具体可执行）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attention {
    /// 问题正文（≤200 字，一句话）
    pub question: String,
    /// 问题类型（决定面板渲染：decision=二选一/resource=要资源/clarify=要澄清）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 可选选项（decision 类型时）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}
```

---

## 四、接口与实现

### 4.1 status 字段升级为枚举约束

`DispatchedTask.status`（`state.rs:209`）保持 `String` 存储兼容旧 JSON，但新增校验：

```rust
/// 校验 status 必须为已知值（兼容旧值的入口在 load 时）
pub fn validate_status(s: &str) -> Result<ReportKind, String> { ... }
```

新旧映射（load 时与前端类型同步）：
- 旧 `completed` → `ready`
- 旧 `failed` → `failed`
- 旧 `pending` → 保留 `pending`（内部态，不进 Report 枚举）
- 旧 `running` → `running`（内部态，executor 启动后到第一个 Report 之间）

> `pending`/`running` 是任务生命周期态（非 executor Report），保留在 status 字段；Report 枚举只管 executor 回报的 6 种。status 与 Report.kind 关系：收到 progress/waiting Report 时 status=running；收到 ready/blocked/failed/dropped 时 status 转对应终态。

### 4.2 status 扩展终态

status 枚举（生命周期态）：
```
pending | running | ready | blocked | failed | dropped | interrupted(P0引入)
```

- `blocked`/`dropped` 新增；`ready` 替代旧 `completed`（前端面板"已完成"语义不变，只是内部值对齐 ReportKind）。
- `active_dispatched_task_count`（`state.rs:1054`）只把 `pending`/`running` 算活跃，blocked/dropped/ready/failed/interrupted 都不算。

### 4.3 dispatch_report_status 改造（`dispatchTaskService.ts:71-87`）

前端回报入口从传 `status + summary` 改为传完整 `DispatchReport`：

```ts
// 旧：invoke('dispatch_report_status', { dispatchId, status, summary, latestActivity })
// 新：invoke('dispatch_report_status', { report: { dispatchId, kind, summary, latestActivity, verdict?, attention? } })
```

后端 `dispatch_report_status` 命令接收 Report，按 kind 转换 status 并落盘：
- `progress` → status=running，更新 latest_activity
- `waiting` → status=running（不终态），latest_activity 置"等待触发"
- `ready` → status=ready，提取 verdict（复用 nexus_verdict 提取逻辑）
- `blocked` → status=blocked，存 attention
- `failed` → status=failed，存 attention（若有）
- `dropped` → status=dropped，不叫人

### 4.4 check_dispatched_task 返回结构收敛（`dispatch_mcp_server.rs`）

返回从拼装散字段改为统一 Report 视图：

```json
{
  "dispatchId": "...",
  "status": "blocked",
  "report": {
    "kind": "blocked",
    "summary": "权限被拒：需要文件写入授权",
    "attention": {
      "question": "是否授权写入 D:/path/file？",
      "kind": "decision",
      "options": ["授权", "放弃"]
    },
    "reportedAt": 1735...
  },
  "verdict": null
}
```

> 向后兼容：旧调用方读 `task.status`/`task.summary` 仍可用（Report 字段叠加，不删旧字段）。

### 4.5 面板分桶展示（前端 dispatchStore + DispatchTaskCard）

`DispatchTaskView.status`（`dispatchStore.ts:23`）扩展枚举，面板按"是否叫人"分两区：

- **需人处置区**（置顶）：blocked / failed / ready（有结果待 review）
- **无需打扰区**（折叠）：progress / waiting / dropped

Attention 渲染为一个可点操作的问题卡（decision 类型渲染选项按钮，点击即回传答案 → 转为 input 投递给 executor）。

### 4.6 roster 波次推进规则更新（`nexus_pipeline.rs`）

`on_member_terminal` 判定终态从 `completed|failed` 扩展为 `ready|failed|dropped`（blocked/waiting 不推进）：
- `dropped` 视为"无需处理"，推进下一波（等同 ready 的推进语义）；
- `blocked` 不推进（等人决策）；
- `waiting` 不推进（等 Trigger）。

---

## 五、迁移批次（每批独立可回退，批后跑门槛）

1. **批 P1-1 · Report 枚举与信封类型**：新增 `ReportKind` / `DispatchReport` / `Attention` 类型（Rust + 前端 TS）；status 字段加 `ready/blocked/dropped` 枚举值校验；`validate_status` helper。不改调用方，纯类型叠加。
2. **批 P1-2 · dispatch_report_status 改造**：命令接收 Report，按 kind 转换 status；verdict 提取复用 nexus_verdict；attention 存入 DispatchedTask 新字段。前端 dispatchTaskService 改传 Report。
3. **批 P1-3 · check_dispatched_task 返回收敛**：返回结构加 `report` 字段（旧字段保留兼容）；MCP tool schema 同步更新（`dispatch_mcp_server.rs` 的 inputSchema）。
4. **批 P1-4 · 面板分桶 + Attention 渲染**：DispatchTaskCard 按"需人/无需"分两区；Attention 问题卡渲染 + 答案回传。
5. **批 P1-5 · roster 终态规则**：`nexus_pipeline.rs` 终态判定扩展为 `ready|failed|dropped`；blocked/waiting 不推进。补 vitest。

每批门槛：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + `pnpm exec tsc --noEmit` + dispatchStore/dispatchTaskService/nexus_pipeline 相关 vitest。

---

## 六、边界（明确不做）

- **不改 verdict 5 schema**：qa-pass/qa-fail/qa-verdict/phase-gate/escalation 已成熟，Report 只是把 verdict 作为信封的一个字段收纳，不重构 verdict 校验/提取逻辑。
- **不引入 DeepSeek 的 panel stage 表**（`docs/003-execution.md` 的 person/working/idle 9 档）：Polaris 面板按"需人/无需"两区即可，9 档过细。
- **不引入 Subscription/Thread 抽象**：Attention 答案回传走现有 input/消息投递路径，不引入 Subscription fan-out（P2 spec 处理）。
- **不强制所有 Report 都带 verdict**：只有设了 resultSchema 的派发才提取 verdict；普通派发的 ready Report 只带 summary。
- **不改 cap 权限 gate**：Report 是执行反馈协议，与权限/审计无关。

---

## 七、验收（可执行冒烟）

1. 三门槛全绿（上列）。
2. **6 态可达**：派发任务 → executor 回报 progress（面板"无需打扰"区）→ 回报 ready（面板"需人处置"区，verdict 正确提取）。
3. **blocked + Attention 闭环**：executor 回报 blocked + attention{question, options} → 面板渲染问题卡 → 用户点选项 → 答案投递给 executor → 任务继续（status 转 running）。
4. **dropped 不叫人**：executor 回报 dropped → 面板折叠区展示 → 不出现"失败"红标 → roster 推进下一波。
5. **waiting 不终态**：executor 回报 waiting → status 仍 running → 不占并发额度外的终态槽 → 后续消息到达可继续。
6. **check 工具返回收敛**：`check_dispatched_task` 返回 `report` 字段，旧字段 `status`/`summary` 仍可读（向后兼容）。
7. **roster 波次规则**：成员 dropped → 下一波推进；成员 blocked → 下一波不推进（面板可见"被阻塞"）。
8. **向后兼容**：旧 dispatch_tasks.json（status 为 completed/failed）加载后，completed 映射为 ready，前端面板不崩。

---

## 八、风险

- **R1 · status 枚举迁移扩散**：status 从自由 String 收敛到枚举，会被 dispatch 链路多处判断（前端面板、roster pipeline、active 计数、check 返回、续接入口）。漏改任一处会导致状态卡死。**对策**：批 P1-1 集中改所有 `matches!(status, ...)` 判断点，grep 全量核对；提供 `is_terminal_status()` / `needs_person()` 两个 helper 收敛判断逻辑。
- **R2 · completed→ready 语义迁移**：旧 JSON 与旧前端用 completed，新代码用 ready。**对策**：load 时 completed→ready 映射；check 返回对旧客户端仍输出 completed（兼容层）；前端类型用联合 `'ready' | 'completed'` 过渡一个版本。
- **R3 · Attention 答案回传链路**：用户在面板点选项后，答案如何投递给 executor？现有 input/消息投递路径是否支持带 dispatchId 路由？**对策**：批 P1-4 实施前先验证现有 `continue_dispatched_task` 或 cap.ui.input 能否携带 dispatchId 路由；若不能，Attention 答案先走"注入到来源会话的 pendingReports"（复用 `dispatchStore.takeReports`）由来源会话转述，不直连 executor。
- **R4 · waiting 态与并发额度**：waiting 不终态但仍占 running 槽，若大量任务同时 waiting 会耗尽并发额度。**对策**：waiting 超过 N 分钟（默认 30，复用 STALE_SECS）自动转 blocked + attention"等待超时，是否放弃？"。
- **R5 · verdict 提取时机**：ready Report 才提取 verdict，但 executor 可能在 progress Report 也输出 JSON。**对策**：只在 ready/failed 时提取（复用现有"完成时提取"逻辑，不改时机）。
- **R6 · 协议无运行时 schema 校验（AGENTS.md 已知缺口）**：加 Report/Attention 字段是协议改动。**对策**：字段全部 `#[serde(default, skip_serializing_if)]`，前端类型同步加可选字段，MCP tool inputSchema 更新（批 P1-3）。

---

## 九、与 DeepSeek 设计的对照说明

| DeepSeek 概念 | 本 spec 对应 | 是否引入 | 说明 |
|---|---|---|---|
| 6 种 Report | ReportKind 6 值 | **引入**（删并） | ready=completed+verdict；删 ready 区分有无 PR |
| Attention 结构化问题 | Attention 字段 | **引入** | 一次一问，复用 options 渲染 |
| Report 是状态机转移条件 | status 按 Report.kind 转换 | **引入** | progress/waiting→running；ready/blocked/failed/dropped→终态 |
| panel stage 9 档 | 两区分桶（需人/无需） | 不引入 | Polaris 面板两区足够 |
| "从自由文本推断 waiting" 被拒 | Attention 结构化 | 对齐 | 不从 summary 推断，用 attention 字段 |
| verdict schema | nexus_verdict 5 schema | 复用 | 不重造 |
| DispatchReport（已有） | 扩展为完整信封 | **扩展** | 已存在 4 字段，扩到 7 字段 |

---

## 十、与 P0 的协同

- P0 引入的 `interrupted` 状态本 spec 不动（interrupted 是生命周期态，非 Report kind）。
- P0 的 `RecoveryNote` 与本 spec 的 `Attention` 字段独立：RecoveryNote 是重启恢复注记（任务维度），Attention 是 executor 主动提问（Report 维度）。
- 若 P0/P1 同期实施，批 P0-1（interrupted 枚举）与批 P1-1（Report 枚举）可合并为一次 status 枚举扩展，减少重复 grep。
- P1 的 `is_terminal_status()` helper 应包含 interrupted（interrupted 视为非终态，可续接）。

---

## 十一、下一步

1. 拍板 P1 是否实施（可与 P0 并行，字段独立）。
2. 若实施，按批 P1-1→P1-5 顺序，一批一 commit。
3. 落地后据真实使用反馈评估：① Attention 是否被实际使用（若 executor 从不主动提问则价值不足）；② blocked/waiting/dropped 三态是否被 roster 与面板正确区分。
