# spec: 引用映射层（轻引用 + 发送末尾包含）

- 日期：2026-10-26 · 状态：**已实施**
- 方案来源：`plans/cap-reference-architecture-plan.md`（三评审 Borda 一致胜出「引用库·注册表延伸」）
- 数据地基：`07c9f1c0`（describe 契约归一）；替代 `5a8dbdd8`/`0392e24e` 的「注入块进输入框」交互

## 目标

1. `/cap` 选中后**正文不灌内容**：输入框只挂轻量引用 chip（cap-help ContextBlock）；
2. 实际发送时引用内容**统一在用户正文之后（末尾包含）**；
3. 机制即映射库：kind 注册表（数据面 `InputDraft.contextBlocks` + 行为面 `contextBlockRegistry` 注册表），
   后续来源（截图/@对话/插件自定义 kind）注册即接入全链，输入框/草稿/发送零改动。

## 所有者与接口

| 文件 | 职责 |
|---|---|
| `src/components/Chat/input/contextBlockRegistry.ts` | 注册表核心：`registerContextBlockKind`/`getKindSpec`（Map）、`upsertContextBlock`（source+dedupeKey 原位覆盖单一权威）、`materializeContextBlocks`（发送单点物化，末尾契约）、cap-help/marquee 自注册 |
| `src/components/Chat/input/ChatInput.tsx` | /cap 选中转 chip（正文移除前缀、草稿立即整体回写）；发送三路径（普通/流式入队/斜杠分支）统一走 `materializeContextBlocks` 末尾追加；流式 /cap 收编 |
| `src/components/Chat/input/chatCommandRouter.ts` | /cap 命令文本兜底路径保留，注入位置由前部改为末尾 |
| `src/components/Chat/input/ContextBlockPreview.tsx` | chip 渲染接 `getKindSpec`（cap-help ⚡ kind-known 样式；展开详情走既有 JSON 降级，零新组件） |
| `src/services/capSlashCommand.ts` | `buildCapReferenceBlock` 工厂（快照语义 data + dedupeKey）；detail/digest 纯函数加可选备注参数 |

## 开放问题答复（方案 §五，随本次实施落定）

1. **正文零标记**：正文与引用完全解耦，删 chip 无正文联动。
2. **快照语义**：chip 持选中时刻 entry/caps 快照，format 读快照不重拉；重选原位覆盖刷新（dedupeKey=cap.id / `__digest__`）。
3. **降级链**：不设新体积阈值——有工作区一律落盘 `@path`（一个 tcb-<ts>.md，多引用按插入序合并），无工作区/失败一律末尾直拼全文；与 TCB 现状同构。
4. **多引用顺序**：插入序（chip 序=数组序=发送序），不分组不重排。
5. **TCB 前部引导语退役**：语境职能由末尾固定句式「以下是随消息附带的引用内容（已保存为上下文文件），请查看 @path 并结合该内容协助我。」承担。
6. **气泡/历史三态**：UI 气泡=正文+末尾引用段全文；prompt 历史=仅正文（流式分支改记 effectiveText）；编辑重发/队列撤回维持丢 chip 现状。
7. **命令文本兜底**：键入 `/cap ...` 直接发送仍可用（chatCommandRouter），唯一命中/全量速查的注入位置改为末尾；多命中 toast 不变。
8. **边界**：本轮=cap-help+marquee 进注册表；`@file`/`@对话`/`@专家` 文本 token 机制不动（引擎侧解析链回归面大，@对话 收编排下轮）；插件可带任意自定义 kind 经 addContextBlock 参与（未注册走 JSON 降级），天然满足通用性。

## 已知边界（如实记录，不恶化现状）

- 目录未就绪时流式 `/cap` 仍字面入队；发送失败（onSend false）chips 已清、handoff 文件已落盘（与既有 TCB 事务语义一致）；编辑重发/队列撤回丢 chip；handoff 文件不清理。

## 验收（本次实际执行）

- `pnpm exec tsc --noEmit` 0 错误；改动文件 eslint 0 error、0 新增 warning（修复 1 处 handleSend 依赖数组）；
- vitest：新增 `contextBlockRegistry.test.ts` 14 例（upsert 语义/物化三分支/混排顺序/cap-help 格式化/未知降级）全过；input 目录 + capSlashCommand 41 例全过；conversationStore 177 例全过；
- 手测项（待用户在 dev 环境复核）：/cap 选中正文无 JSON、发送消息正文在前引用在后、无工作区降级、删 chip 后发送不含该内容、草稿切会话往返 chip 仍在、流式入队 /cap 不再字面直发。
