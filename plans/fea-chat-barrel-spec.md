# FE-A App.tsx Chat barrel 切边 spec

## 目标
main 入口链不再静态引用 `src/components/Chat/index.ts` barrel，切断 barrel re-export
（renderChatMessage/SessionMessagesView/MessageSearchPanel → chatBlocks/chatBubbles/tool-calls
渲染子树 ~10,325 行）被「懒 chunk 反向 import main」拽进入口 chunk 的传导，缩小首载。

## 改动点（唯一文件：src/App.tsx）
App.tsx:11-12 的 7 组件 + 1 type 改深度路径直引（对照 components/Chat/index.ts:18-31 实际位置）：
- ChatInput / EditMode(type) → `./components/Chat/input/ChatInput`
- ChatStatusBar、ErrorBanner → `./components/Chat/common/...`
- CompactHandoffButton、CompactHandoffProgress → `./components/Chat/compact-handoff/...`
- MultiWindowMenu、NewSessionButton → `./components/Chat/session/...`
barrel index.ts 本体不动；其他组件对 barrel 的引用不动（懒侧无碍）。

## 基线（2026-11-01 实测，main@49ee538d，vite build 59.15s）
- main-ZD4X8tHd.js = 1,617,089 B（gzip 485.60 kB）
- 病灶签名（main chunk 内应不再出现的懒侧模块标识）：
  ToolCallBlock=11 处、form.missingRequired=true、noHighlightRe=true、C_LINE_COMMENT_MODE=true（全中，验证病灶）
- index.html 首载：main + utils(72.66kB) + react-vendor(324.88kB) + tauri(18.32kB) modulepreload
  + index.css(207.60kB)，JS 合计 2,042,934 B

## 验收
1. grep src/：main 入口链（App.tsx/main.tsx）零 `'./components/Chat'` / `'@/components/Chat'` 静态 import（type-only 也不留）。
2. 改造后 build：4 项签名全 false；main 体积下降，记录 bundleAfter。
3. `pnpm typecheck` 零错误。

## 回滚
单文件单提交（perf(chat)），`git revert <commit>` 即可整体回滚；spec 提交独立（docs(plans)）。

## 后续项（不在本案扩散）
- 若直引后 ChatInput 等符号内部仍传导 sibling barrel，另行立项。
- barrel 本体的 re-export 面收敛（renderChatMessage 等）另行评估。
