# ActivityBar 简化设计实施记录

> **版本**: v2.0  
> **状态**: 已实施  
> **关联**: `src/components/Layout/ActivityBar.tsx`, `src/components/Layout/ActivityBarIcon.tsx`, `src/components/TopMenuBar/index.tsx`, `src/stores/viewStore.ts`

---

## 1. 变更内容

### 1.1 ActivityBarIcon 尺寸缩小
- 按钮: `40×40px` → `24×24px`（`w-10 h-10` → `w-6 h-6`）
- 图标: `20px` → `14px`（`size={20}` → `size={14}`）
- 间距: `mb-1` → `mb-px`
- 激活指示条: `top-1 bottom-1` → `top-0.5 bottom-0.5`

### 1.2 ActivityBar 容器
- 容器宽度: `w-12` (48px) → `w-9` (36px)
- 移除折叠按钮（`toggleActivityBar` / `PanelRight` 图标）
- 移除 AI 面板切换按钮（`onToggleRightPanel` / `PanelRight` 图标）
- 移除 `activityBarCollapsed` 状态依赖
- 保留「更多工具」和「设置」按钮

### 1.3 自适应图标数量（ResizeObserver）
- 移除硬编码 `PINNED_LEFT_PANEL_TYPES` 固定 4 个图标
- 改用 `ResizeObserver` 监听容器高度变化
- 每个图标 25px（24px 按钮 + 1px margin），底部预留 50px（更多工具 + 设置）
- 1080p 屏幕下可容纳约 **25 个图标**，放不下的自动进「更多工具」弹出菜单
- 更多工具按钮在有溢出面板被激活时高亮

### 1.4 TopMenuBar
- 移除 `activityBarCollapsed` / `toggleActivityBar` 引用
- 移除 ActivityBar 显示/隐藏按钮
- 移除 `useViewStore` 导入（不再需要）
- `showTopToolSwitcher` 改为仅依赖 `isCompactMode`

---

## 2. 尺寸对比

| 维度 | 原版 (48px) | 第一版 (36px) | 最终版 (36px) |
|------|------------|---------------|---------------|
| 整栏宽度 | 48px | 36px | 36px |
| 图标按钮 | 40×40px | 28×28px | **24×24px** |
| 图标尺寸 | 20px | 16px | **14px** |
| 按钮间距 | mb-1 (4px) | mb-0.5 (2px) | **mb-px (1px)** |
| 单图标高度 | ~44px | ~30px | **~25px** |
| 可容纳 (700px 高) | ~6 个 | ~11 个 | **~25 个** |
| 折叠按钮 | 有 | 无 | 无 |
| AI 面板按钮 | 有 | 无 | 无 |
| 图标排序 | 硬编码 | 自适应 | 自适应 |

## 3. 计算公式

```
可用高度 = 容器高度 - 16px(padding) - 50px(底部固定)
可见图标数 = min(floor(可用高度 / 25), 总图标数)
```

示例：1080p 屏幕，ActivityBar 容器约 700px
- 可用 = 700 - 16 - 50 = 634px
- 可容纳 = 634 / 25 = 25 个图标