# 性能×体验×布局 第二轮多agent评审计分板（ ballot ）

> 2026-11-01。三个维度分析 agent（分别加载 high-perf-browser / ux-heuristics / ui-design-review 三个新装 skill）审计后汇总 15 案。
> 基线：main@c78961a5。已剔除上轮已落地项：ST-1（17704a49）、DS-1（ad3451b6）、mermaid 泄漏修复、sessionElapsed（e480bc23）。
> 评分制：每案 0-25（收益 0-10 / 证据确定性 0-5 / 成本反比 0-5 / 风险反比 0-5）。
> ⚠ 工作区状态：另一并行会话有未提交改动（App.css / ThinkingBlockRenderer.tsx / DynamicIsland.css / FocusOverlay.tsx / index.css）——实施走独立 worktree，合并时注意这些文件的冲突。

## ⚠ 并行会话撞车去重（投票前必读，2026-11-01 实测更新）

- **P1 已作废剔除**：FE-2 已由并行会话实施合并（6e64fcdc + c0a6bd61，"多agent评审胜选 46/50"），五条静态边对当前 HEAD 全部失效。证据分记 0，不参与排名。
- **P2 实施权已归属并行会话**：其 plans/perf-ux-round2-plan.md C2（同病灶，收窄为 thinking 流）已立项实施中（胜选 112.5/125）。本会话不重复实施；投票分数仅作参考记录。
- **P4 与并行会话 C3 同病灶**（其次优 111.5/125，尚未立项）。实施时若该案胜选须先查 `.worktrees/` 与最新 main 确认未被其认领。
- **U1-U5 / L1-L5 为本会话独有勘探**（并行会话三轴勘探未覆盖体验交互与布局结构，其布局轴仅有弱候选 C5=DESIGN.md 文档），撞车风险最低。
- 附加情报：并行会话已明确不选 i18n 懒加载（"收益太小"）；其勘探发现 DynamicIsland.css 有 5 处硬编码 hex（.css 文件，本票 L1 的 .tsx 扫描未覆盖，实施 L1 时可一并核对）。

## 性能维度（审计评分 6/10）

### P1 · FE-2 CodeMirror 移出启动路径（上轮遗留刷新，仍为首名候选）
- 证据：五条 eager 链——App.tsx:11；CenterStage.tsx:15；NarrowTabOverlay.tsx:25；useAppInit.ts:35(:145 idle 调用)；lspStore.ts:11-17（还拖 ctrlHoverLink）；plugin-system 链 App.tsx:49→builtinPlugins.ts:7→editor/index.ts:16-20。dist 实测 main-D3x8q_9H.js 静态含 codemirror chunk(1,017,611B) + modulepreload。
- 收益：启动 JS raw −1.02MB（−33%）、gzip −344KB；主要收益=首帧解析/编译 CPU（弱机显著）。诚实口径：本地 asset 协议下加载毫秒级，不是网络收益。
- 成本：~80 行，5-6 文件。完整 spec 已在未跟踪文件 plans/fe2-codemirror-lazy-spec.md。
- 风险：Suspense 首开闪变（骨架占位缓解）；lspStore 同步用点逐一核实；漏边靠 dist grep 断言兜底。
- 验收：pnpm typecheck && pnpm lint && pnpm build 后 `grep -o 'from"\./[^"]*"' dist/assets/main-*.js | sort -u` 不含 codemirror；modulepreload 同断言；pnpm test:run。

### P2 · FE-1 补全：thinking/工具输出并入既有 50ms 节流
- 证据：appendThinkingBlock 每条 delta 全量 set（createConversationStore.ts:931-962，源 eventHandler.ts:505）；工具中间输出每行全量 set（eventHandler.ts:1105→:1020-1050）；正文已有 STREAM_FLUSH_INTERVAL=50 范式（createConversationStore.ts:325-341）。
- 收益：思考长文（数千 delta/轮）时 store 写入与重渲染从每-delta 一次→~20fps；INP 直接对应。
- 成本：~70 行（createConversationStore.ts ~60 + eventHandler.ts ~10）。
- 风险：末尾 flush 时机（finishMessage:415 已有 flush-all 先例）；thinking 折叠交互回归；⚠同文件曾被并行会话活跃触碰（sessionElapsed 刚落）。
- 验收：pnpm typecheck + 专项 vitest（eventHandler 同目录有先例 test 文件）。

### P3 · locales 双语全量静态 → 按语言懒加载
- 证据：src/i18n/index.ts:4-39 静态 import 36 个 JSON（zh/en 各 18，~155KB/语言）；经 main.tsx:9 进入口 chunk（dist main 实测含中文串）。
- 收益：入口 −~267KB rendered / gzip −~80KB。
- 成本：~50 行（i18n/index.ts 重写为当前语言静态+备用语言动态 import；languageChanged 监听处补加载）。
- 风险：切换瞬间未加载命名空间短暂裸 key（i18next loadNamespace 缓解）；fallbackLng 保证 zh-CN 常驻。
- 验收：pnpm build 后 dist main 中 en-US 文案串消失；typecheck + test:run。

### P4 · DS-3 SQLite pragma 收敛（三处连接点对齐 session_db 范式）
- 证据：正确范式 session_db.rs:134-145（busy_timeout 先于 WAL，注释明示原因）；顺序相反的三处 storage/sqlite.rs:94-102、dialog_index.rs:139-145、lsp_index/db.rs:79-88；journal_size_limit=64MB 仅 storage/sqlite.rs:100 有（其余三库 WAL 无界——:97-99 注释记载 200MB WAL 楔死根因）。
- 收益：可靠性/尾部延迟——消除多连接 open 竞争 database is locked 窗口；防楔死复发。诚实口径：日常单机感知≈0，防复发加固。
- 成本：~15 行，3 文件。
- 风险：极低。
- 验收：cargo check + cargo check --no-default-features --bin polaris-web --bin polaris-mcp；grep 四处 pragma 顺序一致。

### P5 · zod 出口懒化（低成本版）
- 证据：唯一链 pluginDiscoveryService.ts:34→schema.ts:14→zod；zod 实测打进 main（~233KB rendered）。
- 收益：−~233KB rendered / gzip −~70KB——但若插件发现在启动即触发，只是把解析成本挪后几百 ms，用户可感知收益微小，需实测 discovery 时序再定。
- 成本：~30 行（schema 校验变异步）。
- 风险：中——调用方错误处理路径变化。
- 验收：pnpm build + zod 字节对比。

## 体验维度（审计评分 5/10，存在 1 个 catastrophic）

### U1 · 会话删除加确认对话框 +「关闭」改名「删除会话」（catalstrophic 级修复）
- 证据：deleteSession 删内存 store+磁盘 JSONL+后端消息库不可恢复（sessionStoreManager.ts:238-307）；三个 UI 入口零确认直调（QuickSwitchPanel.tsx:173-175、SessionTabs.tsx:71-73、SessionCell.tsx:102-105）；误导性 title=「关闭」（QuickSwitchContent.tsx:310）。Nielsen#3/#5 + Krug 第一律。
- 收益：消除「以为只是收起窗口，整段历史没了」最坏路径；destructive 操作的行业标准防护。
- 成本：~60 行（轻量 ConfirmDialog + 3 入口接线 + 文案）。
- 风险：低。
- 验收：vitest（确认取消不删/确认后删除）+ 手动三入口冒烟。

### U2 · 流式+有草稿时「停止」与「发送」并存
- 证据：状态机把中断键换成发送键（ChatInput.tsx:2098-2113）；唯一替代 ESC 无提示（:1571-1581）。Nielsen#3。
- 收益：高频场景（边看流式边预输入）紧急出口常在。
- 成本：~12 行（ChatInput.tsx 右键区加 IconStop 小按钮，onInterrupt 直连已有）。
- 风险：低（窄面板 24px 命中区）。
- 验收：vitest（流式+草稿态渲染两按钮、点击触发 onInterrupt）+ 手动冒烟。

### U3 · 错误横幅三件套（重试保附件 + 归属标题 + 长文案兜底）
- 证据：重试丢附件（ErrorBanner.tsx:47 只发 content；sendMessage 支持 attachments createConversationStore.ts:2177；UserChatMessage.attachments types/chat.ts:691-702）；错误横幅全局唯一看不出哪个会话错（App.tsx:72/:374）；引擎原文直出（ErrorBanner.tsx:27、eventHandler.ts:691）。
- 收益：Nielsen#9；带图失败重试不再静默丢图。
- 成本：~15 行（ErrorBanner.tsx 单文件为主）。
- 风险：低（attachments 展示态→AttachmentInput 类型对齐需小心）。
- 验收：vitest（retry 断言 attachments 回传）。

### U4 · 权限卡补全（展示 resource + 拒绝结果反馈）
- 证据：resource 载荷从不展示（PermissionPromptHost.tsx:26 vs 渲染 :103-107）；拒绝失败只写日志卡片直接消失（:68-80）；未知动作文案含糊（:91）。
- 收益：Nielsen#9/#4；插件权限审批流的安全信任。
- 成本：~15 行（PermissionPromptHost.tsx）。
- 风险：低。
- 验收：组件测试 + 冒烟。

### U5 · 断线重连「正在重连…」可见态
- 证据：指数退避重连全程静默（httpTransport.ts:148-165）；'disconnected' 已发出但消费方只处理 failed/connected（transport/index.ts:39-61）。已有 failed 常驻 toast（:42-53）与自动 gap 恢复（webReconnectResync.ts:37-85）。
- 收益：Nielsen#1——静默失败最伤信任；补中间态。
- 成本：~15 行（transport/index.ts 槽位复用模式）+可选 ChatStatusBar 状态点。
- 风险：低-中（闪断防抖，复用现有 toastId 槽位）。
- 验收：手动杀服务端 10s 冒烟 + vitest 三态迁移。

## 布局维度（审计评分 7.1/10）

### L1 · 状态光效 token 化 + 单一映射源
- 证据：两份重复 status→color+glow 映射且 glow 硬编码 RGBA（QuickSwitchTrigger.tsx:66-70 与 StatusSymbol.tsx:36-39；QuickSwitchContent.tsx:257、GeneralTab.tsx:254 同病）；Shenzhen 主题实证光效颜色不跟随。
- 收益：切任意主题光效即跟随；消一处 L2 重复；−20 行。
- 成本：~30 行 / 4 文件；tailwind `rgb(var(--x)/a)` 有先例（VoiceOrb.tsx:35）。
- 风险：低。
- 验收：tsc + test:run + 手动切 Shenzhen 主题看光效变色。

### L2 · z-index 逃逸者归队（9999/60/20/裸 z-N → 语义刻度）
- 证据：SelectionContextMenu.tsx:309 `zIndex:9999` 盖住 z-toast=90（App.tsx:473 注释宣称 Toast 最上被打破）；DefinitionPeek.tsx:183 `zIndex:60` 无主值；FocusOverlay.tsx:93 `zIndex:20`⚠（并行未提交文件）；QuickSwitchPanel.tsx:321 裸 z-20；13 文件裸 z-N。
- 收益：恢复九级刻度完备闭包全局不变量；Toast 永远可见。
- 成本：~35 处单行替换 / 16 文件。
- 风险：低但需逐处核对 DOM 序依赖（LeftPanel.tsx:127-136 有同层 DOM 序先例注释）。
- 验收：tsc + vitest + 手动（选区菜单+Toast 叠放、NarrowTabOverlay 与 Git 抽屉叠放）。

### L3 · 字阶收敛第一阶段（归灭 9-13px 任意值到双刻度）
- 证据：673 处任意 px 字号 / 99 文件；text-[9px]×38 + text-[8px]×1 低于可读下限；text-[11.5px] 等 .5 值×45；text-[12px]×25 就是 text-xs 别名；PluginTab.tsx:253 内联 fontSize。
- 收益：任意 px 673→<150；9px→10px 可读性；字阶单轨化。
- 成本：大——tailwind.config 加 fontSize '2xs':10px + ~40 文件 500 处机械替换，需分批+按面板冒烟。
- 风险：中（局部换行/溢出）。
- 验收：tsc + lint + vitest + 分面板目测。

### L4 · CenterStage 标签 min-width 死类修复（1 行）
- 证据：CenterStage.tsx:307 插值类 `min-w-[${tab.pinned?'48':'120'}]`——Tailwind JIT 扫不到插值候选且缺 px 单位，全仓无 `min-w-[48]`/`min-w-[120]` 字面量（grep=0 实证），标签最小宽度静默失效约 1 年。
- 收益：修复静默布局缺陷；标签挤压行为回设计意图。
- 成本：1 行（`` {tab.pinned ? 'min-w-12' : 'min-w-[120px]'} ``）。
- 风险：极低。
- 验收：tsc + 手动开 8+ 标签拖窄窗口。

### L5 · 工具栏高度对齐（h-8→h-10）+ LeftPanel 宽度钳位
- 证据：LeftPanelTabStrip.tsx:117 h-8 与同排 CenterStage h-10（:261/:270）、TopMenuBar h-10 并排 border-b 错位 8px；LeftPanel.tsx:59-61 拖宽自述「无限制」vs RightPanel.tsx:63 有 200-1200 钳位。
- 收益：三栏顶部最显眼错位缝消灭；防呆拖拽。
- 成本：~6 行 / 2 文件。
- 风险：低（tab strip 内图标垂直居中核对）。
- 验收：tsc + 目测两 border-b 连线 + 拖拽极限。

## 实施约束（投票后适用）
- 本轮实施走独立 worktree（.worktrees/，已在 .git/info/exclude）+ 专属 CARGO_TARGET_DIR；实施完成后 --no-ff 合并回本地 main（不 push）。
- L2 的 FocusOverlay.tsx 在并行会话未提交清单里——若胜选，实施时核对该文件行号以 main 提交态为准，合并时留意冲突。
- P2 触碰文件曾被并行会话活跃触碰——若胜选，合并前 rebase 检查。
- 体量上限：单轮 workflow 串行实施，预计容纳 5-8 案。

---

## 投票结果（2026-11-01，4 评审：性能专家/UX专家/设计系统专家/首席工程师，25 分制四维）

| 案 | 性能 | UX | 设计 | 首席 | **均分** | 裁决 |
|---|---|---|---|---|---|---|
| U1 删除确认 | 19 | 24 | 24 | 25 | **23.00** | ✅ 胜选#1（ConfirmDialog 复用，成本 60→~40 行） |
| L4 min-width 死类 | 19 | 21 | 21 | 21 | **20.50** | ✅ 胜选#2（行号漂移至 CenterStage.tsx:314） |
| U2 停止/发送并存 | 18 | 21 | 20 | 22 | **20.25** | ✅ 胜选#3 |
| P4 pragma 收敛 | 21 | 20 | 19 | 17 | 19.25 | ⏸ 条件案（并行 C3 未认领时补做；.worktrees/ 实查 11-01 12:3x 无人认领） |
| U3 重试保附件 | 18 | 20 | 18 | 21 | **19.25** | ✅ 胜选#4 |
| L5 工具栏对齐 | 17 | 19 | 20 | 20 | **19.00** | ✅ 胜选#5（与 L4 合并提交） |
| L1 光效 token 化 | 17 | 17 | 21 | 19 | **18.50** | ✅ 胜选#6（GeneralTab 病灶修正为 :288） |
| U4 权限卡补全 | 16 | 19 | 20 | 18 | **18.25** | ✅ 胜选#7 |
| U5 重连可见态 | 17 | 19 | 18 | 17 | 17.75 | 落选（杀服务端手动冒烟成本高） |
| L2 z-index 归队 | 16 | 15 | 19 | 14 | 16.00 | 落选（16 文件广撒网 + FocusOverlay 并行冲突） |
| P3 i18n 懒加载 | 16 | 16 | 16 | 13 | 15.25 | 落选（收益夸大 ~1.8x 证伪→真实 −149KB raw/−45KB gzip；并行会话亦明拒） |
| L3 字阶收敛 | 12 | 11 | 13 | 12 | 12.00 | 落选（40 文件 500 处，独立立项分批） |
| P5 zod 懒化 | 14 | 12 | 12 | 11 | 12.25 | 落选（收益=成本后移） |
| P2 thinking 节流 | 20 | 18 | 15 | 17 | — | 归属并行会话 C2（.worktrees/c2-thinking-buffer 已认领） |
| P1 CodeMirror 懒化 | — | — | — | — | — | 作废（已由并行会话合并 6e64fcdc+c0a6bd61） |

**评审实证修正记录**：P3 收益 −267KB→−149KB（口径证伪）；L4/L5/U3 行号漂移 ±7（FE-2 合并所致，内容全部属实）；U1 成本 60→~40 行（ConfirmDialog 现成）；L1 的 DynamicIsland.css 5 处 hex 中仅 :554/:558/:1022 三处为真病灶（:916/:917 是 mask 功能性 #000）；P4 表述修正=「统一到 session_db 范式+补 limit」非消灭笔误。

**最终实施名单（worktree 串行，每案独立 commit，共 ~127 行纯前端）**：
U1 → U2 → U3 → U4 → L4+L5（合并提交）→ L1；P4 条件案在合并窗口复查后决定。

---

## 实施与合并记录（2026-11-01 回填）

- **七案实施**：dynamic workflow（dwfrun-d39f4254）在 `.worktrees/ux-layout-r2`（feat/ux-layout-r2）串行完成，每案独立 commit + 实施前 tsc + 定向 vitest；全量门禁 tsc/lint/vitest 全绿（**2483 passed / 0 failed**，lint 0 error）；独立评审员只读复核无 mustfix（2 条 nice/note 已做评审收尾修正）。
- **U1 与并行会话 UX-4 互补合并**：rebase onto main 时，QuickSwitchPanel/SessionHistoryPanel 入口取并行实现（03a1dba8，含 ≤2 条消息跳过确认 + portal），本分支保留 SessionTabs/SessionCell 入口 + SessionDeleteConfirm 共享组件 + 8 用例测试 + deleteSessionConfirm 双语 i18n——双方零重复接线，四入口全覆盖。
- **合并**：`a503519c` --no-ff 合并回本地 main；合并后 main 树 tsc 通过。
- **评审收尾修正**（4cc607e2）：SessionCell X 按钮 title「关闭」→「删除会话」；ErrorBanner 注释措辞按 ai_chat_core.rs 实读修正（文件分支 warn 后跳过写入、无 continue）。
- **诚实披露（评审员发现，留档）**：U3 重试只能恢复附件条展示（存储态不含二进制 content），AI 实际收不到原图——彻底闭环需重试路径从 `<workdir>/.polaris/attachments/` 回读落盘文件，建议后续立项；U4 权限卡无既有测试文件，以 tsc 为准。
- **P4 条件案**：合并窗口复查时 C3 无并行认领 → 实施（feat/ds3-pragma）：三处 tune_pragmas 统一到 session_db 范式（busy_timeout 先于 WAL）+ dialog_index/lsp_index 补 journal_size_limit 64MB；门禁 cargo check + web-only 双 bin（专用 CARGO_TARGET_DIR）。
