# 方案乙：完全重构（立场派：补丁堆积已不可救药，重构会话状态层）

> 来源：多 agent 方案竞选第一轮 · 2026-10-24。基线材料：`../ai-session-problems-audit-2026-10-23.md`、`../ai-session-fix-master-plan.md`。

## 一、二审结论

1. **补丁不同步——确认且更严重**：createConversationStore.ts 实测 2660 行、eventHandler.ts 1186 行 **43 个 case**、sessionStoreManager 955 行。updateQuestionBlock（1079-1147）与 updateFormBlock（1179-1233）有跨 messages[] 搜索；updateToolCallBlock（934-950）/updatePluginCardBlock（1265-1276）/updateAgentRunBlock（1403-1413）均 `if (!currentMessage) return` 无。sendPendingNow 有代际校验、interrupt 5s 定时器（2205-2222）无。**新发现两个补丁不同步实例**：①updateToolCallTaskId（952-964）为乱序打了守卫，同族 updateToolCallBlock 对乱序终态无防护（晚到旧终态可覆盖新状态）；②progressMessage 清理一处三法（session_end 置 null / progress 事件 emoji 前缀启发式 `startsWith('✅')`+工具名模糊匹配 / interrupt 超时与 invoke 失败两条路径不清）——中文或无 emoji 的 progress 文案永不清理；③id 漂移补丁只打前端（sendMessage 预生成 assistantMessageId 2030-2033），后端 FIFO 认领错乱时仍自造 id。
2. **6 套 id——确认为 7.5 套**：①前端 sessionId（本地UUID）；②contextId=session-<①>；③引擎 conversationId（store 内存字段，不持久化不跨端，双入口 eventHandler.ts:355 / createConversationStore.ts:2160）；④Claude 临时 uuid（claude.rs:1245,1265，≠事件流真实 id）；⑤dispatch 合成 id（=④被当真实 id 持久化 dispatch_tasks.json）；⑥session_records/sessions_index（表存在**零生产调用**）；⑦MultiChat mc-；7.5=JSONL 文件名即映射载体。
3. **双数据源+互删——确认**（灾难级成立），且**发现诊断文档低估现存资产**：sessions_index 投影表+upsert/list_after 函数+测试都在 main 上，只是零调用——S1 后端投影底座未被回滚干净，是现成孤儿资产。
4. **session-v2 内核现状——关键事实**：kernel 是「委托壳」（头注自认影子运行，sendMessage/handleEvent/resync 全委托旧 store，唯一走后端的是 getSessionState；resyncSession 快照源是 JSONL）；core/ 1019 行是真实模型（V2MessageLog/V2SessionEventLog/V2StateArbiter 含 requestStart/requestInterrupt(conversationId, deviceId) 仲裁原语）但生产零调用；core 测试 2858 行成熟；UI 接线极浅（SessionMessagesView:75-76 取 kernelStreaming，约 10 个 service 经 kernel 发消息但穿透到旧 store）。**裁定：重构=推广已有内核并从委托壳升级为真内核+激活孤儿资产，不是从零重写；但 kernel 现不含状态机（消息归属/块终态/轮次代际都在旧 store）——约 1500-2000 行 reducer 逻辑是真新写，是最大工作量与风险。**
5. **MultiChat 三件套复用障碍——可行域比 spec 宣称窄**：mc- 前缀成立；config 清单验证的是「轮询可行」非「推送可行」；插件只消费 5 种事件、无归档无对账——证明传输层能穿透，未证明状态与持久化能穿透。主 UI 障碍在路由 key 语义（换前缀实为换身份体系）。

## 二、目标架构

四条铁律：①一个会话一个权威 id（后端 session_records 分配，前端本地 UUID 降为视图实例 id 不进协议）；②一轮一个 turnId（幂等/代际/归属全按 (conversationId, turnId, seq)，禁代理变量）；③一处状态机（kernel reducer per event type，UI/持久化/跨端消费同一归约结果）；④一个写者（消息写路径唯一=后端 SQLite，JSONL 降级为导出格式）。

架构：每端一份 SessionKernel（43 事件→reducer 表，统一 turnId+seq 幂等；turn 状态机；本地 event-log 缓存+reconcile 复用 core/；命令出口带 deviceId）↔ WS/IPC 订阅 {workspaceKey, conversationIds}，信封 {conversationId, turnId, seq, deviceId, type, payload} ↔ 后端 sessions.db 单一 schema owner（session_records/session_messages+墓碑/session_events append-only seq 递增/sessions_index/turn 登记表）+ sessions-changed 推送 + afterSeq 回补 + request_start/interrupt(deviceId) 仲裁。引擎层 temp uuid 不出引擎层。

新旧对照（要点）：路由 key 换权威 id；信封加 turnId/seq/deviceId；状态机从 2660 行 store+43 case 换 kernel reducer 表；块终态统一 upsertBlock 单函数；消息归属 FIFO→turn 登记表；真相源 JSONL+SQLite→SQLite 唯一；会话列表端内 Map→投影+推送；断线恢复→afterSeq 回补统一路径；中断仲裁前端自决→request_*(deviceId)；插件保留 mc- 命名空间，删除 RENDER_EVENT_TYPES 兜底。

## 三、删除清单（要点）

R0 合并 session_db/session_state 双 schema owner；R1 删 FIFO 认领、删 RENDER_EVENT_TYPES 兜底、dispatch 改存真实 id、通知按端过滤；R2 删 createConversationStore（2660）+eventHandler（1186，逐 case 改 reducer）+sessionStoreManager 路由+eventRouter 重写+dedupMessages/内容指纹族+normalizeForInvoke 换行转义+v2-kernel 委托实现（重写为真内核）；R3 删 webReconnectResync 本地兜底；R4 JSONL 降级导出格式、删 saveDialog/前端 dialogStorage 写路径/archive_conversation 自动整写、清 id 残留（保留 conversationId+mc- 两套）；R5 宿主桥收紧。MultiChat 保留不动。

## 四、迁移策略

一次性 importer（R4）：后台扫 dialogs/*.jsonl 幂等导入，成功改名 .migrated 不删；迁移期 JSONL 只读兼容，historyService 改 SQLite 优先；抽样 100 会话逐条比对+双周灰度后删兜底。strangler 但**每阶段结束旧路径立即删除**（与 S1-S5 的区别）；每阶段 config flag 生命周期≤验收期；回滚单位=单阶段；git 考古证实 S1-S5 是 5 层同时动无阶段验收（S3 期间连打 3 个 fix 说明地基未稳）。四条硬约束：①阶段内后端协议冻结；②每阶段独立可运行验收；③数据丢失类问题即停线；④S1-S5 复盘作为 R0 出口条件。

## 五、分阶段交付表

| 阶段 | 内容 | 估算 | 验收 |
|---|---|---|---|
| R0 地基 | 双库合一修互删；turn 登记表+turnId 信封；S1-S5 复盘；协议 spec 定稿 | 1.5 周 | 重启N次不清库；协议评审通过 |
| R1 后端权威会话域 | conversationId 权威化（temp uuid 不出引擎层）；turn 登记表替换 FIFO；sessions_index 激活+sessions-changed；墓碑+删除闭环；dispatch 真实 id；启动清 running | 2 周 | 双会话并发归属100%；删除不复活；A端建会话B端<2s（拉取版） |
| R2 kernel 真内核化（最大风险段） | 43 事件→reducer 表统一幂等+turn 状态机+upsertBlock；三薄 store 替换 createConversationStore+eventHandler；UI hook 层替换；10 个静默 service 切 kernel；审计第四节 20 项前端 bug 随重写消亡 | 3 周 | 全量 vitest 绿+新增 reducer 表驱动测试≥200 用例；单机全场景手测；dogfood 双周无数据丢失 |
| R3 跨端只读跟随（★用户场景） | 订阅协议带会话集；中途加入回补（快照→read_after_seq→reconcile）；WS 三缺口；删 RENDER_EVENT_TYPES；通知按端过滤 | 1.5 周 | **桌面流式中手机打开<2s 全量+实时续流；断网30s回来补齐无缺字** |
| R4 旧路径删除+数据迁移 | JSONL importer；切 SQLite 单源；删 dedup 族/写路径/旧 resync | 1.5 周 | 迁移保真抽样比对；新会话不再产 JSONL |
| R5 双端操作+安全 | request_start/interrupt(deviceId) 仲裁接 UI；宿主桥白名单；WS token | 2 周 | 双端同时发送被串行化 |

**总工期约 11.5 周**（双人并行 ~10 周）；核心场景 R3 出口 ≈ 第 8 周。

## 六、诚实代价与风险

- 对照渐进：到核心场景慢约 4-5 周；到完全同步能力基本持平。R1-R3 约 6-7 周会话域与聊天 UI 新功能全冻结；R2 期间前端会话域 bug 修复只接 P0 类。
- **最大回归风险三处**：①历史数据迁移（importer 出错=不可逆信任损失，缓解：只读兼容+比对脚本+.migrated+灰度）；②消息渲染保真（43 事件的 UI 细节行为考古遗漏，缓解：表驱动 golden 测试+dogfood，预期 2-3 周长尾）；③静默会话族行为漂移（title-generation/commit-message/prompt-optimize/context-compact/dispatch/voiceBroadcast/git 监视等 10+ service 依赖旧 store 语义，无测试密度，缓解：验收显式含回归项）。
- R2 新写 ~3500 行删 ~5000 行，中途资源中断则半新半旧比纯渐进难收拾；core 测试复用率约 40%；本机 cargo test --lib 不可用，后端验收依赖 check+门控+vitest+dogfood。

## 七、为什么值得（根治清单 vs 渐进）

| 根因 | 渐进处置 | 乙的根治 |
|---|---|---|
| 补丁不同步 | 共享工具=仍是约定调用，下个新卡片作者仍可能忘 | reducer 表注册制，违规无处落地 |
| 轮次代际缺失 | turnId 但消费逻辑在旧 store 逐处改 | turn 状态机唯一载体，代理变量不存在 |
| 全端总线vs孤岛 | 双 key 映射=第 7 套映射成新补丁面 | id 单权威，映射层不存在 |
| 乐观更新无事务 | 逐函数补回滚 | 命令层统一事务原语 |
| 幂等外包 | 水位挂旧 handler 43 case 里 | reducer 入口统一验水位 |
| 清理点不收敛 | finalizeTurn 约定四路径调用 | turn ended 转移即唯一清理点 |
| 双数据源 | JSONL 保留且继续加固 | 单一真相，写路径删除 |
| 6 套 id | 映射层继续增多 | 收敛为 2 套（conversationId+mc-） |

资产复用压低成本：后端三表+仲裁原语+seq 通道已存在有测试（R1 大半是接线）；core 模型+2858 行测试直接复用；kernel 能力接口不变；MultiChat 零迁移；43 事件协议不变只加信封字段。

**放弃条件（诚实边界）**：①R2 无法整段保障（<3 周连续窗口）；②复盘发现 S1-S5 回滚是方案性不可行；③冻结期有必须进会话域的硬需求。
