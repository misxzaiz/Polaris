# 方案甲：渐进加固（立场派：反对大规模重构）

> 来源：多 agent 方案竞选第一轮 · 2026-10-24。基线材料：`../ai-session-problems-audit-2026-10-23.md`、`../ai-session-fix-master-plan.md`。

## 一、二审结论（独立源码复核）

1. **messages.db 互删（2.1）——确认，且比审计更严重**：`session_messages.rs:24-26` 与 `session_state_commands.rs:28-30` 同文件；`session_db.rs:30` v1 vs `session_state.rs:50` v2，各自版本不符删库重建。补充发现：**每轮聊天都触发**——`ai_chat_core.rs:1072-1090` 对每个 SessionStart/SessionEnd 调 `append_session_event` 开 state 库。Windows 下 remove_file 对被占文件失败（`let _ =` 吞错），state 库在原文件补建表并覆写 user_version=2 → 下次重启消息库开库整库全清。净效果 = 每次重启丢全部 SQLite 数据。修复前**每天都在丢数据**。
2. **路由 key 端本地 UUID（1.1）——确认**：`sessionStoreManager.ts:86,122`、`createConversationStore.ts:2122`、`ai_chat_core.rs:1135-1147`、`eventRouter.ts:33-40`、`sessionStoreManager.ts:573`、`historyService.ts:470-474`。
3. **plugin_card 兜底污染（1.2）——确认（一处小出入）**：兜底仅在该端存在活跃会话时投递且只限卡片类事件；多端同开（恰是用户核心场景）下定性准确。
4. **Claude 中断=error（3.2）——确认**：`claude.rs:1048-1077`，全文零处 mark_interrupted；对照 `opencode.rs:1393-1408`。`ai_chat_core.rs:1962-1968` 中断后只影子写 aborted 不发 AIEvent。
5. **interrupt 5s 定时器代际（4.1）——确认**：`createConversationStore.ts:2205-2222`，句柄未保存，代际校验只防切会话。
6. **归档后工具卡永久 running（4.2）——确认**：`updateToolCallBlock:934-938` 无跨 messages 搜索；对照已修 `updateFormBlock:1179-1233`。
7. **sessions_index 孤儿（B4.b 前提）——确认+细化**：表+命令链（`session_state_commands.rs:208-238`、`lib.rs:1184-1187`、`ipc.rs:455-458`）装配完毕，全仓零调用。**不是没做而是未接线**，后端成本低于主计划观感。
8. **审计夸大/出入**：①2.1「乒乓」实为「共存放行→重启单次全清」，净伤害相同；②1.7 缺口3 更深：`webReconnectResync.ts:53-73` 只遍历本端 stores 已有会话，跨端会话不在候选集——发现机制必须独立于本地 store；③3.8 属实但桌面主 UI 走 commands/ 旧命令层，旧路径另有闸需核对；④5.5 确认。无推翻项。

## 二、对现有主计划的批判

1. **B4→B3 依赖是伪依赖**：只读跟随按 conversationId 订阅即可，与轮次代际正交。M2 排在 M3 前白白推迟用户场景 4-6 天。
2. **B4.a 选型过重**：改 contextId 为权威 id 牵动 sendMessage 双 key/eventRouter/映射注册，且 Claude start 先返 temp id 使映射时序微妙——这是 S1-S5 思路原样重启。已验证的更轻路径：MultiChat「原始 chat-event 订阅+contextId 过滤」完全旁路 conversationStore，主 UI 可复制此范式先交付场景。
3. **B1.a 紧迫性被低估**：每轮聊天都在触发 state 库开库，应是最先做的第一件事。
4. **B3.a 工作量低估**：turnId 信封层正确，但前端消费侧（定时器/去重/水位）牵动 2535 行 store 与多个测试，4-6 天偏乐观，实际 5-7 天。
5. **B2.e 违背渐进原则**：无观测先砍兜底不对，应先加告警事件观察错配频率。
6. **1.7 缺口2 应提前到 B0**（传输层一行级改动）。
7. **B0.5 通知过滤在 B4.a 前只能做近似**（本端有 store 映射才弹），spec 应注明。

## 三、最终方案（批次表）

| 批次 | 内容 | 关键设计决策 | 估算 | 验收 |
|---|---|---|---|---|
| **甲0 止血** | IME(5.1)、regenerate 接线(5.5)、权限/计划卡失败反馈(5.6)、流式编辑防丢(5.4)、通知近似过滤(1.5)、WS 重载 resume(1.7缺口2)、思考块/停止按钮小项 | 通知过滤=本端有 store 才弹（近似，spec 注明） | 2-3 天 | 手测+vitest |
| **甲1 存储地基** | 拆库(2.1)、JSONL 加固(2.4/2.5)、删除闭环(2.2)、墓碑(2.3)、首轮即时落库(2.6)、一次性会话门控(2.8)、标注可再生(2.7) | 拆文件一行级不迁数据；**不做** FIFO 重构（推迟甲4）；覆盖面只做最小子集（错误文本+工具卡终态） | 4-5 天 | 重启5次数据在；删除/再生不复活 |
| **甲2 后端正确性（轻量）** | Claude Aborted(3.2 抄 opencode 范式)、启动清 running(3.4)、SimpleAI has_active+panic 监督(3.5/3.6)、start 排他(3.8)、dispatch 真实 id(3.1) | 3.3 错配**降级为加告警事件**不删兜底；3.7 锁瘦身延后甲6 | 3-4 天 | 停止→Aborted；强杀重启无永久 running；双击不双流 |
| **甲3 只读跟随（★用户场景）** | 「手机实时看桌面流式」：running 会话发现+回补+实时流，**旁路 conversationStore** | 新增 `RemoteSessionFollower`（范式=MultiChat stream.ts 已验证）：发现=轮询 `session_event_read_after_seq/current_seq` 推导 running（不依赖本端 store，修正缺口3认知）；回补=`message_read(conversationId)`；实时=原始 chat-event 按 payload.sessionId 归集（不进 eventRouter/store，零侵入）；呈现为远端会话面板（列表+只读流式视图） | 4-6 天 | 桌面流式中手机打开→<2s 见会话→点开见全部→实时续流；断线自动补齐 |
| 甲3b 会话投影 | 激活 sessions_index(1.6) | 写路径挂 `append_session_event` 同点一处；推送=event_broadcast 新增 sessions-changed；前端列表增量刷新 | 2-3 天（与甲3并行） | A 端新建 B 端 <2s 出现 |
| **甲4 状态收敛**（原 B3） | turnId、块级终态统一（findBlockAcrossSession）、finalizeTurn、发送/重生成事务化、interrupt 加固、FIFO 归属 | turnId 只加信封层不动 AIEvent 枚举；前端容忍缺失回退现行逻辑 | 5-7 天 | 打断后追问不截断；工具卡不永久转圈；失败不丢草稿 |
| 甲5 主路由正典化（原 B4.a/d/e） | contextId 改权威 id+双 key 过渡、plugin_card 兜底收敛、question_answered/plan_approval 修复（去硬编码 main，`ai_chat_core.rs:2350,2398`） | 复用甲3 经验；完成后 Follower 降级为后备视图 | 4-6 天 | 两端同会话事件可路由；卡片不串会话 |
| 甲6 打磨+锁瘦身 | B6 全量+3.7 | 断线横幅依赖甲3 | 3-5 天 | 手测清单 |
| 甲7 安全（原 B7） | 宿主桥白名单、插件隔离评估、WS token | — | 2-3 天 | 插件只听自己前缀 |

## 四、里程碑时间线

第1周：甲0（Day1-3）→ 甲1（Day3-8）；第2周：甲2（Day6-9 并行）→ 甲3+甲3b（Day9-14）；**★M2 ≈ Day14（约2周）用户核心场景交付**；第3-4周甲4（M3）；第5周甲5（M4）；之后甲6/甲7（M5）。
**最快路径**：主计划 3-4 周 → 方案甲压缩到约 2 周。硬前置只剩甲1拆库与甲2的3.4/3.5。

## 五、本方案无法根治的问题（诚实清单）

1. 传输层全端总线无寻址（带宽/CPU 浪费保留，S3 级订阅寻址不做）。
2. 端内孤岛状态模型保留：双端**同时操作**同一会话无结构性仲裁（B5 领域不承诺）。
3. 6 套 id 体系只收敛信封 key，temp uuid/dispatch id/别名映射仍在。
4. JSONL+SQLite 双数据源保留（诊断方案C不做）；2.4 竞态只降低未归零。
5. 协议 29 变体三族混流只做 deprecation 标记。
6. 插件面板同源非沙箱只做白名单，iframe 隔离只评估。
7. 3.3 错配先可观测不删兜底。

## 六、风险与回滚

每批独立 mini-spec+分主题提交（≤5）+全量门槛；甲1 拆库一行级回滚；**甲3 纯增量旁路**（新组件+面板，不改现有任何行为，回滚=不渲染面板主链路零影响）；turnId 可选字段双保险；甲5 双 key 天然支持停中间态，进入条件=S1-S5 回滚原因考古完成；数据迁移类先兼容读再切写。
