# spec: `/cap` 斜杠命令（cap 能力协议速查注入 + 中文短名补全）

- 日期：2026-10-25
- 状态：实施中
- 前置：`07c9f1c0`（cap describe 契约归一——describe 标准形状 `{id, name中文短名, summary, note?, actions}` 是本命令的数据地基）

## 目标

用户在聊天输入框以 `/cap` 让 AI 立刻拿到 cap 能力的正确协议，解决「不知道有哪些 cap / 协议记不准」：

1. `/cap` —— 把全部能力的**紧凑速查**（id + 中文短名 + 一句话 summary）注入消息顶部；
2. `/cap <查询> [正文]` —— 查询按 **id 精确 > 中文名精确 > id 后缀 > 子串** 匹配，唯一命中时把该能力**完整 describe 协议**注入消息顶部，正文跟随其后；
3. 输入 `/cap `（消息首）弹出**建议列表**：id + 中文短名 + summary，支持中文过滤（如 `/cap 待办`）。

## 所有者与接口

- `src/services/capSlashCommand.ts`：纯逻辑（parse / matchCaps / buildCapDigestBlock / buildCapDetailBlock），`CapCatalogEntry` 类型；vitest 覆盖。
- `src/stores/capCatalogStore.ts`：zustand 缓存，`ensure()` 经 `router_dispatch("cap.help", {action:"index"})` 懒加载一次（会话内缓存，force 可刷新）。
- `src/components/Chat/input/chatCommandRouter.ts`：`/cap` 解析与发送改写（同步，读 store 缓存；目录未就绪则 toast 引导重试）。
- `src/components/Chat/input/ChatInput.tsx`：`/cap <查询>` 参数补全分支（仿 /agent 参数补全）；通用斜杠分支补 `/cap` 命令入口项；selectSuggestion 增 `cap` 分支。
- `src/components/Chat/input/FileSuggestion.tsx`：`CapSuggestion` 类型 + cap 建议分组渲染（仅主题 token）。

## 语义细节

- `/cap` 后无内容 → toast 用法提示，不发送。
- 首个 token 命中多个能力 → toast 列出候选，不发送（引导用建议列表或更精确查询）。
- 首个 token 不命中任何能力 → 整体视为正文，注入紧凑速查后发送。
- 注入块是普通消息文本（对引擎透明，Claude/SimpleAI 通用）；协议以 cap.help 实时返回为准，前端不做第二份协议文档。

## 验收

- `pnpm exec tsc --noEmit` 通过；改动文件 eslint 通过；新增 vitest 通过。
- 输入 `/cap` 出现建议；`/cap 待办` 过滤出 cap.todo；发送后消息含 `[cap 协议` 注入块。
- locale 文件零改动（i18n 走 defaultValue），避免与工作区在途改动混流。
