# cap.ui.render sessionId 可选化 —— 不填 = 显式投递到当前活跃会话

> 日期：2026-10-27 · 状态：已实施
> 前置：`plans/cap-ui-render-external-entry-analysis.md`（方案 C：路由 miss 兜底活跃会话，2026-10-23 落地）
> 场景：外部入口（MCP bridge / AI 经 cap_dispatch）调用 `cap.ui.render request` 时 sessionId 乱填，
> 多会话下卡片落在「当前活跃会话」上属偶然兜底；乱填值若撞上真实 conversationId 还会误投其他会话。

---

## 一、目标

1. `request.sessionId` 从必填改为**可选**：不填/空白 = 「未路由」显式语义，前端渲染白名单
   （`plugin_card` / `plugin_card_answered`）直接兜底投递到当前活跃会话。
2. describe 契约（AI 唯一提示面）明确写出「**推荐不填**」，避免 AI 继续乱填：
   乱填可能撞上真实 conversationId 导致卡片误投到错误会话（conversationId 反查命中优先于活跃兜底）。
3. 已显式传 sessionId 的调用方行为完全不变（纯放宽）。

## 二、行为契约

- `sessionId` absent / 空串 / 纯空白 → 归一为空串（未路由）：
  - 后端 `wrap_question_route_event` / `wrap_session_routed_event` 已有空值分支：裸 payload（无 contextId 信封）广播；
  - 前端 EventRouter 对**无 session 信封的渲染类事件**转发 `sessionStoreManager.dispatchEvent`（不带 `_routeSessionId`）；
  - `dispatchEvent` 对渲染白名单放行「无路由 ID」事件 → 投递到 `activeSessionId`（无活跃会话才丢弃）。
- 交互回写闭环：`PluginCardHost` 应答门放宽为允许空 sessionId（回传空串）；
  后端 `respond_plugin_card` 等值校验 空==空 通过；配对本质仍按 interactionId 全局 map。
- 空 sessionId **永不参与 conversationId 反查**——消除乱填撞车的误投隐患，行为确定性 = 活跃会话。
- 跨端语义不变：activeSessionId 是每端各自的，多端在线时各端在各自活跃会话渲染（与乱填现状一致）。

## 三、所有者与改动面

| 层 | 文件 | 改动 |
|---|---|---|
| 后端 | `src-tauri/src/services/router/ui_render_capability.rs` | `do_request` sessionId 可选化（归一空白）；describe 文档 + 头注释标「可选/推荐不填」；`describe_contract` 测试断言含「可选」提示 |
| 前端 | `src/stores/conversationStore/sessionStoreManager.ts` | 导出 `RENDER_EVENT_TYPES` 单一权威；`dispatchEvent` 新增「无路由 ID 渲染事件 → 活跃会话兜底」分支 |
| 前端 | `src/services/eventRouter.ts` | 无 session 信封的渲染类事件转发 `dispatchEvent`（不带 `_routeSessionId`），其余路径不变 |
| 前端 | `src/components/Chat/chatBlocks/PluginCardHost.tsx` | 应答门放宽：`block.sessionId ?? ''` 回传 |
| 测试 | `sessionStoreManager.pluginCardFallback.test.ts` | 补「无路由 ID」用例（card / answered / 无活跃丢弃 / 非白名单仍丢弃） |

协议 JSON 无 schema 变化（字段本就可选）；插件仓库无 cap.ui.render 调用方，无需同步。

## 四、验收

1. `cargo check`（src-tauri 下）通过。
2. `pnpm exec tsc --noEmit` + `pnpm lint` 通过。
3. `vitest run sessionStoreManager.pluginCardFallback.test.ts` 全绿（含新增无路由 ID 用例）。
4. 行为：外部 `cap_dispatch` 调 `request` 不带 sessionId → 卡片出现在当前活跃会话；显式传真实前端会话 ID → 行为不变。
