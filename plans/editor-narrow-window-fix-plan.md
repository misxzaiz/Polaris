# 窄窗口下编辑器无法打开 — 根因分析与修复方案

> 结论先行：**这不是一个 bug，是两套互不衔接的布局模型。** 中间编辑区（`CenterStage`）被写死为"桌面专属、可被整棵卸载"，而"打开文件"这条动作链路（`openEditorTab`）完全不感知渲染侧是否还有位置。窄窗口时 tab 会正常创建、编辑器静默不出现，状态层与视图层就此分裂。

---

## 一、关键代码路径（已逐个核实）

| 环节 | 位置 | 现状 |
|---|---|---|
| 宽度判定 | `src/hooks/useWindowSize.ts:42` | `compactThreshold: 500`，唯一阈值 |
| 同步到 store | `src/hooks/useWindowManager.ts:45` | 写 `compactMode.isCompactMode` |
| 编辑器渲染开关 | `src/App.tsx:182` | `hasCenterStage = !isCompact && hasOpenTabs` |
| 卸载条件 | `src/App.tsx:277` | `{!isCompact && hasCenterStage && ... && <CenterStage />}` |
| 编辑器内部兜底 | `src/components/Layout/CenterStage.tsx:667` | `if (tabs.length === 0) return null` |
| 打开文件 | `src/stores/tabStore.ts:120` | `openEditorTab` 无宽度校验，**且 tab 不持久化** |
| 事件侧入口 | `src/hooks/useAppEvents.ts:98` | `file:opened` → 无条件 `openEditorTab` |
| 后端窗口约束 | `src-tauri/src/lib.rs:608` | `inner_size(1200,800)`，**无 `min_inner_size`** |
| 左面板拖拽 | `src/components/Layout/LeftPanel.tsx:36` | `// 拖拽处理（无限制）` |
| 右面板拖拽 | `src/components/Layout/RightPanel.tsx:35` | `clamp(200, 1200)`（有约束） |

---

## 二、根因链

### P0-1 编辑区是"可卸载"的，而打开动作是"无条件"的

```
openEditorTab() ──► tab 进入内存（成功）
                    │
isCompact=true ────► App 不渲染 CenterStage ──► 用户看到：聊天面板 + 空白
```

`CenterStage` 的可见性取决于 `!isCompact`，与 tab 是否存在无关。`openEditorTab` 没有任何前置校验，也不会回滚。结果：**tab 计数、面包屑、`file:opened` 事件全部认为"已打开"，屏幕上什么都没有。**

### P0-2 阈值 500 与实际布局需要的宽度差 231px

窗口中间那行在打开编辑器时的固定开销：

```
ActivityBar            42px + 1px border = 43
左面板默认              280
左拖拽手柄              4
右拖拽手柄              4
右面板默认              400
──────────────────────────────────────────
合计                    731
```

`src/App.tsx:246` 的容器是 `flex flex-1 overflow-hidden`，兄弟节点全部 `shrink-0`。所以：

- **窗口 < 731**：`CenterStage`（`flex-1`）被挤压到接近 0
- **窗口 < 500**：`CenterStage` 直接卸载，编辑器彻底消失
- **500 ~ 731 区间**：这是最阴险的一段 —— 编辑器"存在但宽度为 0"，用户完全无法感知

阈值 500 是按"能放下聊天面板"定的，和"能放下编辑器"是两件事，但代码里只有一个开关。

### P0-3 `CenterStage` 缺少 `min-w-0`，flex 基线撑不回来

```tsx
// CenterStage.tsx:673  无 min-w-0
<main className="flex flex-col flex-1 overflow-hidden bg-background-base">
// CenterStage.tsx:500  无 min-w-0
<div className="flex-1 flex flex-col overflow-hidden">
// Editor.tsx:476  裸 <div>，无任何 className
```

Flex 子项默认 `min-width: auto`（收缩到 min-content）。CodeMirror 里一条不可断行的长行会让 min-content 远大于可用宽度，flex 无法真正压缩，于是整行溢出，外层 `overflow-hidden` 静默裁剪 —— 表现为"编辑器打不开"而非"编辑器被挤没了"。这是该区间问题的直接触发机制。

### P1-4 退出小屏后没有补偿性重建

App 侧只有单向清理，没有恢复：

```ts
// src/App.tsx:144  小屏时 300ms 后关闭左面板
useEffect(() => {
  if (!isCompact || document.hidden) return;
  const timer = window.setTimeout(() => {
    if (useViewStore.getState().leftPanelType !== 'none') closeLeftPanel();
  }, 300);
  ...
```

用户在小屏里"打开"的文件不会重建 tab，回到桌面后 tab 已经不在。而 tab store 不持久化 —— 这个丢失对桌面用户是重启才发生，对窄窗口用户是**每次 resize 都可能发生**。

### P1-5 小屏抽屉里没有编辑器渲染分支

`LeftPanelDrawer`（`src/components/Layout/LeftPanel.tsx:79`）的 `width: min(85vw, 360px)` 会覆盖聊天区，而 `LeftPanelContent` 的分支里全是面板内容，没有"把 CenterStage 塞进抽屉"的路径。所以窄窗口下编辑器的**唯一入口在结构上就不存在**，不是被隐藏，是没接线。

### P1-6 左面板宽度无上界，可人为把编辑区挤到 0

`LeftPanel.tsx:36` 明确写着"无限制"，而 `RightPanel` 有 `clamp(200, 1200)`。两侧不对称：用户把左面板拖宽、或从上次会话继承了 `leftPanelWidth` 大值（`viewStore` 有 persist），叠加后编辑区宽度可能为负。且没有任何地方提示"当前空间不足以显示编辑器"。

> 附注：`viewStore.editorWidth`（百分比字段）在整个 `src/` 下无任何引用，是死代码，可顺手清理。

---

## 三、三档方案

### 方案 A（最小修补，约 30 分钟，推荐先做）

只解决"编辑器被挤到 0 / 打开无反馈"，不引入新交互：

1. `CenterStage` / `TabContent` 编辑分支 / `EditorPanel` / CM 宿主 `<div>` 补 `min-w-0`
2. `LeftPanel.handleResize` 加上界：`Math.max(200, Math.min(width + delta, windowWidth - 480))`
3. `openEditorTab` 前置检查，空间不足时 toast 而非静默创建
4. 窗口 `min_inner_size` 约束（避免用户手动拖到 < 500）

### 方案 B（标准，推荐落地）

方案 A + 让编辑器在小屏可用：

5. 阈值拆两级：`editorNarrow = width < 900`（编辑器降宽/隐藏左面板），`compact = width < 500`（仅聊天）
6. 小屏抽屉支持"编辑器/文件树"子视图，`LeftPanelDrawer` 增加 `editorContent` 分支
7. 编辑区过窄时显示可点击的占位提示，而不是渲染成 0 宽度的空框
8. 退出小屏后若存在"打开请求但无 tab"的记录，补建 tab

### 方案 C（最优，改动大）

9. 把面板宽度从 `viewStore` 里的"绝对像素"改为"比例 + 最小可用宽度"声明，由一个统一的布局求解器在窗口变化时重排并保证约束满足
10. tab store 持久化 + 打开请求与渲染解耦（类似现在 `pendingScrollToId` 的一次性信号模式）
11. 后端 `min_inner_size` + 前端 `useWindowSize` 合并为单一响应式布局源，废弃 `editorWidth` 死字段

---

## 四、验收矩阵

| 窗口宽 | 当前表现 | 目标表现（方案 B） |
|---|---|---|
| ≥ 1000 | 正常 | 正常，回归验证 |
| 900 | 编辑器被压到 70px | 左面板自动收起，编辑器 ≥ 360px |
| 731 | 编辑器 0 宽，看起来"打不开" | 编辑器显示占位提示 + 可点击恢复 |
| 500 | `CenterStage` 卸载，完全空白 | 抽屉内可打开编辑器 |
| < 500 | 同 500，且无入口 | 同上，且打开有反馈 |
| 从 480 拖回 1200 | tab 丢失，需手动重开 | 自动补建 tab |

---

## 五、风险提示

- **不要**简单把 `compactThreshold` 调大。500 是"聊天可用"的下界，编辑器的下界是 731+，两者必须分离，否则调大后聊天面板反而更早变成单列抽屉。
- `min_inner_size` 只能防"用户主动拖小"，防不了分屏/多显示器/缩放比变化（Win 显示缩放 150% 时 `innerWidth` 会等效减半）。前端降级逻辑才是主防线。
- 补 `min-w-0` 会改变长行文件的渲染行为（长行从撑破变为内部横向滚动）。需要回归 Markdown 预览与 Diff split view，这两处依赖宽度溢出。
- tab store 持久化是方案 C 的核心收益，但会引入脏 tab / 不存在文件路径的清理问题，不要与本次修复捆绑。
