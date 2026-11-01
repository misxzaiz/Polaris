# 极致性能·体验·界面布局 第二轮治理候选方案（多 agent 投票输入）

> 2026-11-01。上一轮（plans/perf-max-benefit-plan.md）胜选 ST-1 已合并（17704a49）、亚军 DS-1 已落地（15720d3e + 3a7e6ccd + ad3451b6 合并，生产 logs 955MB→229MB 实测回收）。
> 本轮所有候选证据均在 main@d22e4ce7 实读核验；实施前仍须按语义重定位行号。
> 方法论输入：performance-optimization skill（measure-first：先测量、修最大项、复测）+ ui-ux-pro-max skill（119 条 UX 准则优先级表、交付前检查单）。

---

## 〇、勘探结论总览（三轴）

| 轴 | 结论 |
|---|---|
| 性能（启动） | **C1 CodeMirror 1.0MB 仍在入口静态闭包**（dist 实测）；**C4 SimpleAI 启动全量恢复 783 会话**（~8s，历史实测） |
| 性能（运行时）/体验 | **C2 thinking 流逐 delta set + O(n²) 字符串拼接**；text 路径已有 50ms 缓冲（FE-1 原诊断部分过时，病灶收窄） |
| 稳定性/性能 | **C3 SQLite pragma 5 处三种形态**，其中 3 处 WAL 先于 busy_timeout（与 session_db.rs:135 注释确立的顺序矛盾） |
| 界面布局 | 实扫**零硬编码 hex 违例**（最近改动组件 dynamic-island/NewSessionPanel/SessionMessagesView 均干净）；NewSessionPanel 贴边+portal 修复已落地（3dad4d40）；仅剩 C5 弱候选（DESIGN.md 缺失） |

上一轮遗留候选状态更新：FE-2 补齐第 4 条边后升级为 C1；FE-1 病灶收窄后升级为 C2；DS-3 升级为 C3；FE-3（i18n）实测双语各仅 ~300KB 级 JSON、收益太小不入选；DS-1/ST-1 已完成。

---

## C1 切除 CodeMirror 启动静态闭包（~1.0MB 移出首屏）

**证据（dist 为 11-01 00:15 构建，含 mermaid 修复后基线）**：
- `dist/assets/main-*.js`（1.7MB）内含 `from"./codemirror-D05K7m4i.js"` **静态导入**；全文件 `import("./codemirror` 动态引用 **0 条** → 编辑器 100% 随首屏加载，懒加载名存实亡。
- `dist/assets/codemirror-*.js` = 1,017,611B（gzip ~344KB，上轮 dist 实测口径）。
- 三条真实运行时静态边：
  1. `App.tsx:11` `import { NarrowTabOverlay } from './components/Editor'` → barrel `index.ts` `export { CodeMirrorEditor } from './Editor'` → `Editor.tsx:6-20` 全量 `@codemirror/state|view|commands|language|autocomplete|search`（**barrel 拖带**：拿 NarrowTabOverlay 必静态引 CodeMirrorEditor）；
  2. `CenterStage.tsx:15` `import { EditorPanel, BreadcrumbBar } from '@/components/Editor'`（同 barrel）；
  3. `useAppInit.ts:23` `import { useLspStore } from '@/stores/lspStore'` → `lspStore.ts:15-17` 顶层 `@codemirror/lsp-client` + `@codemirror/view`。
- 已证伪非边：`plugin-system/editorExtensionRegistry.ts:10` 仅 `import type { Extension }`（type-only，编译期消除），App.tsx:49 → plugin-system 不构成运行时边。

**修法（三链同断）**：
1. `App.tsx` 改直引 `./components/Editor/NarrowTabOverlay`（绕过 barrel）；
2. barrel 停止 re-export `CodeMirrorEditor`（或 `CenterStage.tsx` 对 `EditorPanel` 改 `React.lazy` + Suspense 兜底，二选一或都做，以 build 后闭包复核为准）；
3. `lspStore.ts` 顶层 `@codemirror/lsp-client`、`@codemirror/view` 运行时 import 移入 init()/使用点动态 `import()`（类型引用改 type-only）。

**量化**：启动 JS 3.0MB→~2.0MB（raw 口径 -1.0MB，gzip -~344KB，约 -1/3）；首屏解析/执行等比下降。
**改动面**：4-6 文件（App.tsx / CenterStage.tsx / Editor/index.ts / lspStore.ts / useAppInit.ts 不动）。
**验收**：`pnpm build` 后 grep main 静态闭包不含 codemirror chunk 且 `import("./codemirror")` 存在（懒链路存活）；编辑器打开文件冒烟 + LSP 跳转冒烟 + 插件编辑器扩展注册冒烟。
**风险**：窄屏 NarrowTabOverlay 首载轻微延迟（可接受：窄屏为降级形态）；三链必须同断否则收益归零。

---

## C2 thinking 流并入 50ms 缓冲 + 消除 O(n²) 字符串拼接

**证据**：
- `eventHandler.ts:502-505` case 'thinking' 每 delta 调 `appendThinkingBlock`；
- `createConversationStore.ts:931-961` `appendThinkingBlock` 每 delta：`set({currentMessage: {...}})` 全量 blocks 数组拷贝 + `{...lastBlock, content: lastBlock.content + content}` **全量字符串重拼（O(n²)）** + `streamingUpdateCounter+1`；
- 对照组（已修好的范式，同文件）：text 路径 `appendTextBlock:798` 用闭包级 `_textBuffer`（O(1) 追加不触发 Zustand）+ `STREAM_FLUSH_INTERVAL = 50`（:341）定时 flush + 段落边界(\n\n)触发；
- 工具路径无流式 delta（`tool_call_start` 一次写全 args，eventHandler.ts:555），无需处理。
- 无任何现成 throttle/RAF/batch 机制覆盖 thinking（grep 全 store 目录 0 命中）。

**修法**：`_thinkingBuffer` 闭包级累积 + 复用/对称 50ms flush（`_flushThinkingBuffer`），flush 时一次性合并入最后 thinking 块；段落/超时/流结束（finishMessage）兜底 flush。保持「首 token 立即 flush」对称语义与块序边界（thinking→text 切换时先 flush thinking——现有 appendTextBlock:798 已有此前置 flush，方向相反新增一条）。
**量化**：思考高峰（30-60 delta/s 历史口径）set 频率 → ≤20/s（-66~95%）；长思考字符串拷贝 O(n²)→O(n)（万字符思考省 ~10⁸ 字节级临时分配）。直接体验面：流式期 UI 主线程卡顿/打字跟随延迟。
**改动面**：2 文件（eventHandler.ts 无需动、createConversationStore.ts 为主）+ vitest（flush 矩阵：段落边界/超时/finishMessage/thinking→text 切换/迟到 token 防御）。
**风险**：块序边界回归——严格执行 flush 矩阵测试；`streamingUpdateCounter` 语义不变（仍由 flush 触发）。

---

## C3 SQLite pragma 单权威化（5 处三形态收敛共享 helper）

**证据（5 个连接建立点，三种形态）**：
- ✅ 正序范式：`session_db.rs:135-143`（busy_timeout→WAL→synchronous，:135 注释明示「busy_timeout 必须先于 journal_mode=WAL：WAL 切换需独占锁」）、`session_state.rs:293-301`（同款）；
- ⚠️ 反序但全：`storage/sqlite.rs:93-103`（WAL→synchronous→journal_size_limit 64MB→busy_timeout；kv 等域连接共用）；
- ⚠️ 反序且缺：`dialog_index.rs:140-145`（WAL→synchronous→busy_timeout，无 journal_size_limit，`let _ =` 吞错）；`lsp_index/db.rs:80-91`（WAL→synchronous→busy_timeout，`.ok()` 吞错，无 journal_size_limit；另有 wal_checkpoint TRUNCATE）。
- 事故背书：kv WAL 191MB 楔死（注释在案）；无 busy_timeout 时写冲突立即 `database is locked`（dialog_index.rs:143 注释自证）。

**修法**：抽共享 `open_sqlite_conn(path, opts)` helper（正序：busy_timeout 5s→WAL→synchronous NORMAL→journal_size_limit 64MB，错误显式返回不吞），5 处收敛调用；lsp_index 保留其 checkpoint/TRUNCATE 与 cache_size 特化为 opts。
**量化**：无直接速度收益，防三复发：WAL 切换偶发失败（反序）、WAL 无限增长（缺 journal_size_limit）、锁冲突立即炸（吞错掩盖）。防「整实例楔死」级别（kv 191MB 先例）。
**改动面**：5 文件 + 1 新 helper（或并入 storage/sqlite.rs）。
**验收**：cargo check 双向 + clippy 无新 warning；grep 确认无散落 pragma_update 残留；既有测试通过。
**风险**：低——行为统一为最严配置；注意 session_db/session_state 现有错误处理语义保持。

---

## C4 SimpleAI 启动恢复惰性化（索引化，消息按需加载）

**证据**：
- `simple_ai/mod.rs:85-96` 引擎构造函数内 `restore_persisted_sessions()` → `store.rs:103 load_all_sessions`：遍历会话目录逐个 `read_to_string` + `serde_json::from_str` **全量解析全部历史会话**；
- `mod.rs:112-115` 每会话一条 `info!`（783 会话 = 783 行启动日志）；
- 每会话 `messages: Vec<Value>` 全部驻内存（store.rs:129 result.push 携带全量消息）；
- 历史实测（10-31 夜查）：783 会话 ≈ 8s 启动开销。
- 运行时语义：恢复会话 is_running=false（mod.rs:87 注释）；中断/运行路径只触达内存中运行会话。

**修法**：启动只建索引 `HashMap<sid, (path, work_dir, counter)>`（读文件名+轻量元数据，或仅目录枚举零解析）；`continue_session` 时按需 `load_session(sid)` 单文件加载；中断热路径零触碰（运行会话始终全内存）。`session_counter` 推进改由文件名解析（现有 parse_session_counter 已按 sid 计算，索引化后不需要解析内容）。
**量化**：启动恢复 8s→<0.5s（目录枚举级）；内存驻留 -全量历史消息。
**改动面**：2-3 文件（mod.rs / store.rs / continue_session 路径）+ 既有单测适配（store.rs:187-235 测试用 load_all_sessions，保留该函数供建索引内部复用或改语义）。
**风险**：中——continue_session 路径改造；须处理「索引存在但消息未加载」状态展示（列表只展示元数据，现状已如此则零影响，实施时核实）；**中断/继续幂等语义不得变化**（AGENTS.md §4.2）。

---

## C5（弱）DESIGN.md 设计约定文档落地

**证据**：仓库无 DESIGN.md（AGENTS.md §3.1 要求 UI 遵循之，属引用悬空）；实扫零硬编码违例说明现状靠纪律而非文档维持。
**修法**：从现有主题 token 体系（.polaris-theme / tailwind 刻度）+ 浮层 z 分层（body portal 约定）提炼 1-2 页约定文档；不引入新机制。
**量化**：无运行时收益；降低后续 UI 改动漂移风险。
**风险**：近零（纯文档）。

---

## 评分规则（供投票 agent 使用，25 分制五维×5）

1. **收益规模**（量化后对用户可感知程度）
2. **证据实证度**（file:line + 实测数据完备性）
3. **实施风险与回归面**（越小越高）
4. **实施可行性**（改动面/边界清晰度/验收可执行性）
5. **与治理目标契合**（AGENTS.md：核心只做缺陷修复/安全/性能；/plugin-first 边界）

## 投票结果（2026-11-01 多 agent 工作流实测回填）

5 位独立评审（性能/稳定性/前端架构/产品体验/实施风险）+ 独立复核员，25 分制×5 维。**胜选 C2（112.5/125），次优 C3（111.5），C1 第三（98）**。

**评审实证纠正的勘探错误（诚实记录）**：
1. C1 证据两处口径错误：dist main 内动态 `import("./codemirror` 实测 **28 条**（各语言懒加载器，grep 实证）非本文所写 0 条；静态边漏 **2 条**——NarrowTabOverlay.tsx:25→EditorPanel.tsx:6→Editor.tsx 与 useAppInit.ts:35→Editor、plugin-system/index.ts:43→builtinPlugins.ts:7 运行时边；修法 1（App 直引 NarrowTabOverlay）断不开 NarrowTabOverlay→EditorPanel 链。C1 收益基线仍成立（chunk 1,017,611B 精确吻合）但须二次勘探补全 4-6 条链。
2. C5 勘探「零 hex 违例」被证伪：`DynamicIsland.css` 实测 5 处（:554、:558、:916、:917、:1022）——我此前 grep 只扫了 .tsx 漏了 .css。
3. C4 的 8s 基线为 10-31 历史口径，生产存量已清理（现 82 会话/12MB），收益绝对值缩水；且 continue_session 紧邻 AGENTS.md §4.2 中断幂等红线。

**实施定案与结局**：
- **C2 胜选立项并已实施合并**：独立工作树实施（workflow 实施工匠 2 提交）→ 五重门禁（tsc / lint 0 error / 定向 vitest 24 文件 / 全量 vitest 139 文件 / diff 零 src-tauri）→ 独立评审员 8 项全过 0 阻断（5 条非阻断后续项见下）→ `--no-ff` 合并 main（f37bc373）。评审后续项（不阻塞）：① appendQuestionBlock/appendPlanModeBlock/appendAgentRunBlock/appendPermissionRequestBlock 四入口补同款 thinking flush（与 main 的 text 暴露面对称的既有窗口）；② session_end HTML 卡片转换先于 finishMessage 的 ≤50ms 展示顺序窗口；③ createConversationStore.ts:1024-1025 注释前提在 error→session_end 窗口欠精确；④ 超出 spec 的 4 个 flush 点无专门测试（低风险同款一行模式）。
- **C1 不由本轮实施**——并行会话在 `.worktrees/fe2-codemirror` 按自有管线实施并已合并 main（c0a6bd61，46/50 四重门禁+独立复核），其 spec 勘探出九条边（比本文三链多 6 条）。
- C3（111.5 次优）遗留为下轮首选候选；C4/C5 低优先。
