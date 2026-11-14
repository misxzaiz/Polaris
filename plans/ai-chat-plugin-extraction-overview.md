# AI 对话域插件化 · 评审总览

> 一页版摘要。完整 spec：`plans/ai-chat-plugin-extraction-spec.md`（2026-11-14，待评审）。

## 提案一句话

把整个 AI 对话域（Chat UI 26k 行 + conversationStore 7k + session-v2 3k + 对话服务 4k + 前端 ai-runtime/engines 8k ≈ **40k 行**）出仓为插件 **chat-desk**；宿主保留统一总线运行时（cap.ai.chat / cap.session / 引擎注册表 / 供应商管线 / 存储引擎），并在会话生命周期、引擎选择、供应商解析、消息落盘、流事件五个管线位暴露 **hook**（v1 observe-only）。样式与交互完全不变。

## 为什么现在可行（勘探实锤）

1. **命令面已收敛**：chat 前端只走 `cap.ai.chat`（19 同步 + 2 流式），chat 专属 Tauri 命令层已摘除。
2. **后端已是真相**：session_state / turn_persist / dialog JSONL 为权威，session-v2 kernel 已把运行状态权威上收后端——插件化只是把「前端缓存层」也搬出仓。
3. **插件机制现成**：同 window ESM + react shim + hostInvoke(router_dispatch) + contributes.styles + shadow 接管 + dev-link；history-desk 已验证会话域 UI 出仓，opencode 已验证引擎出仓。
4. **hook 骨架已插桩**：HookSystem + cap.hook 已有 ai.session.start/end、ai.tool.before/after，只缺前端声明接线与 5 个新 hook 点。
5. **方法论成熟**：terminal-desk P0-P7 全流程刚走完，模板直接复用。

## 新增契约（仅 6 项，全部纯增量，P1 完成）

| 契约 | 内容 |
|---|---|
| `cap.session` | 状态/查询/导航面：dialog.* / message.query / state.get / set_active / restore/fork；读面收口，不新增写路径 |
| mainSurface 席位 | views.area 枚举 + App shadow 接管；席位契约保留 |
| chat-event 授权 | manifest permissions.events；chat-desk=full，其他插件维持 lifecycle 过滤；审计打标 |
| react-dom shim | createPortal/flushSync 导出（Chat 有 8 处 portal） |
| hooks 接线 | contributes.hooks → cap.hook.register；新增 5 个 observe-only hook 点 |
| 目录/卡片桥 | 模型目录（cap.config 只读）、chatCardRegistry 只读、散命令白名单收口 |

## 分期（严格串行）

P0 立项 → **P1 契约地基**（6 commit，宿主零行为变化）→ **P2 插件骨架**（最小对话闭环，dev-link 真宿主验证）→ **P3 功能等价**（含 11 处非对话消费方改接 sessionDirectory 薄 store）→ **P4 数据对账**（缓存全量重建演练，消息零丢失）→ **P5 影子接管**（enabledByDefault 翻 true，禁用即回内置）→ **P6 摘装配+删实现**（独立可 revert commit）→ P7 发布+三处同步。

## 最大的三个风险

1. **Tailwind**：Chat 40 文件用宿主语义 token 类 → 插件构建期用同一 token 源自编译，global 注入，类名确定性一致。
2. **状态连续性**：接管期禁用回内置时内置 store 为空 → 后端真相 + 既有历史恢复全量重建（P4 先演练）。
3. **消费方漏改**：SessionTabs/通知/QuickSwitch/ModelProviderTab 等 11 处 → 处置表逐项挂 P3 验收 + P6 grep 断言兜底。

## 需要拍板

- D2 id/名称：`chat-desk` /「AI 对话」？
- D3 hooks v1 保持 observe-only？
- D4 禁用后主面板 = 空态引导卡？
- D5 前端 ai-runtime/engines 并入插件并在 P6 裁撤死路径？
- D1 后端引擎（claude-code/simple-ai）**保留宿主**，不出仓。

## 工作量级

最大单域出仓（40k 行，对比：IM 12k、browser 12k、terminal 2.2k）。P1 约 2-3k 行增量；P2-P3 是主体工程（搬运+桥接改写+等价矩阵）；P4-P7 是验证与拆除。适合按周粒度排期，每阶段独立可停、可回滚。
