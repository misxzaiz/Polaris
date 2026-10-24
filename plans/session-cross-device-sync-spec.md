# 跨设备会话同步技术方案（冲突解决 / 增量同步 / 离线补偿）

> 状态：方案（spec）· 2026-10-24
> 读者：会话域 / 前端 / 后端协作
> 关联：`plans/session-multi-device-diagnosis.md`（诊断）、`plans/session-rearchitecture/S3-跨端投影订阅.md`（订阅协议）、S4（仲裁）
> 原则对齐：AGENTS.md §4.2（幂等与顺序）、§4.3（写入路径收敛）、ZCode「日志即真相，前端只是缓存」

---

## 0. 统一模型

跨设备同步不引入新架构，而是把每个设备都当作**同一份 append-only 事件日志（后端 SQLite，`seq` 单调递增）的投影**：

- **写路径唯一**：所有变更（发送 / 修订 / 删除 / 运行态）经 RouterBus 命令入口追加日志，后端分配 `seq`；
- **读路径统一**：前端订阅增量帧并在本地重放，断线用 Outbox 与 resync 补偿；
- **三个子问题**（冲突、增量、离线）均为该模型的派生问题，任何修复都以「本地缓存与日志对齐」为终点。

```text
[设备 A/B] ──命令(幂等键)──▶ CommandInbox(串行 admission + owner/lease)
                                  ▼
                   后端 append-only 事件日志（SQLite, seq）
                                  │ 订阅: 快照 + 增量帧 + gap repair
                        ┌─────────┴─────────┐
                    [设备 A 投影]        [设备 B 投影]
```

## 一、冲突解决

冲突只发生在「并发修改同一资源」，按写入类别分治，后端是唯一仲裁方。

**1. 追加类（发消息 / 事件 append）——天然无冲突。** 日志 append-only，消息用 UUID 唯一标识，互不覆盖；后端以 `INSERT OR IGNORE` 提供幂等，重复追加自然跳过。此类覆盖 90% 流量，不引入任何锁。

**2. 修订类（revise 消息内容 / 改标题）——乐观并发控制 OCC。** `revise` 必须携带 `baseVersion`，后端校验「当前版本 == baseVersion」，不匹配返回 409 并附当前日志尾段。发起端收到 409 后**拉差异 → 本地合并 → 重新提交**，绝不盲目重试（避免覆写远端修改）。合并不可自动完成时，保留双方修订链供用户裁决。元数据字段（标题 / pinned）采用 **LWW**：以后端接收 seq 为准，同 seq 用 `clientId` 字典序打破平局，保证确定性收敛。

**3. 删除类——墓碑 tombstone。** 删除不物理清行，追加 `tombstone` 事件，各端重放后一致消失；墓碑保留 N 天后由后端 GC，兼顾跨端可见与空间回收。

**4. 仲裁归属。** 后端 CommandInbox 对同一会话的命令串行 admission，`owner/lease` 保证同一时刻只有一个写者（发起端）。发送 / 中断收敛到统一入口：非 owner 中断默认拒绝，`requestId` 幂等（重复调用返回原 ticket）。前端对账只做「日志 vs 缓存」差异检测并触发修复，**不作冲突裁决**；现有前端自决（`createConversationStore.ts:1977/2176`）迁移到该入口。

## 二、增量同步

采用「快照 + 增量帧 + seq gap repair」订阅模型，取代现有 1s 轮询兜底。

| 阶段 | 协议 | 语义 |
|---|---|---|
| 首拉 | `session_list_workspace(wsKey)` | 全量投影 + `lastSeq`，快照与后续帧原子（无竞态窗口） |
| 订阅 | `session_subscribe(wsKey, afterSeq)` | 增量帧流，复用 chat-event 通道 |
| 补齐 | `session_subscribe_resync(wsKey, lastSeq)` | gap 超阈值 → 全量；否则按缺失区间拉 delta |

- **seq 校验**：每帧携带单调递增 `seq`；重复帧丢弃，seq 跳跃判定漏帧 → 触发 resync，保证不丢不重。
- **帧路由**：帧按 `topic` 分流（`sessions-index/<wsKey>` / `conversation/<sessionId>`），改造 `eventRouter` 增加 topic 维度；桶未就绪的帧先挂起、就绪后重放，不丢弃。
- **增量粒度**：只同步事件（append / revise / tombstone / 运行态变更），不做整表刷新；流式 token 按 chunk 批量合并为增量帧，压缩带宽。
- **乐观合并**：本端命令先本地应用并打 `pending` 标记，后端帧到达后**以帧为准替换**；帧与乐观状态冲突时帧胜出，避免双份回显与 UI 闪烁。
- **生命周期**：订阅绑定 workspace 桶激活（激活订阅、失活退订）；断线 `SUSPENDED` → 重连 resync 回 `ACTIVE`；移除 `V2SessionKernel.subscribe` 的轮询兜底。

## 三、离线补偿

**Outbox 重放。** 本端命令（发送 / 修订 / 删除）先写本地 pending 队列并乐观渲染；联机后按序重放。每条命令携带幂等键 `clientId + 本地 id`，后端按幂等键去重——**重放绝不双写**，重复到达的帧直接跳过。

**补齐顺序不可颠倒**：resync（拉离线期远端变更，本地缓存与日志对齐）→ 重放 outbox → 对账确认收敛。若先重放，会基于过期快照产生错误合并；resync 期间到达的远端变更帧与本地 outbox 记录共存，重放一律以最新日志为基准。

**重放冲突。** 重放遭遇 OCC 409（离线期间远端已改同一消息）→ 不再盲目重试，转入冲突合并流程；无法自动合并的标记冲突供用户裁决，日志保留双方修订链，可追溯。

**收敛条件**：outbox 清空、`本地 lastSeq == 后端 lastSeq`、reconcile 无 missing/extra → 补偿完成，转正常增量订阅。

## 4. 验收与边界

| # | 场景 | 验收 |
|---|---|---|
| 1 | 桌面新建 / 删除 / 发消息 | web <2s 可见，无需刷新 |
| 2 | 断线 30s 重连 | 增量补齐，不丢不重 |
| 3 | 两端并发 revise 同一消息 | 一方 409 → 合并成功，双修订链可追溯 |
| 4 | 离线发 3 条消息 | 联机重放不重复、顺序正确 |
| 5 | seq 跳跃 | 触发 resync，最终一致 |

- 本方案以**后端 SQLite 为唯一真相**，不覆盖无中心 P2P；协议改动须双向同步 `src-tauri/src/models/ai_event.rs` + `src/types/`（AGENTS.md §4.1）。
- 新增表**禁止触 `PRAGMA user_version`**，一律 `CREATE TABLE IF NOT EXISTS` 幂等补建（`01-评审决策.md` 删库炸弹约束）。
- 实施按 S1 投影 → S3 订阅 → S4 仲裁 → 前端迁移分阶段，每阶段独立可验证，避免一次性大提交后整体回滚。
