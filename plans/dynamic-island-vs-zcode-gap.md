# 灵动岛对标 ZCode：水平差距与实施规划

> 状态：**规划中（未实施）**，配套可交互原型 `temp/dynamic-island-prototype-v2.html`
> 来源：`temp/ZCode` v3.15.1 快照源码 + `docs/ui/side-pane-full-view.md` spec + Polaris 现有实现逐项对照
> 网络备注：拉取 ZCode 最新 main 时 GitHub 走代理 TLS 握手失败（2026-10-28，verge-mihomo @7897 对 github.com 域整体不可达），以下基于本地快照分析，不因网络阻塞交付
> 范围：纯前端，零协议改动（与 change-summary 一期同目录）

---

## 〇、结论先行

Polaris 动态岛在**数据派生（纯函数 + 零写路径）、紧急度分层、内联审批**上不输 ZCode，甚至更深；差距集中在**形态与工程细节**：

| 维度 | ZCode 更强 | Polaris 现状 | 结论 |
|---|---|---|---|
| 浮窗形态 | 三态（minimized 圆球 / collapsed 露输入条 / expanded 抽屉）可拖拽吸附 | 贴顶 absolute 胶囊 | **最大差距，本方案第一期** |
| 回答气泡 | 收起态下 answer bubble 两行预览，点开/关 | 无 | 第二期 |
| Live tail | 最后一个 running 回合拆出虚拟列表 normal-flow，防轮尾跳动 | 流式块直接 merge 进 Virtuoso | 第二期（滚动层细节） |
| 滚动权 | use-stick-to-bottom + 滚动记忆 | 锚点模式（已很成熟） | **不输，不重做** |
| urgent 决策 | 收起态自动恢复弹卡，无内联 | 内联批准/拒绝/跳过 | **Polaris 更深** |
| 动画 | motion/react + WAAPI + useReducedMotion | 仅 CSS transition/keyframes | 第二期补 useReducedMotion |
| 工程 | i18n + data-testid E2E 全套 | 中文硬编码 + 纯单测 | 第三期（桌面可达性） |

---

## 一、现状依据（已核实）

- Polaris 灵动岛：`src/components/Chat/dynamic-island/`（`index.tsx` 状态机 `hidden→compact→expanded→collapsed→resident`；`useRuntimeSummary.ts` 纯派生 + `shallowEqualSummary` 浅比较快照 + 1s tick 计时；`DynamicIslandExpanded.tsx` 三分节 tab；`changeSummary.ts` 会话文件变更流水）。
- 挂载：`SessionMessagesView.tsx:274`，`absolute top-0 left-1/2 translateX(-50%)`，Virtuoso Header 36px 占位（`ISLAND_HEADER_SPACER_STYLE`）避首条消息。
- 消息列：react-virtuoso 虚拟列表 + `useMessageAutoScroll` 锚点模式（滚动权 = 用户输入，非几何快照；距底 ε=48px；`suspendFollow` 豁免窗）。
- ZCode 对照物：
  - `temp/ZCode/packages/ui/src/side-pane-full-view/ConversationHost.tsx`（610 行，host 三态浮窗）
  - `model.ts`（浮窗几何/吸附/拖拽）、`contract.ts`（类型契约）、`conversationPanePresentation.ts`（presentation 上下文）
  - `temp/ZCode/packages/ui/src/v4/conversationTimelineLiveTail.ts`（74 行，live-tail 拆分 + 摘要同源）
  - `ConversationStatusPanel`（四节状态面板）+ `WorkflowRunRail`（侧栏 run 迷你轨道）
  - spec：`temp/ZCode/docs/ui/side-pane-full-view.md`

---

## 二、第一期：浮窗三态（Polaris 从「贴顶附属」→「画中画」）

### 2.1 目标

动态岛（连同展开面板）不再固定贴顶，升级为可拖拽浮窗，三种形态：

```
minimized（圆球 48px） ←── 拖拽 + 吸附 8 锚点
   │  点击 / 阻塞交互自动恢复
   ▼
collapsed（只露底部输入条）── hover/focus 抽屉上滑（操作栏）
   │  展开
   ▼
expanded（全高抽屉，宽 min(560px, slot−32)，高 min(640px, slot−32)）
```

### 2.2 设计定案

| 决策点 | 定案 | 否决的备选 |
|---|---|---|
| 挂载方式 | 保持 `SessionMessagesView` 内单实例，宿主容器改 `position:fixed`，只改定位不改 DOM | 独立 portal 到 body（丢失 per-session 订阅上下文、权限卡依赖对话 context） |
| 几何写入 | **直接写 host style（CSS 变量），不进 React state**（ZCode `ConversationHost.tsx:242` 同款） | React state（拖动 60fps 重渲染对话树） |
| minimized↔恢复过渡 | 几何直接到位 + WAAPI opacity/scale 0.92→1（150ms），**不做宽高 transition** | CSS transition left/top/width/height（单行输入框折行 → 测高跳动，ZCode 实测踩过） |
| 拖拽判定 | pointer capture + 位移阈值 4px（`FLOATING_DRAG_CLICK_THRESHOLD_PX`）：拖动 vs 点击（点击 = 恢复/打开菜单） | 分离 drag/click 事件 |
| 吸附锚点 | 8 点（左上/右上/左中/右中/左下/下中/右下），与 slot 边 16px；顶部位置向下展开、底部向上 | 自由坐标记忆（复杂度不值） |
| 阻塞自动恢复 | 新的 permission/question/plan pending（new id）时 minimized 自动 → collapsed | 靠用户手动 |
| 状态记忆 | per-session 内存记忆 `{surface, floating}`，刷新不保留 | localStorage（会话运行态是瞬时事实） |

### 2.3 数据流（单向，复用现有派生）

```
sessionStore.currentMessage.blocks（唯一真相）
  ↓  现有 deriveRuntimeSummary / deriveChangeSummary（零改动）
RuntimeSummary { urgent, running, slides, changeSummary, ... }
  ↓  新增：上报给 host 的状态子集
{ running: boolean, blockingInteractionId: string|null, ownerKey: string }
  ↓
ConversationHost（新增组件）
  ├─ minimized 圆球（含运行态 loading 图标）
  ├─ collapsed 输入条（浮窗外壳即输入框）
  └─ expanded 抽屉（窄消息流 = 原展开面板内容）
```

**关键**：`DynamicIslandExpanded` 的三分节 tab（运行/变更汇总/后台任务）整体复用为浮窗展开态内容，不改其内部；只加一层 host 定位壳。

### 2.4 新增文件（预估 ≤400 行生产代码 + 测试）

| 文件 | 内容 |
|---|---|
| `src/components/Chat/dynamic-island/floatingHost.tsx`（新增） | 浮窗宿主：三态壳、拖动、吸附、几何写 style、阻止自动恢复 |
| `src/components/Chat/dynamic-island/floatingHost.model.ts`（新增） | 吸附计算、尺寸解析、clamp、锚点解析（纯函数，自带单测） |
| `src/components/Chat/dynamic-island/floatingHost.css`（新增） | 三态几何 / 抽屉滑出 / WAAPI 不用额外动画 |
| `dynamic-island/index.tsx`（改） | 包一层 host：`isFloating` 决定贴顶 or 浮窗；上报状态子集 |
| `dynamic-island/DynamicIslandExpanded.tsx`（改） | 抽窄消息流视图（复用现 tab，宽 560 时同布局） |

### 2.5 验收清单（一期）

- [ ] 拖动圆球/操作栏 60fps，橡皮筋 clamp；松手吸附最近锚点
- [ ] minimized→collapsed 无宽高过渡跳跃，输入框不折行
- [ ] 新的权限/问答请求在 minimized 时自动恢复为 collapsed 并弹卡
- [ ] 展开态内容 = 现有面板三分节（回归不破坏）
- [ ] `pnpm exec tsc --noEmit` + `pnpm lint` + island 目录 vitest

---

## 三、第二期：回答气泡 + Live tail（体验细节）

### 3.1 回答气泡

ZCode `ConversationHost.tsx:431-462` 同款：collapsed 态下，上一轮回答结束后在浮窗上/下方弹圆角气泡，`line-clamp-2` 只显示正文前两行，点 × 关、点开 → expanded。

- **唯一事件源**：复用现有 `RuntimeSummary.changeSummary`/messages 派生，从最后一个 assistant 消息取 `complete` 的文本行，与运行状态同源（对照 ZCode `resolveConversationLatestTurnSummary` 的「避免两个源先后不一致」意图）。
- 基线：离开浮窗形态时清空，回到浮窗重建；已结束的回合算看过，运行中不算。
- 此能力**价值中等**（Polaris 用户多在展开态看结果），但对"最小状态仍感知 AI 进展"是有力补充，与 change-summary 常驻胶囊互补。

### 3.2 Live tail

ZCode `conversationTimelineLiveTail.ts` 两件事：
1. 最后一个 running turn 从 Virtuoso 数据抽出 normal-flow（`splitConversationTimelineLiveTail`），消「正文长高→RO 下一帧回填→轮尾 ChatLoading 跳动」。
2. 状态/时长/回答同一 render unit 来源。

Polaris 现值：`displayMessages` 流式 merge 进 Virtuoso，无 live-tail 拆分。**但** Polaris 用 `ThinkingOrb`（footer spinner）+ 锚点滚动已缓解轮尾跳动，实际跳帧场景（长包头文本）需复测确认。此期先**做诊断**，确诊再补拆分。

---

## 四、第三期：无障碍 / i18n / E2E（低成本补齐）

- `useReducedMotion` 尊重系统减少动效（ZCode expand/normal tab 已用），CSS 复杂动画降级为 fade。
- 关键操作补 `data-testid` + aria-label（minimized 圆球、抽屉、回答气泡 ×）。
- 浮窗三态拖拽/吸附/自动恢复加 1 条 Playwright E2E；Polaris 目前无 E2E 基建，此期需先立最小 E2E 骨架。

---

## 五、不做的事（边界）

- **不引入 motion/react**：Polaris 动画均为 CSS transition/keyframes，一期浮窗用 WAAPI（`host.animate`）即可，加库为二期决策。
- **不把浮窗做成全局/跨窗口**：per-session 每格独立（与现岛一致），多窗口各拖各的。
- **不再建第二套变更汇总口径**：浮窗展开态直接复用现有 changeSummary 数据。
- **不做完整视图抽屉**（ZCode 的「面板占满 + 浮窗输入」布局改动）：一期只在消息区顶部做浮窗，布局主体不动。

---

## 六、实施阶段表

| 阶段 | 内容 | 估量 | 门槛 |
|---|---|---|---|
| 一期 | 浮窗三态宿主 + 吸附拖拽 + 阻塞自动恢复 | ≤400 行 + model 单测 | tsc + lint + island vitest |
| 二期 | 回答气泡；live-tail 诊断（确诊才补拆分） | ≤200 行 | 同上 |
| 三期 | useReducedMotion + testid/aria + 最小 E2E 骨架 | 中 | 同上 + E2E 跑通 |

预留依赖：一期在 `dynamic-island/` 目录内自洽，不触碰 `SessionMessagesView` 之外的文件；插槽（cap.self.mutate）+ P3（cap.bash 生命周期）与本方案正交。

---

## 七、配套原型

`temp/dynamic-island-prototype-v2.html`（可交互单文件）演示一期 + 二期全部交互：
- 三态切换（minimized 圆球可拖拽吸附 / collapsed 露输入条 / expanded 抽屉）
- 回答气泡（两行预览、×关、点开展开）
- urgent 内联审批（复用现有卡样式）
- 状态轮播 + 常驻变更段（现有 v3 能力不回归的验证）