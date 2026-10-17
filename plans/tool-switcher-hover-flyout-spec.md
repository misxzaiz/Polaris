# Spec：ToolSwitcher hover 直达 + 高密度三列（v5 落地实现）

> 对应 PRD `plans/tool-switcher-hover-flyout-prd.md`（v5 设计重做）与原型 `plans/tool-switcher-hover-flyout-v5.html`。
> 用户已确认：**保留 hover + click 并存**、**溢出网格 3 列满宽**。

## 目标

把 `ToolSwitcher` 浮层从「单列大列表 + 必点击打开」升级为：
1. **hover 直达**：触发按钮 hover 120ms 展开，移出 300ms grace 收起；click toggle 保留。
2. **高密度三列**：pinned 4 项 icon 大按钮置顶 + 溢出工具 3 列紧凑网格，替代单列 40px 行。
3. **锚定触发按钮**：用 `getBoundingClientRect` 定位替换固定 `left-2 top-11`。
4. **对比度达标**：分组标题 `text-text-tertiary`（不达标反例 `text-muted` 修复）。

## 改动面

| 文件 | 改动 |
|---|---|
| `src/components/Layout/ToolSwitcher.tsx` | 新增 `trigger: 'click' \| 'hover'` prop；布局重构为 pinned + 三列网格；锚定定位；`role="listbox"` |
| `src/components/Layout/ActivityBar.tsx` | more tools 按钮接入 hover 展开回调；按钮 hover 定时器 |
| `src/components/TopMenuBar/index.tsx` | 工具按钮接入 hover 展开回调；按钮 hover 定时器 |

## 契约

- **hover 状态归属**：hover 开关状态提升到父组件（`ActivityBar` / `TopMenuBar`），通过 `isOpen` + `onClose` 传给 `ToolSwitcher`（现有受控模式复用，不加内部 `useState` 竞争）。
- **hover 触发规则**：`trigger='hover'` 时，触发按钮 `onMouseEnter` 120ms 后 `setIsOpen(true)`，`onMouseLeave` + 面板 `onMouseLeave` 300ms 后 `setIsOpen(false)`；面板 `onMouseEnter` 重置 grace 计时器。
- **不抢焦点**：hover 打开时不 `focus` 搜索框；click 打开时保留 `focus({ preventScroll: true })`。通过 `openedByClick` 区分。
- **键盘/触屏回退**：`trigger='hover'` 仅桌面精细指针生效；触屏自然无 hover，click toggle 兜底。
- **锚定**：`getBoundingClientRect` 算 left/top，clamp 到视口内（窄窗兜底）。
- **高度**：flex column + 滚动区 `min-height:0`；唯一 max-height 源 `min(70dvh, calc(100dvh - 64px))`。
- **语义角色**：容器 `role="listbox"` + 项 `role="option"` + `aria-selected`（替换现状非模态 popover 上的 `role="dialog"`）；触发按钮挂 `aria-expanded`。

## 验收

1. 鼠标 hover 触发按钮 120ms 展开，移出 300ms 收起；hover 打开不迁移焦点。
2. 点击 toggle 保留；触屏/键盘回退现状。
3. 溢出工具激活时触发按钮呈 mini-dot。
4. 分组标题对比度 ≥4.5:1（用 `text-text-tertiary`）。
5. `pnpm exec tsc --noEmit` + `pnpm lint` 通过。

## 不做

- 不加搜索框自动聚焦的 hover 变体（hover 打开不 focus，保持现状语义）。
- 不改 `toolSwitcherData` 数据源与 `onSelect` 契约。
- 不动 z-index 体系。
