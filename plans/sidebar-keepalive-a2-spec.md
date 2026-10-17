# Spec：左侧栏保活 + 高密度 Tab 带侧栏（方案 A²）

> 对应 PRD 原型：`plans/sidebar-keepalive-a2-high-density.html`（A2，已发布 PRD 预览）。
> 用户已定方向：**方案 A（顶部 Tab 带侧栏）+ 高信息密度**（strip 32px、贴合内容宽度、少空白）。
> 本 spec 同时解决两个问题：① 切换/关闭重开面板内容被刷新（保活）；② 顶部 tab + 一键折叠 + 状态记忆 + 高密度。

## 问题现状（已确认根因）

- `App.tsx` 的 `panelContentType` 用 `lastLeftPanelTypeRef` 记忆上次非 none 类型 → **关闭/重开同类面板不刷新**（外壳隐藏，children 仍渲染）。
- **切类型**（files→git→files）时 `LeftPanelContent` 只返回当前类型 JSX（`{builtinPanels[type]}`），切走即卸载，切回**重建**：
  - GitPanel 的 `activeTab` / `selectedRepoPath` / `selectedDiff` / 勾选 / 滚动是组件本地 `useState` → 重置为初始态。
  - FileExplorer 的展开目录树节点（若组件本地态）同理会重置。
- **结论**：要真正保活，必须**多面板常驻挂载、只切 display**（VSCode view-container 模型）。

## 目标

1. **保活**：所有已挂载面板（含插件面板）常驻 React 树，切换仅改 display 显隐；面板自有临时状态（勾选、展开、滚动、Git diff 选择）跨切换与跨折叠保留。
2. **高密度顶部 tab strip**：32px 高、11px 字、贴合内容宽度零空白；固定核心 tab（复用现有 activityBar panelButtons 顺序）+ MRU 追加 tab + 溢出 ⋯ 面板（新概念，带分组网格）。
3. **一键折叠**：top 箭头按钮 + Ctrl+B；折叠后 10px 悬停热区唤起，鼠标悬停即展开（不落盘，记忆面板状态）。
4. **入口语义不动**：ActivityBar 图标列保留，「点图标 = 切换 + 再点当前 = 折叠」现有语义，新增顶部 tab 作为第二入口。

## 状态模型（唯一权威）

- **新增 viewStore 字段**（持久化）：
  - `leftPanelTabs: LeftPanelType[]` — strip 固定序 + MRU 序（≤ MAX_TABS=5，slice 首 5 可见）。
  - `leftPanelPinned: LeftPanelType[]` — 固定核心（默认现 panelButtons 前 4：files/git/browser/terminal；可持久化）。
  - `leftPanelMru: LeftPanelType[]` — 从 more popover / 溢出入口打开过的面板集（追加到 strip 尾，可 × 关闭）。
- **面板临时状态归属**：保持在各自面板组件内部（组件本地 `useState`），保活由「常驻挂载」保证，不需要状态上浮到 viewStore。**仅 strip 序、激活 tab、折叠态属于 viewStore。**
- **激活面板**：沿用 `leftPanelType`（不变，ActivityBar 与 tab 共用同一权威）。

## 组件拆分

| 文件 | 改动 |
|---|---|
| `src/components/Layout/LeftPanelTabStrip.tsx`（新增） | 高密度 strip：折叠按钮 + 固定 tab + MRU tab（可关）+ 溢出 ⋯ + 分组网格 popover；32px 高；数据源 |
| `src/components/Layout/LeftPanel.tsx` | strip 插入 `<aside>` 顶部（仅桌面形态）；`panelVisible=false` 时整体隐藏（现状保活不变） |
| `src/components/Layout/LeftPanelContent.tsx` | **从单面板分发改为多面板常驻**：渲染全部已激活面板（试图遍历注册表），各包 `<div className="hidden">` 只切显隐 |
| `src/components/Layout/ActivityBar.tsx` | 点图标逻辑复用 `toggleLeftPanel`（现语义不动）；若有折叠热区冲突需确认 z-index/DOM 序 |
| `src/components/Layout/toolSwitcherData.tsx` | 导出 `panelButtons`（供 strip 取顺序/标签/图标），不迁移其 onSelect |
| `src/stores/viewStore.ts` | 新增 `leftPanelTabs` / `leftPanelPinned` / `leftPanelMru` 字段与 actions（`pinTab` / `unpinTab` / `openMruTab` / `closeMruTab` / `setLeftPanelCollapsed` 复用 `leftPanelType`） |
| `src/App.tsx` | `leftPanelContent` 改传全部面板（不再 `currentType` 单选）；strip 只渲染于桌面（`isCompact` 时抽屉已有工具栏） |

## 关键机制（跨进程/时序）

- **保活渲染**：`LeftPanelContent` 遍历 `panelButtons`（内建 + 插件）渲染**所有**面板 JSX 到 hidden 容器；激活者移除 hidden。**懒挂载**：首次激活某面板才渲染（防冷启动全量挂载 12+ 插件的开销）——用一个 `mounted: Set<LeftPanelType>` 局部缓存（App.tsx 级 useRef，非持久化）。
- **懒挂载 + 保活共存**：`LeftPanelContent` 内部维护 `mountedRef`；对未 in `panelButtons` 的 `leftPanelType` 兜底走 `pluginPanelRegistry`。
- **折叠**：折叠只切 aside 宽度（现状 `hidden` 类改为宽度过渡），不卸载 children；strip 折叠态 → 缩小为折叠按钮，靠 10px rail 悬停唤起。
- **MRU 溢出**：`MAX_TABS=5`，>`slice(0,5)` 的部分入 ⋯ 分组网格（按用途分组：核心/工作区/系统）；点分组项 `openMruTab` 追加到 strip 尾。
- **冲突面**（避免回归）：
  - 现有 `lastLeftPanelTypeRef` 逻辑在 `LeftPanelContent` 多面板化后**删除**（保活由 mounted 集合接管）。
  - `terminalFullscreen` / `fillRemaining` 宽度逻辑不动。
  - 插件面板 `pluginPanelHost` 已常驻挂载的，多面板化后要避免双挂载（同一面板类型只挂一处）。

## 验收

1. 打开 git → 切 files → 切回 git：`activeTab` / 选中 diff / 勾选文件 / 滚动位置全部保留。
2. 打开 git → 折叠 → 展开（Ctrl+B / 悬停 rail）：git 面板状态与上次展开完全一致。
3. 折叠后悬停 10px rail 展开，不触发任何重挂载（React DevTools 无 remount）。
4. 从 ⋯ 打开非固定面板（如需求）→ strip 出现 MRU tab → 点 × 关闭 → tab 消失，面板数据保留。
5. strip 信息密度：32px 高、无多余空白；面板过多时溢出入 ⋯，strip 从无截断。
6. ActivityBar 旧入口仍可用（点图标切换 + 再点折叠），与 strip 双入口状态同步。
7. `pnpm exec tsc --noEmit` + `pnpm lint` 通过；有 vitest 覆盖新 actions。

## 不做（边界）

- 不引入「是否可见即挂载」之外的常驻策略（不 preload 全部面板）。
- 不改 ActivityBar 的 `panelButtons` 注册机制（插件面板顺序来自 `pluginRegistry.listViewContributions` 现状）。
- 不把面板内部临时状态上浮（滚动、勾选、展开是组件本地态，由常驻挂载保证）。
- 不新增「把 tab 从 strip 底部拖拽排序」的拖拽能力（原型无此交互）。
- 小屏抽屉形态（isCompact）不渲染 strip（抽屉已有工具栏）。