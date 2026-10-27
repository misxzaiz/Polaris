# 悬浮岛会话变更汇总（dynamic-island change summary）方案

> 状态：**P1+P2 已实施**（2026-10-27，未提交）；P3 未实施
> 原始方案：2026-10-27 定案 + 交互原型；实施记录见文末第十二节
> 范围：纯前端，零协议改动
> 参照：temp/ZCode TUI `app-sidebar-modified-files.tsx` / `app-modified-files.ts` / `core/src/tool/executor/result-display.ts`

## 一、目标

悬浮岛（DynamicIsland）当前空闲即消失（`index.tsx:226` `isIdle → return null`），用户无法随时知道"本次会话 AI 改了什么、有什么还在后台跑"。目标：

1. 悬浮岛**常驻**：任何状态下都有一条 compact 胶囊，右侧固定显示本次会话变更汇总（文件数 / +N −M / 后台任务数）。
2. expanded 面板新增「变更汇总」「后台任务」分节：文件级明细（操作类型、增删行数、次数）、后台 bash 任务（命令、状态、可停止）。
3. 历史会话可回放同一汇总（数据来自持久化 blocks，天然支持 session-v2 跨端对账）。

**非目标**：不做 git 快照口径（留给 GitPanel）；不追踪 bash 内部的文件操作（rm 等）；一期不改 AIEvent 协议。

## 二、定案（与备选对比）

| 决策点 | 定案 | 否决的备选 |
|---|---|---|
| 聚合方式 | **纯派生函数**，从 conversationStore 已有 messages 扫描 | 增量维护 store 新字段（多一条写路径，违背单一权威）；后端聚合（动协议，需双边同步） |
| diff 数值口径 | **工具流水累加**（同文件多次编辑累加 +N −M，ZCode 同款近似） | git diff 快照（依赖仓库与时机，二期可选增强） |
| 常驻形态 | compact 条**双段式**：左状态段（复用现有状态机）+ 右变更段（常驻） | 独立第二个悬浮组件（重复占位、遮挡） |
| 后台任务一期 | 仅聚合 `ToolCallBlock.taskId` + 工具卡状态 | 新建全局任务 store（违背 executionConsoleStore 已确立的"只读观测、订阅源 store"原则） |

## 三、现状依据（已核实）

- 悬浮岛：`src/components/Chat/dynamic-island/`（`index.tsx` 状态机；`useRuntimeSummary.ts` 纯派生 + `shallowEqualSummary` 浅比较快照；挂载 `SessionMessagesView.tsx:272-274`，消息区顶部 absolute 居中）。
- 数据已在流里：`ToolCallStartEvent.tool+args`（含文件路径）、`ToolCallEndEvent.result/success`、bash 后台 `task_id` 透传（`src-tauri/src/models/ai_event.rs:107-236`）。
- 块级 diff 已有：`ToolCallBlock.diffData`（edit 类，前端 `diffExtractor.ts` 支持 Claude/Pi/SimpleAI 四种格式）/ `patchData`（apply_patch 多文件，per-file added/removed），写入点 `eventHandler.ts:609-623`。
- 工具名归一已有：`src/utils/diffExtractor.ts`（isEditTool/isWriteTool）+ `src/utils/toolSummary.ts`（TOOL_NAME_MAP 多引擎映射）。聚合必须复用，禁止第三套名字表。
- 持久化可回放：`src/services/dialogStorage/jsonlCodec.ts` 保存 assistant.blocks（含 tool_call）。
- 后台素材：`conversationStore.backgroundSessionIds`、`executionConsoleStore`（只读观测层范式）、`CompactHandoffStore`。

## 四、数据模型与派生

新增 `src/components/Chat/dynamic-island/changeSummary.ts`（目标 ≤250 行含测试外逻辑）：

```ts
export interface SessionFileChange {
  filePath: string;
  addedLines: number;      // 流水累加
  removedLines: number;
  ops: Array<{ kind: 'edit' | 'write' | 'delete' | 'patch'; at: number; blockId: string }>;
  lastOpAt: number;
}

export interface SessionChangeSummary {
  files: SessionFileChange[];   // lastOpAt 降序（MRU），上限 100（ZCode 同款）
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  backgroundTasks: Array<{
    taskId: string;
    label: string;              // bash 命令摘要
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
  }>;
}

export function deriveChangeSummary(messages: Message[]): SessionChangeSummary;
```

派生规则（扫描 assistant 消息的 tool_call 块）：

| 工具（归一后） | 判定来源 | 数值来源 | op |
|---|---|---|---|
| apply_patch | `name === 'apply_patch'` | `block.patchData[]` per-file added/removed（现成） | 按 patch 文件类型 add/update/delete |
| edit 类 | `isEditTool(name)`（diffExtractor） | `block.diffData` 行数差；缺失时 input old/new countLines（同 `toolSummary.ts:376-411` 现有兜底） | edit |
| write/create | `isWriteTool(name)` | input.content 或 output 行数 | write |
| delete | name 含 delete_file / DeleteFile | — | delete |
| bash 后台 | `block.taskId` 存在 | — | 计入 backgroundTasks（状态一期取工具卡终态近似） |

**Memo 策略**：`WeakMap<消息数组引用, summary>`，消息引用不变即复用；岛侧沿用 `useSyncExternalStore` + `shallowEqualSummary` 扩展变更段字段。不做每 token 重扫。

## 五、岛状态机扩展

新增**常驻 idle 形态**：`isIdle` 不再 `return null`，渲染 compact 胶囊。左状态段复用现有状态机，右变更段常驻：

| 阶段 | 左状态段 | 右变更段（常驻） |
|---|---|---|
| idle（新增常驻） | ✓ 就绪（muted） | `8 文件 +142 −36 · 1 后台`；无变更显示「0 变更」弱化 |
| thinking | ● 思考中… | 同上 |
| running | ⟳ 正在编辑 shell.ts（多工具沿用 3s 轮播） | 同上（工具完成即实时累加） |
| urgent | ⚠ 需要你 · 权限请求（内联批准/拒绝，现有能力） | 同上 |
| done | ✓ 已完成 · N 项（5s 后回 idle 常驻） | 同上 |
| interrupted | ⊘ 已中断 | 同上 |

布局代价：`SessionMessagesView` 消息区顶部需为常驻胶囊预留固定留白（现 padding 需 +~44px），避免遮挡首条消息。

## 六、交互设计（见对话内原型）

- **compact**：点击任意处展开；urgent 时胶囊描边高亮并可内联批准/拒绝。
- **expanded**（宽 min(520px, 100%−32px)，点击外部/Esc 收起，沿用现有交互）：
  - Tab「变更汇总」（默认）：每行 = 操作图标（edit/write/delete/patch）+ 路径（中段截断）+ 次数 chip（如「3 次编辑」）+ `+N −M`；点击行滚动定位到对应 tool_call 块（blockId 已具备）。空态与口径脚注（"仅统计结构化文件工具"）。
  - Tab「后台任务」：每行 = 命令摘要 + 状态徽标（运行中计时/已完成含结果摘要/失败）+ 运行中可「停止」。
  - 底部保留现有上下文水位条。
- 会话切换（`sessionStoreManager`）时汇总自动跟随当前会话，无需额外状态。

## 七、后台任务分期

- **一期（本方案）**：聚合 `ToolCallBlock.taskId` + bash 工具卡终态。局限：后台任务真正退出（非工具调用结束）无独立事件，状态为近似。
- **二期（可选）**：cap.bash 补 `bash_task_lifecycle` 事件（started/exited/code），岛实时刷新。届时同步 `ai_event.rs` + `src/types/` 双边类型，并更新 `plans/two-bus-architecture.md` 能力清单。

## 八、口径与边界（如实交代）

1. **流水口径 ≠ 真实 diff**：同文件先 write 后 edit 会重复计数；UI 标注「按工具操作累加」。与 git 的对账留给 GitPanel。
2. **盲区**：bash 内 rm/mv/sed、git 操作不计入；UI 脚注注明。
3. **性能**：大会话全量扫描由 memo 兜底（消息引用不变不重算）；上限 100 文件防膨胀。
4. **协议零改动**（一期）；工具名归一复用现有两层，不新增映射表。

## 九、实施阶段

| 阶段 | 内容 | 估量 |
|---|---|---|
| P1 | `changeSummary.ts` 派生 + 单测；岛常驻 idle 态 + compact 变更段；expanded「变更汇总」tab | 核心 ~250 行 + 测试；UI 中等 |
| P2 | expanded「后台任务」tab（聚合 taskId）；停止按钮接现有 bash 停止链路 | 小-中 |
| P3（可选） | cap.bash 生命周期事件 + 真实退出状态；git 快照口径对账开关 | 涉后端，中-大 |

验证门槛（AGENTS.md）：`pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test:run`（新增/扩展 `useRuntimeSummary.test.ts`、新增 `changeSummary.test.ts`）；无后端改动则免 cargo。

## 十、验收清单

- [ ] deriveChangeSummary 单测：四引擎工具名归一、apply_patch 多文件、同文件累加、MRU 排序、100 上限、空会话、bash rm 不计入
- [ ] useRuntimeSummary 浅比较覆盖新增变更段字段（岛不闪烁）
- [ ] 手动：idle 常驻可见且不遮首条消息；长会话滚动流畅；历史会话打开汇总正确；会话切换汇总跟随
- [ ] 320px 宽度 compact 条不溢出（复用轮播截断约束）
- [ ] urgent 优先级不被常驻段破坏（现有 urgent 常驻逻辑回归）

---

## 十一、v2 修订：结合项目规划的最佳方案（2026-10-27 第二轮）

> 本节把方案放到 Polaris 既有规划坐标系里复核，结论：架构方向不变，补齐集成边界。交互原型升级为双视图（「交互原型」+「方案蓝图」），蓝图视图即本节数据流/路线图/决策表的可视化。

### 11.1 架构定位（与既有规划的关系）

| 既有规划 / 模块 | 关系 | 边界约定 |
|---|---|---|
| `bottom-dock-panel-plan.md`（底部 Dock） | **互补不重叠** | 岛只做常驻轻摘要 + 快速出口；后台任务重型明细（完整日志/停止/历史）归 Dock / 执行控制台。岛「后台任务」tab 仅摘要级，提供「在控制台打开」跳转，避免建设第二份重型 UI |
| session-v2（Reconcile 日志即真相） | **免费受益** | 汇总是 messages 的纯派生；跨端对账后 blocks 一致 → 汇总自动一致，**不新增任何同步字段** |
| `two-bus-architecture.md` / cap 总线 | P3 才涉及 | 若补 bash 任务生命周期事件，走 cap 总线新增事件，同步 two-bus 能力清单 + `ai_event.rs`/`src/types` 双边类型 |
| executionConsoleStore | 只读订阅 | 沿用其「观测层不复制状态」既定原则；**不新建**全局任务 store |
| GitPanel | 口径分工 | 岛 = 工具流水口径（即时、无仓库依赖）；GitPanel = git 快照口径（真实）。二期可在 expanded 加「与 git 对比」入口，不复制 diff 逻辑 |
| 巨型文件治理（AGENTS.md 九） | 约束 | 新逻辑独立 `changeSummary.ts`（≤250 行），不肥 `index.tsx`（359 行）/ `useRuntimeSummary.ts`（856 行） |

### 11.2 数据流（所有者与方向，全程单向）

```
AI 引擎（工具执行 edit/write/apply_patch/bash）
  ↓  AIEvent tool_call_start/end（args / result / taskId）      —— 协议零改动
eventHandler：diffData / patchData / taskId 写入块               —— 现有，eventHandler.ts:609-623
  ↓
conversationStore.messages ＝ 唯一真相（JSONL 持久化，session-v2 对账）
  ↓  纯派生 · 只读 · 零新写入路径
deriveChangeSummary(messages)（WeakMap memo，消息引用不变不重算）  —— 新增 P1
  ↓
useRuntimeSummary 浅比较快照扩展（变更段字段）                     —— 扩展 P1
  ↓
DynamicIsland 常驻双段胶囊 ＋ 展开「变更汇总 / 后台任务」双 tab     —— 改造 P1

旁路：executionConsoleStore（后台任务）→ 岛后台 tab；GitPanel（git 快照）→ 二期对账入口
```

要点：**全程零新写入路径**（派生只读）；**P1/P2 协议零改动**；唯一动协议点是 P3 的 cap.bash 生命周期事件。

### 11.3 关键决策（第二轮复核，均维持第一轮定案）

| 决策点 | 定案 | 否决/延期理由 |
|---|---|---|
| 聚合方式 | 纯派生函数 | store 增量字段 = 新写路径，违背单一权威 |
| diff 口径 | 工具流水累加 | git 快照依赖仓库与时机，二期作对账增强 |
| 常驻形态 | 双段胶囊（岛内） | 独立第二悬浮组件重复占位、遮挡对话（与 bottom-dock 方案 0.2 论证同理：Polaris 主轴是对话） |
| 后台状态 | P2 用 taskId 工具卡近似 | 真实退出事件留 P3，避免一期动协议 |
| 重型明细归属 | Dock / 执行控制台 | 岛内展开完整日志会让常驻组件职责膨胀 |

### 11.4 工件与实施入口

- 交互原型（会话内双视图）：「交互原型」= Polaris 窗口模拟可操作；「方案蓝图」= 数据流 + P1-P3 路线图 + 决策表。
- 本 spec 评审通过即视为 AGENTS.md「先立规范」完成；实施时按第九节阶段表走，门槛 `pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test:run`。

---

## 十二、实施记录（2026-10-27，P1+P2）

### 落地文件

| 文件 | 变更 |
|---|---|
| `dynamic-island/changeSummary.ts`（新增） | 纯派生核心：文件操作聚合（edit/write/delete + apply_patch 映射）、后台任务聚合（taskId upsert）、WeakMap 历史缓存、lastDiff 行内预览内容（MAX_DIFF_CHARS=8000 截断） |
| `dynamic-island/changeSummary.test.ts`（新增） | 15 用例：多引擎名归一/累加/MRU/上限/failed 排除/启动回执≠结束/缓存不污染/截断 |
| `dynamic-island/useRuntimeSummary.ts` | RuntimeSummary 增 `changeSummary` 字段；getSnapshot 传入派生结果；shallowEqualSummary 扩展逐项比较 |
| `dynamic-island/index.tsx` | isIdle 不再 return null → 常驻胶囊；collapsed 停留 5s 转常驻（删 island-exiting 淡出）；compact 增常驻变更段 ChangeDelta |
| `dynamic-island/DynamicIslandExpanded.tsx` | 明细区改三分节 tab；ChangeList（行展开 diff + 编辑器打开）；TaskList（只读列表 + 控制台跳转） |
| `dynamic-island/DynamicIsland.css` | 删 island-exiting；增变更段/tab/变更行/diff 预览/任务行样式 |
| `messages/SessionMessagesView.tsx` + `chatUtils/constants.ts` | Virtuoso Header 增 36px 顶部占位，防常驻岛遮首条消息 |

### 与方案的偏差（如实记录）

1. **expanded 为三分节 tab**（运行/变更汇总/后台任务），非方案的双 tab：保留 v2 运行明细卡避免功能回归；tab 默认懒选（有运行态→运行，否则变更汇总）。
2. **后台任务为只读近似列表（P2 范围再收缩）**：曾实装 cap.bash `status` 对账 + `kill` 停止，评估后按用户反馈移除（交互体验不理想：状态近似、kill 后无回执更新）。现 TaskList 仅聚合展示（running = 已启动、生命周期未知；failed = 启动失败）+「在控制台打开」跳转。**状态对账、停止交互与 cap.bash 生命周期事件一并后置，待 P3 重新设计**。
3. **追加增强（用户要求）**：变更行点击展开行内 diff 预览（复用 diff v8 `diffLines`，与 InlineDiffView 同库；MAX_DIFF_ROWS=200 行护栏）；行侧「在编辑器打开」按钮（`fileEditorStore.openFile` + `resolveWorkspacePath`，删除的文件不提供入口）。

### 验证结果

- `pnpm exec tsc --noEmit`：0 错误。
- island 目录 vitest：20/20 通过（新增 changeSummary 15 用例 + 既有 useRuntimeSummary 5 用例）。
- 全量 `pnpm test:run`：2425 通过 / 1 失败——`fileService.test.ts` 全量跑时报 `connect ECONNREFUSED :3000`；带/不带本改动均复现于全量跑、单跑通过，判定为存量环境依赖失败，与本改动无关。
- eslint 改动文件：0 问题。无后端改动，cargo check 不适用。
