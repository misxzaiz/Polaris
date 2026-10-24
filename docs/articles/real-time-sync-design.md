# 实时同步系统设计：日志即真相

> 一篇面向实时协作场景（AI 会话、协同编辑、多端同步）的系统设计随笔。
> 代码示例的形态与思路参考 Polaris 的 `session-v2` 与 `dialogStorage` 实现，非逐行拷贝。

## 〇、全景：五个小节讲清一件事

实时同步系统常被拆成两个世界：**写路径**（谁在什么时序写、写到哪）与**读路径**（谁如何拿到最新状态、看到不一致怎么办）。本文按这两条主线切成五节：

| 小节 | 解决的问题 | 核心机制 |
|---|---|---|
| 一、日志即真相 | 状态该信谁的 | append-only event log |
| 二、幂等与顺序 | 重复/乱序写入怎么办 | 单调 seq + 写前去重 |
| 三、对账（Reconcile） | 缓存漂移了怎么办 | 全量比对 + 定向修复 |
| 四、状态仲裁器 | 谁有资格改状态 | 状态从日志推导，先仲裁后变更 |
| 五、多端广播 | 别人怎么知道我改了 | 携带 reason 的定向广播 + 写路径收敛 |

## 一、日志即真相（Log Is the Source of Truth）

实时系统的第一性问题是：**真相存哪？** 多数脏读/覆盖错误，都源于"前端状态"被当成真相——多个窗口各改各的缓存，最后写回时互相覆盖。解法是把"状态"降级为**可推导的缓存**，把"写入动作"本身升级为唯一真相：

- 每条写入都是一个**不可变事件**，只追加（append-only），永不修改、永不删除（删除也记成 `deleted` 事件）；
- 状态（会话列表、running 标志、消息数组）不落库，**全部由事件日志推导**；
- 任何人问"现在是什么状态"，答案都是"把日志从 seq 0 回放到 seq N 的结果"。

事件类型先行：

```rust
// models/event.rs —— 会话事件的权威类型
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// 会话创建：携带 creator 与初始 title
    SessionCreated { session_id: String, creator_id: String, title: String, at: u64 },
    /// 消息追加：携带客户端生成的幂等 id
    MessageAppended { session_id: String, message_id: String, content: String, at: u64 },
    /// 会话开始/停止：状态永远只由事件驱动
    Running { session_id: String, device_id: String, at: u64 },
    Stopped  { session_id: String, device_id: String, at: u64 },
    /// 软删除：物理不删，事件留痕
    SessionDeleted { session_id: String, at: u64 },
}
```

日志接口同步建模（对应项目里 `SessionEventLog` 的形态，append 幂等、read 按序）：

```rust
// services/event_log.rs
#[async_trait]
pub trait EventLog: Send + Sync {
    /// 追加事件；相同 event_id 重复追加返回 false（幂等）
    async fn append(&self, event: SessionEvent) -> bool;
    /// 按 seq 升序读出某会话的全部事件
    async fn read(&self, session_id: &str) -> Vec<SessionEvent>;
    /// 从指定 seq 之后续读（resume 增量同步用）
    async fn read_after_seq(&self, seq: u64) -> Vec<SessionEvent>;
}
```

前端把同一世界观搬过来——**前端也是订阅者，不是真相源**。它在内存里只放一份"日志的投影"，任何 UI 操作先走后端 append，收到确认后才推进本地投影：

```ts
// src/session-v2/core/v2-message-log.ts（示意）
export class MessageLogProjection {
  /** 本地投影：UI 读这里，绝不直接改列表 */
  private entries: MessageEntry[] = []

  /** 唯一写入入口：先走后端，拿到 ack 再落投影 */
  async appendUserMessage(content: string) {
    const event = {
      type: 'MessageAppended',
      messageId: crypto.randomUUID(), // 幂等 id 由客户端生成
      content,
    }
    const ok = await rpc.appendEvent(event) // 后端 append-only
    if (!ok) throw new SyncConflictError('append rejected') // 冲突交给对账收敛
    this.entries.push(project(event))
    this.emit('entries', this.entries)
  }
}
```

规律一句话：**谁写谁知道，写前先问仲裁，写后广播带 reason**。事件日志让"并发写"从竞态问题退化为"顺序问题"——下一节处理顺序。

## 二、幂等与顺序：单调 seq 与写前去重

日志方案最常见的返工原因是**没处理重复与乱序**：网络重试导致同一事件写两遍、事件日志在进程间异步复制导致各端 seq 不一致。双管齐下：

1. **单调 seq**：日志落库时由权威端分配全局递增 seq，这是全系统唯一的顺序基准，客户端一律不得自造；
2. **写前去重**：事件自带客户端生成的 `event_id`，追加时 `INSERT ... ON CONFLICT DO NOTHING`，靠唯一索引兜底（存证参见 AGENTS.md「幂等边界」约束——绝不用超时掩盖同步问题）。

```sql
-- migrations/001_event_log.sql
CREATE TABLE event_log (
  seq        BIGINT GENERATED ALWAYS AS IDENTITY, -- 单调递增，权威顺序
  session_id TEXT         NOT NULL,
  event_id   TEXT         NOT NULL,               -- 客户端幂等 id
  event      JSONB        NOT NULL,               -- SessionEvent（tagged enum）
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (seq),
  UNIQUE (session_id, event_id)                    -- 幂等：重复追加静默跳过
);
CREATE INDEX idx_event_log_session ON event_log (session_id, seq);
```

写入路径的幂等判定（示意，可对应 Rust 侧 `EventLog::append` 实现）：

```rust
// services/event_log.rs 实现片段
pub async fn append(&self, event: SessionEvent) -> bool {
    let event_id = id_of(&event);
    // UNIQUE (session_id, event_id) 兜底：并发重试也只会插进去一次
    let inserted = sqlx::query(
        "INSERT INTO event_log (session_id, event_id, event) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, event_id) DO NOTHING RETURNING seq",
    )
    .bind(session_of(&event))
    .bind(&event_id)
    .bind(&event)
    .fetch_optional(&self.pool)
    .await?;
    inserted.is_some() // false = 重复事件，调用方应视为"已成功"而非报错
}
```

读侧的乱序防御交给**投影器**——它只认 seq，写错行序也不怕。这对应项目里 JSONL 编解码的教训（`jsonlCodec` 按 `seq` 排序还原，行顺序打乱也能恢复）：

```ts
// src/services/dialogStorage/jsonlCodec.ts（思路示意）
export function restoreEvents(rows: RawRow[]): SessionEvent[] {
  return rows
    .filter((row) => row.seq != null && row.event != null) // 坏行安全跳过
    .sort((a, b) => a.seq - b.seq)                          // 按 seq 恢复权威顺序
    .map((row) => parseEvent(row.event))
}
```

小节规则：**顺序看 seq、重复看 event_id、坏行只跳过不整体失败**。幂等做到了，下一节的对账才能放心全量比对。

## 三、对账（Reconcile）：缓存漂移的最终裁决

日志再可靠，前端投影也难免漂移：断网期间漏事件、用户改了什么没走后端、进程被杀丢内存。实时系统不该假装永不漂移，而是**承认漂移，并给出一条收敛路径**。对账借鉴银行日终对账：**日志即真相，前端只是缓存，差异触发修复**。

对账只算四样东西——缺的、多的、状态是否不一致、后端真实状态（对齐项目 `reconcile.ts` 的 `ReconcileResult`）：

```ts
// src/session-v2/core/reconcile.ts（核心逻辑）
export async function reconcile(params: {
  messageLog: MessageLogStorage
  arbiter: StateArbiter
  sessionId: string
  clientMessages: MessageEntry[]
  clientRunning: boolean
}): Promise<ReconcileResult> {
  const { messageLog, arbiter, sessionId, clientMessages, clientRunning } = params

  // 1. 拉后端完整真相（由日志回放得到）
  const serverMessages = await messageLog.read(sessionId)

  // 2. 以 id 集合求差集：missing = 前端缺的；extra = 前端多的
  const serverIds = new Set(serverMessages.map((m) => m.id))
  const clientIds = new Set(clientMessages.map((m) => m.id))
  const missing: MessageEntry[] = serverMessages.filter((m) => !clientIds.has(m.id))
  const extra: MessageEntry[] = clientMessages.filter((m) => !serverIds.has(m.id))

  // 3. 状态也以仲裁器为准
  const serverStatus = await arbiter.getStatus(sessionId)
  const statusMismatch = clientRunning !== serverStatus.running

  return { missing, extra, statusMismatch, serverStatus }
}
```

光算出差异不够，还得配**修复策略**——重点在" extra 不删"这条纪律：前端多出的消息可能是未回传成功的本地草稿，直接删是数据丢失；正确做法是 missing 直接合并进来，extra 标记为"待确认草稿"，交给上层续传或揭示。修复与触发时机一起写：

```ts
// src/session-v2/useSyncReconciler.ts（示意）
export function useSyncReconciler() {
  const { entries, applyServerSnapshot } = useSessionStore()

  /** 触发时机：窗口焦点恢复 / 断线重连 / 长轮询 tick（防抖 1s） */
  const run = useCallback(async () => {
    const diff = await reconcile({ messageLog, arbiter, sessionId, clientMessages: entries, clientRunning: running })
    if (diff.missing.length === 0 && diff.extra.length === 0 && !diff.statusMismatch)
      return // 一致，什么都不做——这也是幂等检查点
    applyServerSnapshot({ messages: diff.missing, status: diff.serverStatus })
    // diff.extra 不删除：转存为“待续传草稿”，由写入通道重放
  }, [entries, running])

  return { run }
}
```

对账收敛的三条纪律：**① 只增不删**（missing 补进，extra 不删）；**② 幂等**（无差异即零操作，可反复触发）；**③ 修复走同一写路径**（applyServerSnapshot 内部仍是 append 事件，不是旁路覆盖）。这样对账与正常写入共用一套链路，不会引入第二写路径。

## 四、状态仲裁器（Arbiter）：状态从日志推导，先仲裁后变更

实时系统最容易酿成大事故的是"状态"：两个设备同时点"开始"，或 A 想中断 B 正在跑的会话。直接把 `running` 这类状态当字段存在缓存里，必然出现**双写与误杀**。解药是"状态不存储、由日志推导"，并把所有状态变更请求收口到一个**仲裁器**——源自操作系统内核仲裁的思路：所有状态查询/修改请求都经仲裁器，仲裁器不存状态值，只读日志算结论（对齐项目 `StateArbiter` 接口的注释）。

```rust
// services/arbiter.rs —— 状态仲裁器
pub struct Arbiter<'a> { log: &'a dyn EventLog }

impl<'a> Arbiter<'a> {
    /// 状态从不落库：每次查询都是对日志的确定性回放
    pub async fn get_status(&self, session_id: &str) -> SessionStatus {
        let events = self.log.read(session_id).await;
        let mut running = false;
        let mut running_device: Option<String> = None;
        let mut stopped = false;
        for e in events {
            match e {
                SessionEvent::Running { device_id, .. } => { running = true; running_device = Some(device_id.clone()); }
                SessionEvent::Stopped { .. } => { running = false; running_device = None; }
                SessionEvent::SessionDeleted { .. } => stopped = true,
                _ => {}
            }
        }
        SessionStatus { running, stopped, holder: running_device }
    }

    /// 请求开始：仲裁"当前未在运行"才放行（并发请求只有一个能赢）
    pub async fn request_start(&self, session_id: &str, device_id: &str) -> Result<(), Reject<'static>> {
        let s = self.get_status(session_id).await;
        if s.running { return Err(Reject("already_running")); } // 拒绝而非覆盖
        self.log.append(SessionEvent::Running { session_id: session_id.into(), device_id: device_id.into(), at: now() }).await;
        Ok(())
    }

    /// 请求中断：只有持有设备的 device_id 才有权中断（防误杀无关运行）
    pub async fn request_interrupt(&self, session_id: &str, device_id: &str) -> Result<(), Reject<'static>> {
        let s = self.get_status(session_id).await;
        match s.holder {
            Some(holder) if holder == device_id => { /* 允许 */ }
            Some(_) => return Err(Reject("not_holder")),   // 别人持有：拒绝，绝不越权杀
            None => return Err(Reject("not_running")),
        }
        self.log.append(SessionEvent::Stopped { session_id: session_id.into(), device_id: device_id.into(), at: now() }).await;
        Ok(())
    }
}
```

核心是**"拒绝而非覆盖"**：仲裁失败不是静默改状态，而是带 reason 的显式拒绝（`already_running` / `not_holder` / `not_running`），让调用方能分辨"请求没成功"和"请求成功了但结果不符合预期"。所有前端在发起开始/中断前，都先走 `request_start` / `request_interrupt`，再凭返回的 ok/reason 更新本地投影——状态变更因此有了**唯一权威入口**，晚到的 stop、误杀无关运行这类已知故障（AGENTS.md 明确点名的风险）从结构上被挡掉。

## 五、多端广播：携带 reason 的定向扩散与写路径收敛

最后一块拼图是**扩散**：A 端写入后，B、C 端如何及时感知？常见错误是"每端各写各的 + 全量表格刷新广播"——写路径多了就竞争，广播没有分类就高频整表刷新。正确的姿态：

- **写路径收敛为一条**：所有端都通过同一个 append 通道写入，UI 上看似各改各的，底层全汇到唯一日志；
- **广播只推事件不推状态**：订阅者收到的是带 `reason` 分类的事件（`message.appended` / `status.running` / `session.deleted`），各自更新自己的投影，不整表重拉、不整树刷新。

```ts
// src/session-v2/kernel/broadcast.ts（示意）
type BroadcastReason =
  | 'message.appended' // 增量：只把新条目查到投影
  | 'status.running'   // 状态更新：只动 running 标志
  | 'status.stopped'
  | 'session.deleted'  // 删除：整会话移除
  | 'reconcile.repair' // 对账修复：定向合并 missing

export interface SyncEvent { reason: BroadcastReason; sessionId: string; payload: unknown }

/** 广播入口：写路径唯一通道，携带 reason 携带因果信息 */
export function publish(event: SyncEvent) {
  // 走 cap 总线 / 事件总线；订阅者按 reason 分发到对应 reducer
  bus.emit(event)
}

/** 订阅侧：按 reason 定向更新，绝不整表全量刷新 */
bus.on((e: SyncEvent) => {
  const reducer: Record<BroadcastReason, (s: SessionStore) => void> = {
    'message.appended': (s) => s.upsertMessage(e.sessionId, e.payload),
    'status.running':   (s) => s.setRunning(e.sessionId, true, e.payload as { deviceId: string }),
    'status.stopped':   (s) => s.setRunning(e.sessionId, false),
    'session.deleted':  (s) => s.removeSession(e.sessionId),
    'reconcile.repair': (s) => s.mergeMissing(e.sessionId, e.payload as MessageEntry[]),
  }
  reducer[e.reason](useSessionStore.getState()) // 一次事件只动一个维度的投影
})
```

多端唯一的"状态唯一性"靠**追加日志 + 幂等 id**（第二节）保证，广播与订阅只是通知机制，因此即使广播丢一条，下一轮对账（第三节）也会把它捞回来——**广播是优化，对账才是保证**，二者职责清晰。

## 结语：把"同步"拆成四件事就稳了

- **真相**：append-only 事件日志，谁敢断言状态都以它为基准；
- **顺序与幂等**：单调 seq + 事件自带幂等 id，重复不双写、乱序可还原；
- **收敛**：对账把漂移当常态，只增不删、幂等修复、修复复用同一写路径；
- **权威**：状态由日志推导，变更过仲裁器，"拒绝而非覆盖"。

一句话收束：**写路径收口、状态由日志推导、广播只推事件带 reason、对账兜底收敛。** 实时系统的稳定不靠"不出错"，而靠"出错后必然收敛"。