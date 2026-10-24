# AI 会话域修复总体方案（Master Plan）

> ⚠️ **本文档已被取代（2026-10-24）**：经多 agent 二审 + 三方案竞选 + 三评委打分裁决，最终执行方案见 `ai-session-fix-adjudicated-plan.md`（渐进骨架 + 修正条款 + 混合要素）。本文保留作为问题映射与批次纪律的参考底稿；两处已被裁决修正：B4→B3 为伪依赖（核心场景提前到约 2 周）、B1.a 拆库提前到 Day 1。

> 状态：方案规划（待确认后分批实施）· 2026-10-24
> 输入：`plans/ai-session-problems-audit-2026-10-23.md`（约 50 个问题，编号 A.a 引用该文档：一=多端 1.x、二=持久化 2.x、三=后端 3.x、四=前端 4.x、五=UI 5.x）
> 目标：修复全部审计问题；核心场景验收 = **桌面流式对话中，手机/浏览器打开即自动看到同一会话并实时同步输出**（第一档），并为此后完全同步（第二档）打好地基。
> 纪律（S1-S5 回滚教训）：每批独立 spec + 独立提交 + 可验证 + 可回滚；单批 ≤ 5 个主题；绝不一次 17 提交塞入。

---

## 1. 修复策略总原则

1. **依赖驱动排序**：先修地基（存储 → 协议 → 路由），再修楼（跨端能力），最后装修（UI 打磨）。地基不修，上层白做（例：不修 2.1 版本互删，跨端投影随时被清空）。
2. **系统性修复优先于逐个补丁**（「设法做的更好」的落点）：审计第六节的 8 个结构性根因，各用一次根因修复消灭整族症状，而不是把 ~50 个症状各打一个补丁：

| 结构性根因 | 根因修复（批次） | 一次性消灭的症状族 |
|---|---|---|
| 轮次代际标识缺失 | 协议引入 `turnId`（B3a） | interrupt 定时器误杀(4.1)、迟到 token 跨轮污染、user_message 内容比对误杀(4.7)、FIFO 归属错乱(2.9 部分) |
| 块级终态/幂等不统一 | 统一「跨 messages+currentMessage 查找」工具（B3b） | 工具卡永久转圈(4.2)、form/plugin_card 双卡(4.3)、agent_run 残留 |
| 清理点不收敛 | 单一 `finalizeTurn()` 收尾路径（B3c） | progressMessage 卡岛(4.10)、权限卡残留、任务队列残留(4.12) |
| 乐观更新无事务 | 发送/重生成事务化（B3d/e） | 失败丢草稿(5.2)、UI/引擎分叉(4.4)、重生成丢历史(4.5) |
| 双数据源+共库互删 | 拆库 + 墓碑 + 后端权威读（B1/B4c） | 2.1-2.5、2.7、恢复复活一族 |
| 全端总线+端内孤岛 | 后端权威会话 id + 会话投影 + 订阅推送（B4） | 跨端不可见(1.1/1.6)、plugin_card 污染(1.2)、路由必丢(1.3/1.4) |
| 中断协议不统一 | 各引擎补 mark_interrupted→Aborted（B2a） | 「异常退出」误报(3.2)、status 不一致(4.11)、dispatch 误判 failed |
| 静默吞错 | 失败反馈统一模式（B0.3 + B6 全量排查） | 权限卡无反馈(5.6)、保存失败无感知(2.5)、保存/复制静默 |

3. **不破坏已做好的部分**（审计第七节白名单：滚动跟随、待发队列、AskQuestionCard 回滚范本、权限过期机制、OPFS 迁移、WS seq/resume 本体）。
4. **每批门槛**：批前补 mini-spec（本文件 §3 各批即为骨架）；批后 `pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test:run` + `cargo check`（动命令层加 `--no-default-features` 门控）；有后端 schema 改动加 `cargo build --bin polaris-mcp`。

---

## 2. 批次总览

| 批次 | 主题 | 规模估算 | 依赖 | 覆盖审计问题 |
|---|---|---|---|---|
| **B0** | 快速止血包（独立小修，立即可做） | 1-2 天 | 无 | 5.1、5.4、5.5、5.6、1.5、5.11 部分 |
| **B1** | 存储地基：消灭数据丢失 | 4-6 天 | 无 | 2.1-2.10 全部 |
| **B2** | 后端会话核心正确性（中断/并发/id） | 4-6 天 | 无（与 B1 可并行） | 3.1-3.10 |
| **B3** | 协议与前端状态收敛（turnId + 终态收拢） | 4-6 天 | B2a | 4.1-4.12、5.2、5.7、3.11 部分 |
| **B4** | 跨端第一档：只读跟随（**用户核心场景**） | 5-8 天 | B1(a/g)、B3a、B2c | 1.1-1.4、1.6、1.7、2.10 |
| **B5** | 跨端第二档：完全同步（仲裁/双端操作） | 2-3 周，单独 spec | B4 + 复盘 S1-S5 | 1.8、B4 遗留深度项 |
| **B6** | UI/交互打磨 | 3-5 天 | 大部分无依赖 | 5.3、5.8-5.11 其余 |
| **B7** | 安全加固 | 2-3 天 | 无 | 1.9 |

**里程碑**：M1=B0+B1+B2（数据不丢、单机正确）→ M2=+B3（状态不复发）→ **M3=+B4（手机实时看到桌面流式会话）** → M4=+B6/B7（体验与安全达标）→ M5=B5（完全同步）。
**到 M3 约需 3-4 周**；B5 之前需先复盘 S1-S5 回滚原因（见 §5 待决策）。

---

## 3. 批次详细设计

### B0 快速止血包（每项独立提交，互不阻塞）

| # | 内容 | 设计要点 | 验收 |
|---|---|---|---|
| B0.1 | IME 回车拦截（5.1） | `handleKeyDown` Enter 分支加 `e.nativeEvent.isComposing` 判断（参照同文件 :1467 方向键自家写法） | 中文输入法组词回车只上屏不发送；vitest 补用例 |
| B0.2 | 重新生成按钮接线（5.5） | `SessionMessagesView.tsx:221` messageActions 补 `onRegenerate`，从 SessionCell 传入；后端 kernel/store 已就绪 | 助手消息出现重新生成按钮，点击走 regenerate |
| B0.3 | 权限/计划卡失败反馈（5.6） | 对齐 AskQuestionCard 范本：catch → 回滚卡片状态 + toast；灵动岛同修 | 提交失败有提示，卡片可重试 |
| B0.4 | 流式中编辑防丢字（5.4） | 流式中禁用编辑按钮 + tooltip「回复中暂不可编辑」；保底 editAndResend 不再静默 return（加提示） | 流式中点编辑有明确反馈，不再无声丢输入 |
| B0.5 | 桌面通知按端过滤（1.5） | `lib.rs` 中继的 session_end 通知：仅当该会话由本端发起（或本端有对应 store 映射）才弹 | 手机跑完，桌面不弹通知 |
| B0.6 | 小项：思考块标题区分 isStreaming（5.11）；停止按钮「正在中断」disabled 态（5.11）；复制失败 toast（5.11） | — | 手测清单 |

### B1 存储地基：消灭数据丢失（最高优先，最先实施）

| # | 内容 | 设计要点 | 验收 |
|---|---|---|---|
| B1.a | **messages.db 拆库**（2.1） | `session_db`（消息）保留 `messages.db`；`session_state`（投影/事件）改用独立 `state.db`。各自 user_version 从此不冲突。旧共用数据不迁移（本就被反复清空，无价值）；`ensure_index_schema` 幂等补建语义保留。**推荐拆文件而非统一入口**：改动小、风险低、一次到位 | 重启 N 次后 session_messages 仍在；`recover_pending_turns` 真实生效；cargo check + 门控 |
| B1.b | JSONL 写入加固（2.4/2.5） | tmp 名加 pid+uuid 后缀；写后 `sync_data`；Windows 用 replace-then-retry（`ReplaceFileW` 或 remove+重试环）；启动时回收残留 tmp；写失败（前后端）上抛用户可见 toast（不只 log） | 并发双写压力测试不丢文件；模拟磁盘满有用户提示 |
| B1.c | 删除会话闭环（2.2） | 删除入口改为：interrupt → 等 SessionEnd（带超时）→ conversation 级 tombstone → 物理删 JSONL + SQLite 行 + index；Web IPC 路径补 forget；tombstone 使晚到 Token/SessionEnd 不再重建 | 删除流式中的会话不再复活；web/桌面行为一致 |
| B1.d | SQLite 墓碑（2.3） | message 表加 `deleted_at` 意图位；regenerate/editAndResend/删会话统一下 tombstone；`mergeBackendMessages` 按墓碑过滤、不再盲目尾部追加 | regenerate 后旧回答不再复活；恢复会话位置正确 |
| B1.e | 用户消息归属确定性（2.9 FIFO + 4.7 前半） | 弃全局 FIFO：pending 队列按 `contextId`/请求标识配对归属（与 B3a turnId 衔接，过渡期用 contextId）；continue 链路补传 clientMessageId/assistantMessageId | 双会话并发发消息，归属 100% 正确；>4 路不丢 |
| B1.f | 一次性会话不落盘（2.8） | `saveDialog` 增加 kind 门控（title-generation/compact 跳过）；deleteSession 同步删 JSONL | 历史列表不再出现「生成标题」垃圾条目 |
| B1.g | turn_persist 覆盖面（2.9，为 B4 回补铺路） | 补落：Plan*、Question/PermissionRequest、表单卡、AgentRun 终态、错误文本、附件引用；`Error` 事件生成持久化错误消息行 | 中途关闭客户端，恢复后 plan/表单/错误信息完整 |
| B1.h | 首轮消息即时落库（2.6） | `record_user_request` 立即 flush 用户消息（不等首个引擎事件）；pending 队列先落库再消费 | 发出消息后立即崩溃/刷新，会话与用户消息仍在 |
| B1.i | 标注可再生（2.7） | 置顶/星标/归档/颜色/标签写 JSONL meta（index 重建时可恢复）；重命名即时落 meta+index | index 重建后标注不丢；重命名后立即退出不回退 |

### B2 后端会话核心正确性（可与 B1 并行）

| # | 内容 | 设计要点 | 验收 |
|---|---|---|---|
| B2.a | **中断协议统一**（3.2，改动小收益最大） | Claude 补 mark_interrupted → `SessionEnd(Aborted)`（抄 opencode.rs:1393-1422 范式）；SimpleAI 中断路径补 reason、去重复 session_end；此后前端逐步拆除 isInterrupting 掩盖逻辑（B3 收尾） | 任一引擎点停止 → Aborted 而非 error；不弹「异常退出」；dispatch 不误判 failed |
| B2.b | start 返回真实会话 id（3.1） | 首选：`session_start` 事件后回写 dispatch 注册表 conversation_id；或 start 响应带真实 id。临时 uuid 不再持久化 | 重启后 dispatch「追加指令」可恢复 |
| B2.c | 运行态真实性（3.4/3.5） | 启动时清理未配对 running（session_start 无 end 的行补 end(interrupted)）；SimpleAI 覆写 has_active_session；CLI 类引擎自然退出清 SessionManager 条目 | 强杀后端重启，会话不再永久 running；is_session_active 双向准确 |
| B2.d | SimpleAI panic 监督（3.6） | spawn 包 catch_unwind/JoinHandle 监督 → panic 转 error 事件 + session_end | 注入 panic 测试：前端收到错误而非永远转圈 |
| B2.e | continue 错配防护（3.3） | 会话↔引擎绑定校验：不匹配时显式报错事件，**删除 try_interrupt_all / 空历史静默兜底**两条危险路径 | 错配场景收到明确错误，无误杀/失忆 |
| B2.f | start 排他（3.8） | 同 conversation 的 start 也走 session_try_start（与 continue 同闸） | 双击不产生双流 |
| B2.g | 注册表锁瘦身（3.7） | 锁内不做子进程探测/sleep；CLI 探测提前缓存或移出锁外 | 多开时停止不被启动阻塞（手测） |
| B2.h | 晚到 stop 不覆盖 completed（3.10）+ stop 超时；流式通道满时退避重试而非丢弃（3.9，try_send 满转 bounded await/丢弃计数告警） | — | 中断/慢消费场景状态语义正确 |

### B3 协议与前端状态收敛（依赖 B2.a；协议改动走双向同步纪律）

| # | 内容 | 设计要点 | 验收 |
|---|---|---|---|
| B3.a | **协议引入 `turnId`**（4.1/4.7/4.6 家族根因） | 后端每轮生成 turn_id 贯穿该轮全部事件（信封层加字段，向后兼容可选）；前端 store 按 turnId 归属：interrupt 定时器只对本 turn 生效、迟到 token 按 turnId 归档或丢弃、user_message 回显按 turnId+clientId 判定（删除内容比对）、token 幂等按 (turnId, seq) 水位 | 打断后 5s 内追问不被截断；换行归一化不再引起双渲染/误杀；重放不重复 |
| B3.b | 块级终态统一（4.2/4.3） | 抽共享工具 `findBlockAcrossSession(messages, currentMessage, blockId)`；updateToolCallBlock/updateFormBlock/updatePluginCardBlock/updateAgentRunBlock 与 appendXxx 幂等全部改走它（对齐 question 已修范式） | session_end 后到达的 end 事件正确回写历史块终态；无幽灵双卡 |
| B3.c | `finalizeTurn()` 收敛（4.10/4.12/4.3） | 单一收尾函数统一处理：progressMessage、权限卡过期、pendingTaskCreates flush、isStreaming/isInterrupting 复位；session_end / interrupt 兜底 / invoke 失败 / error 四条路径全部走它 | 灵动岛不残留转圈；权限卡随轮失效 |
| B3.d | 发送事务化（4.4/5.2） | sendMessage 失败：回滚乐观 addMessage + 恢复输入草稿；ErrorBanner 重试改为「重发失败那条（含附件）并替换原条目」而非追加 | 失败不丢字、不重复、附件保留 |
| B3.e | 重生成/编辑事务化 + 后端截断（4.5/5.7） | 先备份被删消息，失败恢复；成功路径调后端 fork/truncate（若引擎无能力则明确 UI 提示「引擎上下文未截断」——诚实优先）；与 B1.d 墓碑衔接 | 失败不丢历史；成功后引擎上下文与 UI 一致（或明确告知边界） |
| B3.f | interrupt 链路加固（4.9/4.8） | interrupt invoke 加超时；conversationId=null 窗口给提示「会话启动中，稍候可停止」；`sendPendingNow` 不再持锁贯穿 await interrupt；补首轮看门狗（session_start 超时反馈） | 后端死亡时 UI 可恢复，待发队列不死锁 |
| B3.g | 状态一致性（4.11） | session 元数据 status 判定与 eventHandler 统一（isInterrupting/turn reason 归一）；saveDialog 失败 toast | 中断后列表不显示「错误」 |
| B3.h | 协议清理（3.11 顺势） | 借 turnId 落地：SessionEnd.reason 必填化；`type` 双打标收敛其一；废弃事件（Result 通道）标记 deprecated 不再发送；语义重复对（Token vs AssistantMessage）在文档中定唯一权威通道 | 前端 eventHandler 可删兼容分支；无行为回归 |

### B4 跨端第一档：只读跟随（用户核心场景，里程碑 M3）

> 设计基线：复用已被 MultiChat MVP 验证的三件套——后端权威 id 寻址（对应 `mc-` 前缀教训）、config/投影清单同步、chat-event 广播。本批把它做进主会话 UI。

| # | 内容 | 设计要点 | 验收 |
|---|---|---|---|
| B4.a | **路由 key 改后端权威会话 id**（1.1） | 信封 contextId 从 `session-<端本地UUID>` 改为 `session-<引擎conversationId>`（后端已有，跨端同构）；前端 store 建立本地 UUID ↔ conversationId 映射（session_start 时注册）；过渡期 eventRouter 双 key 兼容 | 两端打开同一会话，事件双方都能路由；互不丢弃 |
| B4.b | 会话列表投影 + 推送（1.6） | 激活 S1 已有的 `sessions_index`（现为孤儿表）：`session_list_workspace` 命令 + 新会话/状态变更写投影；新增轻量 `sessions-changed` 广播（复用 event_broadcast 通道），各端列表增量刷新 | A 端新建会话，B 端列表 <2s 自动出现 |
| B4.c | **中途加入回补 + WS 三缺口**（1.7/2.10） | 打开 running 会话：拉后端 session_messages（依赖 B1.g 覆盖面）→ 对账合并 → 订阅后续流（seq 水位对齐）；WS 补：Lagged 触发主动 resync、重载 lastSeq=0 时拉投影快照、gap+已结束拉最终态；`resyncSession` 真正接后端读（修 2.10 名不副实） | **桌面流式中，手机打开 → 看到已生成全部内容 → 实时续流；断网回来自动补齐** |
| B4.d | plugin_card 兜底收敛（1.2） | 外部入口事件带 conversationId 可匹配（B4.a 后天然解决）；兜底改为「仅当事件来自本端且存在活跃 store」才投递，跨端卡片走正常路由 | 其他端的卡片不再串入本端会话 |
| B4.e | 丢失路由修复（1.3/1.4） | `question_answered` 信封改用与 B4.a 一致的权威 id；`plan_approval_result` 去掉硬编码 `main`，回路由到发起会话 | A 端回答问题，B 端卡片同步消失 |

### B5 跨端第二档：完全同步（单独 spec，先复盘）

前置：**查清 S1-S5 2026-10-14 被整体回滚的真实原因**（git 原提交 diff 分析 + 用户侧知情）。范围：双端可操作同一会话（发送/停止/回答卡片）、CommandInbox 串行 admission + owner/lease 仲裁（1.8）、workspace 分桶、afterSeq gap repair 完整化。**本批不进入 M3 承诺，单独立项。**

### B6 UI/交互打磨

| # | 内容 |
|---|---|
| B6.1 | 草稿串号：switchSession 取消挂起防抖（5.3） |
| B6.2 | Web 断线横幅 + 自动恢复进度提示（5.10，依赖 B4.c） |
| B6.3 | 回到底部常驻按钮接线（激活死代码 ScrollToBottomButton）+ 脱离跟随提示（5.11） |
| B6.4 | 后台会话完成通知（系统通知/消息中心）+ 权限/表单待处理徽标（5.9） |
| B6.5 | 移动端：长按呼出消息操作菜单替代 hover（5.8） |
| B6.6 | 空态引导接线（激活 EmptyState）+ 输入长度上限 + 流式附件/斜杠命令反馈修正（5.11） |
| B6.7 | 语音「停止」实现 or 移除该命令（5.11）；删除消息 UI 入口（5.11） |
| B6.8 | 评估拆分 ChatInput.tsx（2090 行）：仅当本批触碰量大时顺势拆（AGENTS.md 拆分克制原则） |

### B7 安全加固（1.9）

- 宿主桥白名单包装：`__POLARIS_HOST_INVOKE__` 按插件 manifest 声明的 permissions 过滤；`__POLARIS_HOST_LISTEN__` 按插件会话前缀过滤事件（只听自己的）。
- 插件面板隔离评估：iframe/独立 origin 加载 vs 现同源 Blob import（涉及插件生态兼容，单独评估后定）。
- WS 部署 token：未配置时降级为仅本机回环可连，或启动警告。

---

## 4. 全量问题覆盖对照（审计编号 → 批次）

| 审计编号 | 批次 | 审计编号 | 批次 | 审计编号 | 批次 |
|---|---|---|---|---|---|
| 1.1 | B4.a | 2.6 | B1.h | 4.1 | B3.a |
| 1.2 | B4.d | 2.7 | B1.i | 4.2 | B3.b |
| 1.3 | B4.e | 2.8 | B1.f | 4.3 | B3.b |
| 1.4 | B4.e | 2.9 | B1.e+g | 4.4 | B3.d |
| 1.5 | B0.5 | 2.10 | B4.c | 4.5 | B3.e |
| 1.6 | B4.b | 3.1 | B2.b | 4.6 | B3.a |
| 1.7 | B4.c | 3.2 | B2.a | 4.7 | B3.a |
| 1.8 | B5 | 3.3 | B2.e | 4.8 | B3.f |
| 1.9 | B7 | 3.4 | B2.c | 4.9 | B3.f |
| 2.1 | B1.a | 3.5 | B2.c | 4.10 | B3.c |
| 2.2 | B1.c | 3.6 | B2.d | 4.11 | B3.g |
| 2.3 | B1.d | 3.7 | B2.g | 4.12 | B3.c/B6 |
| 2.4 | B1.b | 3.8 | B2.f | 5.1 | B0.1 |
| 2.5 | B1.b | 3.9 | B2.h | 5.2 | B3.d |
| — | — | 3.10 | B2.h | 5.3 | B6.1 |
| — | — | 3.11 | B3.h+B2.a | 5.4 | B0.4 |
| — | — | — | — | 5.5 | B0.2 |
| — | — | — | — | 5.6 | B0.3 |
| — | — | — | — | 5.7 | B3.e |
| — | — | — | — | 5.8-5.11 | B6 / B0.6 |

**审计 50 项全部映射，无遗漏。**

---

## 5. 验证、提交与回滚纪律

- **每批一 mini-spec**（引用本文件 §3 对应条目，补接口细节与验收清单）→ 实现 → 验证 → 分主题提交（commitlint）。
- **验证矩阵**：前端 `tsc --noEmit` + `pnpm lint` + `pnpm test:run`（每批为所修族补测试：如 B3b 补「归档后 end 事件」用例，对齐已有 toolCallDedup 测试形态）；后端 `cargo check` + 门控 + （动 MCP schema 时）`cargo build --bin polaris-mcp`；跨端批（B4）加双端手测脚本清单（M1-M5 场景复用 MultiChat spec 验收形态）。
- **数据迁移类改动**（B1.a/b/d/i）：先写迁移/兼容代码，验证旧数据可读，再删旧路径；一次性开关灰度（config flag）可选。
- **回滚**：每批 ≤5 主题独立提交，任一主题回归可单独 revert，不牵连整批。

## 6. 待用户决策项

1. **S1-S5 当初为何整体回滚？**（用户若知情可直接告知；否则 B5 启动前先做 git 考古）——影响 B5 是否照原 spec 重做。
2. **B1.a 拆库方案**：推荐拆文件（state.db 独立）；如倾向「统一单入口管理 schema」也可，但改动面更大。
3. **B5 完全同步是否要做**：若第一档（M3）已满足主场景，B5 可降级为「按需立项」。
4. **移动端优先级**：B6.5 触屏操作、B6.2 断线横幅对手机体验影响大，是否提前到 B0/B4 间插入。
