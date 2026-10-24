# 方案丙：标杆参照中型改造（立场派：后端单一真相+前端薄投影+显式订阅）

> 来源：多 agent 方案竞选第一轮 · 2026-10-24。基线材料：`../ai-session-problems-audit-2026-10-23.md`、`../ai-session-fix-master-plan.md`。

## 一、二审结论

1. **kernel 与「日志即真相」差距——确认（两处精确化）**：kernel 四项能力纯委托（v2-kernel.ts:129-209,348-352,366-382），唯一走后端是 getSessionState；消费面 12 个文件但**只消费 isStreaming/error**——kernel 已是主 UI 运行态权威，但对消息真相与事件路由零参与；reconcile/V2MessageLog 只活在测试里。2.10 resyncSession 名不副实确认（snapshotSource=JSONL，v2-kernel.ts:517-519）。
2. **seq/订阅基础设施差距——确认三缺口且比审计叙述更便宜**：Lagged 缺的只是「服务端发控制帧让客户端 resume」信号（replay 缓冲仍保有事件，一行级改造）；afterSeq 读原语**已存在**（session_event_read_after_seq、session_index_list_after_inner，session_state_commands.rs:208-232）只是无前端消费。**审计未列**：订阅无会话维度；信封无设备身份（lifecycle 日志 device_id 恒 "core"）。
3. **turn_persist 离单一真相差距——确认**：覆盖面缺 Plan*/Question/表单/AgentRun/TaskProgress/附件；Error 只 finalize 不落文本；FIFO 全局队列确认（continue 路径有 pending_assistant_ids 缓解，误归属集中在多路并发 start）；无消息级墓碑。前置否定条件：2.1 互删不修则一切无从谈起。
4. **mc- 旁路推广主 UI 障碍——确认四条**：①真正障碍不是前缀而是 **id 分配时序**（首条消息发出时权威 conversationId 还不存在，要等 session_start）；②restoreFromHistory UUID 再生成+conversationId→store 反向索引曾被当「对不准窗口」根因移除，恢复须带白名单约束；③sessions_index 孤儿确认，config 通道（最后写者赢无 CAS）不适用主 UI，须补 sessions-changed 推送；④question_answered 与主链路是两套 key 必须统一。
5. **审计夸大条目——3 条**：E1：4.7「跨端同文本被吞」与 1.1 自相矛盾（A 端事件在 B 端路由层即被丢弃，到不了内容比对去重；缺陷真实但限于本端 scheduler/dispatch/外部回显，严重度应降档）；E2：1.2 场景③比表述窄（仅外部入口携带后端 conversationId 时走兜底）；E3：2.6「刷新丢用户消息」部分夸大（刷新时后端 pending 队列仍存活；必丢的是引擎启动失败或后端同被杀）。

## 二、参照系与映射

R1 唯一写者（zcode）→轮次事实=turn_persist+session_db，组织态=sessions_index，前端 store 降级渲染缓存；R2 日志即真相→session_events(lifecycle)+session_messages(内容)构成可重放日志，reconcile 复用 core/；R3 订阅语义区分（desktop continuous/mobile replayable）→订阅携带会话 key 集，中途加入先 snapshot 再续订；R4 afterSeq gap repair→复用已有读原语补三缺口；R5 仲裁→本方案不启用多端仲裁（保持单写者=发起端），request_start 收敛为 start 排他闸，完整 owner/lease 归 B5 立项。

## 三、改造范围

**保留**：event_broadcaster+seq+resume 骨架、S6/S7、session-v2 kernel（状态查询已接主 UI）+lifecycle 影子写入、AskQuestionCard 范本/待发队列/滚动跟随/权限过期、conversationStore 整体（**不删除**——降级为后端投影的渲染缓存）、WS 形态/cap 契约/插件机制。
**改造**：存储地基（拆库/墓碑/删除闭环/覆盖面/FIFO→配对/首消息即时落库/JSONL 加固）；路由寻址（信封权威化+反向索引带白名单+双 key 过渡+question_answered/plan_approval 修复+兜底收敛为仅本端活跃才投）；会话投影与推送（激活 sessions_index+sessions-changed）；订阅回补（三缺口+resyncSession 改读后端）；终态代际收敛（turnId 信封/findBlockAcrossSession/finalizeTurn/Claude Aborted/启动清 running/SimpleAI 监督）；安全（宿主桥白名单）。
**止血**：IME、regenerate 接线、权限卡反馈、通知过滤、思考块、停止态、复制 toast、草稿串号、回底按钮、后台通知、触屏长按、断线横幅（依赖 P3）、空态等 B6 全量。

与完全重构的本质区别：不删 conversationStore、不重写 eventHandler 30+ case、不重启 S1-S5 的 workspace 分桶/双写同步/统一仲裁。

## 四、核心设计（要点）

1. **权威 id 与映射**：session_start 信封到达时前端注册 conversationId→sessionId 反向索引（事件类型白名单防旧疾复发）；restoreFromHistory 重建索引；eventRouter 双 key（UUID 优先 miss 查索引）。
2. **投影推送**：后端 session_start/end/archive 时 upsert sessions_index；sessions-changed 轻事件走既有广播；前端列表增量刷新。
3. **中途加入回补**：拉 session_messages 快照→对账合并（id+turnId）→续订（seq 水位）；resyncSession 快照源改 message_read；gap 已结束→拉 session_get_status+最终消息。
4. **turnId 协议**：后端 start/continue 生成，信封顶层可选字段；interrupt 定时器/迟到事件/user_message 回显/token 幂等全按 turnId；后端 pending 队列按 turnId 配对（替代 FIFO 弹队首）。
5. **块级终态+finalizeTurn**：findBlockAcrossSession 共享工具改 5 处块更新+append 幂等；单一 finalizeTurn 收敛四条收尾路径。
6. **墓碑与删除闭环**：deleted_at 意图位；删除=interrupt→等 SessionEnd（超时）→tombstone→物理删；turn_persist 重建前查墓碑；Web IPC 补 forget。

## 五、分阶段交付表

| 阶段 | 内容 | 估算 | 里程碑 |
|---|---|---|---|
| P0 止血包 | IME/regenerate/权限卡/编辑防丢/通知/小项 | 1-2 天 | 手测+vitest |
| P1 存储地基 | 拆库/墓碑/删除闭环/JSONL 加固/覆盖面/首消息落库/FIFO→配对/标注 meta | 5-7 天 | M1 数据不丢 |
| P2 后端正确性+协议收敛 | Claude Aborted/清 running/panic 监督/start 排他/turnId/finalizeTurn/块终态/事务化 | 5-7 天 | M2 单机正确 |
| P3 跨端只读跟随 | 权威 id 路由/投影推送/中途回补/三缺口/兜底收敛/resync 改后端 | 6-9 天 | **M3 核心场景：桌面流式中手机打开全量+实时续流；断网补齐；A端答问B端卡片同步消失** |
| P4 打磨+安全 | B6 全量+B7 | 4-6 天 | M4 |

全量 4-6 周，核心场景 3-4 周；**最快路径**（压缩：P1 子集+P2 仅中断统一+P3 全量）约 12-16 工作日出核心场景演示，代价是数据兜底面变薄。

## 六、本方案不能根治的问题（诚实清单）

1. JSONL 双源保留（前端 saveDialog 与后端 archive 并存，靠墓碑+加固使其安全；前端恢复读主路径仍是 JSONL+merge；彻底单源化是下一轮）。
2. 双端同时操作同一会话不做（单写者=发起端；中断无归属保留；S1-S5 根因查清前不碰 B5）。
3. conversationStore 不拆（2500 行巨文件保留；eventHandler 只收敛终态与代际两族；补丁不同步被共享工具收敛而非被架构消灭）。
4. 6 套 id 收敛为 3 套（前端 UUID/权威 conversationId/dispatch id），不追求 1 套。
5. 引擎层缺陷只修不治（traits 抽象与 29 变体历史包袱不动）。
6. 协议无运行时 schema 校验缺口依旧。
7. 插件深度隔离只评估不强制。
