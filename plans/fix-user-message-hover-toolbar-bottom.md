# fix(chat): 用户消息悬停工具栏移到下方

## 目标

用户消息（`UserBubble`）hover 出现的「复制 / 编辑」工具栏原为 `absolute -top-8`（向上伸出 32px）。第一条消息上方是滚动容器（react-virtuoso Scroller，`overflow: auto`）的裁剪区：`scrollTop=0` 时负向溢出不可见且不可滚动到，消息间 `--chat-message-gap: 10px` 的间隙不足以容纳 32px，导致按钮被裁掉看不见。

将工具栏改为消息下方（`-bottom-8`），利用列表底部已有的 `FOOTER_SPACER_STYLE = 120px`，使首条/末条消息下方均有充足可视空间。

## 所有者与改动点

- `src/components/Chat/chatBubbles/UserBubble.tsx`：唯一改动文件。
- 其余消息渲染路径（`renderChatMessage` → `SessionMessagesView` 单 session / 多窗口）均复用 `UserBubble`，无需另改。

## 接口 / 行为约定

- 工具栏容器：`absolute -bottom-8 right-0 z-10`，hover 触发区不变（仍在 `group` 容器内）。
- 新增 `z-10`：向下溢出落在 virtuoso 相邻后项区域内，后项 DOM 顺序在后会绘制在上层，必须反盖工具栏，否则按钮被下一条消息遮挡、不可点击。

## 验收

1. 首条用户消息 hover：复制/编辑按钮完整可见可点击。
2. 中间（非首条）用户消息 hover：按钮不被下方消息遮挡。
3. `pnpm exec tsc --noEmit` 通过；改动文件 eslint 通过。
