# 派发任务 Phase 2 实施记录——"AI 团队协作闭环"

> 状态：**P0 + P1 + P2 已全部实施完成（2026-07-17）**，P3 未启动
> 验证：cargo check（lib/tests/web-only）零错误；tsc 零新增错误；vitest 派发相关 12 测试 + conversationStore 61 测试全绿；MCP stdio 冒烟四工具正常
> 设计原则：**结果找人，而不是人找结果**。派发、进度、结果、下一步全部收敛在来源会话；后台会话只是执行细节。

## MCP 工具（polaris-dispatch，4 个）

| 工具 | 作用 |
|---|---|
| `dispatch_task` | 派发自包含子任务到新静默后台会话，立即返回不阻塞。参数：prompt（必填）、title、workDir、engineId、**role**（队员预设，优先级最高）、**provider**（Profile 名称/id/"official"）、**model** |
| `check_dispatched_task` | 查状态（pending/running/completed/failed）+ 执行中最新动态 latestActivity + 完成摘要 summary |
| `continue_dispatched_task` | 对已结束任务同会话续派（上下文保留）；running 拒绝；深度不变不占新额度 |
| `list_dispatch_targets` | 枚举队员预设/引擎/供应商及模型（不含密钥字段） |

## P0 体验闭环 ✅

- **dispatchStore**（`src/stores/dispatchStore.ts`）：任务实时视图 + pendingReports 报告队列（放 store 不放会话字段 → LRU 驱逐免疫）
- **DispatchTaskCard**（`src/components/Chat/DispatchTaskCard.tsx`）：`chatBlocks/index.tsx` 按 toolName 渲染层替换；三态卡片（执行中 spinner/耗时/最新动作、完成摘要 3 行可展开、失败错误）；操作 = 打开会话 / 中断 / 追加指令 / 让 AI 处理结果；tool_result 解析失败降级通用工具块
- **结果回流三件套**：卡片自动翻转；完成报告入队 → `createConversationStore.sendMessage` oneTimeParts 消费（`formatPendingDispatchReports`，与 pendingBriefing 同通道）；卡片"让 AI 处理结果"一键交办（handOffResultToSource，同时 removeReport 防重复注入）
- **latestActivity**：本地 tool 边界即时更新，后端 ≥3s 节流回报（`dispatch_report_status` 扩展 latestActivity/conversationId 参数）；回报刷新 updated_at → 长任务不被并发陈旧判定误伤

## P1 人机协作 ✅

- **AI 续派**：`dispatch_continue` 帧（running 拒绝→置 running→emit `dispatch-task-continue` 含注册表 conversationId）；前端 `attachDispatchSessionHandler` 抽出复用（session_end 自注销，续派必须重挂）；会话驱逐/重启后凭 conversationId 重建静默会话恢复（历史不加载）
- **用户续派**：卡片"追加指令"输入框 → `continueDispatchedTask`（与 AI 侧同源）
- **用户派发**：`/dispatch [@角色] 任务内容`（ChatInput handleSend 拦截）→ `dispatch_create_task` 命令（共享 `register_dispatch_task` 校验解析；**不 emit 事件**防双执行，前端本地直接走执行路径）
- **策略**：`config.dispatch.policy = auto | ask`（ask 每次派发弹确认，拒绝回报 failed）；`autoInjectReports` 开关；设置 UI = GeneralTab → `DispatchSettingsSection`

## P2 队员预设 ✅

- **数据模型**：`config.dispatch.presets: DispatchPreset[]`（name/engineId/modelProfileId/model/appendSystemPrompt/permissionMode），Rust `models/config.rs` + TS `types/config.ts` 双端
- **设置页**：DispatchSettingsSection 内联 CRUD（保存校验：角色重名、mimo 不支持 Profile）
- **listener 侧解析**（`register_dispatch_task`）：role → `resolve_dispatch_preset`（精确 → 忽略大小写，未命中报错列候选）；provider → `resolve_dispatch_provider`（id → 名称精确 → 模糊唯一，歧义报错列候选，"official" 哨兵）；解析结果写入 DispatchedTask 并随事件下发，前端零判断
- **Profile 继承链**（前端 `resolveModelProfileId`）：'official' → 不传；显式 id 直用；未指定 → 源会话绑定 → 全局激活；mimo 强制官方
- 卡片显示 `{role} · {title}` 与 engine/model 标识

## P3 未启动（后续候选）

后台任务中心（升级现有胶囊统一派发+scheduler+后台会话）、`dispatched_tasks` 持久化 + 历史重跑、链式编排。

## 关键工程决策存档

1. 报告队列放 dispatchStore（驱逐免疫）；一键交办用 removeReport 只清本任务
2. 用户派发命令不 emit 事件，防止与监听器双执行
3. eventRouter 对 `dispatch-` contextId 早退路由（否则被 payload.sessionId 兜底路由到错误会话）
4. session_end reason 是 `'completed' | 'aborted'`，failed 判定用 `reason !== 'completed'`
5. 已知无关失败：pluginDiscoveryService.test 1 例为 HEAD 既有问题（stash 验证过）
