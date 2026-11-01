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

## 验收（实测结果 2026-11-01）
1. grep src/：Chat 子树外零 `'./components/Chat'` / `'@/components/Chat'` 静态 import（type-only 也不留）——已达成。
2. main 1,617,089B → 1,332,966B（-284,123B/-17.6%；gzip 485.60→409.55kB）；
   首载 JS 2,042,934B → 1,758,817B；CSS 207.60→186.40kB（form/Card 样式随子树移出）。
3. 签名对照（同探针 before/after）：
   - form.missingRequired：true → **false**（源头 chatBlocks/FormCard.tsx，子树移出实锤）
   - noHighlightRe / C_LINE_COMMENT_MODE：true → true（残留，归因见下）
   - ToolCallBlock：11 处 → 11 处（探针污染，见下）
4. `pnpm typecheck` 零错误；`pnpm lint` 0 errors（87 warnings 为存量）。

## 残留签名归因（实测，均非 Chat barrel 传导）
- **noHighlightRe / C_LINE_COMMENT_MODE**（highlight.js core 导出名）：
  静态闭包遍历（423 模块）证实路径为
  `App.tsx:10 './components/Layout' barrel → CenterStage.tsx → DiffViewer.tsx
  → UnifiedDiffRow.tsx → WordDiffSegment.tsx → utils/syntaxHighlight.ts → utils/highlight.ts`
  ——改造前即存在，属 Layout barrel 边，不在本案范围。
- **ToolCallBlock×11**：探针测的是字符串。main 内 11 处全部为 main 侧固有方法名属性
  （conversationStore/eventHandler.ts 的 updateToolCallBlock×3、updateToolCallBlockDiff×2、
  updateToolCallBlockPatch×2、appendToolCallBlock×2 + utils/messageCompactor.ts:295
  compactToolCallBlock×2），组件本体标识符在产物中被 minify，两侧计数相同属预期。

## 回滚
单文件单提交（perf(chat)），`git revert <commit>` 即可整体回滚；spec 提交独立（docs(plans)）。

## 门禁 build+签名断言失败排查（2026-11-02 补充，存量判定）
门禁输出 sigs={toolCallBlock:true, noHighlightRe:true, clm:true, codemirror:true}。
checkout 49ee538d 重建基线（产物 hash main-ZD4X8tHd.js 与初次基线完全一致，构建确定性成立），
用同一探针脚本（polaris-fea-gateprobe.mjs）做字节级 before/after 对照：

| 探针 | 基线 49ee538d | 改造后 2f64872e | 判定 |
|---|---|---|---|
| toolCallBlock（小写） | 3 处 | 2 处 | 存量：i18n 词典键 `src/locales/zh-CN/chat.json:373` / `en-US/chat.json:374`（`toolCallBlock:"工具调用"`），基线多出的是 errorBlock.toolCallBlock 键引用（随子树移出净减 1） |
| ToolCallBlock（大写） | 11 处 | 11 处 | 存量：store 方法名属性（eventHandler.ts / messageCompactor.ts:295），两侧构成同构 |
| codemirror | 1 处 @277 | 1 处 @277 | 存量：main 顶部 Vite 懒 chunk URL 清单中的 `"assets/codemirror-QIEbWpZC.js"` 字符串，非代码；`CodeMirror` 探针基线/改造后均 0（codemirror 代码本体两侧都不在 main）——**回归不成立** |
| noHighlightRe / C_LINE_COMMENT_MODE | 2 / 9 处 | 2 / 9 处 | 存量：highlight.js core 真实代码经 App.tsx:10 Layout barrel → CenterStage → DiffViewer → WordDiffSegment → syntaxHighlight 静态入 main，与 Chat barrel 无关 |
| missingRequired | true | **false** | FE-A 实际生效的唯一渲染栈签名（源头 chatBlocks/FormCard.tsx） |

结论：门禁三项失败全部为存量或结构性误报，与 FE-A 改动无因果——
① toolCallBlock/codemirror 探针匹配的是 i18n 词典键与懒 chunk URL 清单字符串，
任何 import 图改动都无法使其变 false（前者改键名需同步改消费方 UI 逻辑，后者只要
codemirror manualChunk 存在且被任一懒 chunk 引用就必然出现在 main 依赖清单）；
② noHighlightRe/clm 的根因在 Layout barrel 边（FE-C，见下），基线即如此。
mainSize 1272605 vs 实测 1332966 为 utf8 字符数与磁盘字节数之差（中文串），同一文件。

## 后续项（不在本案扩散）
- **FE-C（建议）**：App.tsx:10 Layout barrel 同样传导 DiffViewer→highlight.js（~数十kB+
  hljs core）进 main；可复制本案范式对 Layout barrel 切边或对 DiffViewer 做 lazy。
- barrel 本体的 re-export 面收敛（renderChatMessage 等）另行评估。
- 直引的 7 组件内部未见反向 sibling barrel 传导（ChatInput 仅引 input/ 内 sibling 与
  compact-handoff/PendingBriefingCard 深路径；ChatStatusBar 引 session/SessionConfigSelector
  深路径）。
