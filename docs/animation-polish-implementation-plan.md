# Polaris 动画体验完善实施方案

> 状态：已实施（P1 完成，P2/P3 全部落地）｜ 日期：2026-09-26 ｜ 配套可交互原型：Polaris 动画实验室 v2（预览 ID `37ecb314`）
> 关联：`docs/dynamic-island-prd.md`（三态状态机范式来源）

---

## 1. 背景与问题

当前应用面板/浮层/弹窗的开合**几乎全部是硬切换**，具体表现为：

1. **入场动画静默失效**：19 个文件、68 处 `animate-in` / `slide-in-from-*` / `fade-in` /
   `zoom-in-*` 类名未生成（`tailwind.config.js` 的 `plugins: []`，未装 `tw-animate-css`）。
   覆盖：左侧抽屉、会话历史/消息中心右侧浮层、设置页层叠、NarrowTabOverlay、
   FileSearchModal、SymbolPalette 等。
2. **核心布局开合无过渡**：右面板折叠（`hidden` 直切）、左面板关闭（卸载）、
   ActivityBar 折叠、终端全屏，全部无过渡动画。
3. **弹窗零动画**：ConfirmDialog / InputDialog / UnsavedDialog / AiExtractDialog 打开即"硬现"。
4. **无统一规范**：动画时长、缓动、层级各自为政，退出动画缺失。

## 2. 目标

- 面板/抽屉/弹窗**进出有过渡**，手感统一、不拖沓。
- 全项目动画**单一 token 源**（时长梯度 + 缓动），便于调参。
- **退出动画**与进入对称（三态状态机），无瞬闪。
- **性能护栏**：只动 transform/opacity；右面板等保活组件过渡结束再 `display:none`；
  `prefers-reduced-motion` 自动降级。
- **不引入重依赖**：不装 framer-motion，纯 CSS + 少量 React 状态机（复用 DynamicIsland 范式）。

**非目标**：
- 不做开场/页面级大动画（v1 只覆盖面板与浮层）。
- 不改布局结构（保活 hidden 策略保留）。
- 不动 DynamicIsland / 语音伙伴等已有成熟动画。

## 3. 现状盘点（证据）

| 区域 | 文件 | 现状 | 证据 |
|---|---|---|---|
| 左侧抽屉 | `src/components/Layout/LeftPanel.tsx` | 🟡 类名失效 | `animate-in slide-in-from-left duration-200`（L115）无插件支撑 |
| 右侧浮层 | `src/App.tsx` | 🟡 类名失效 | `slide-in-from-right duration-200`（L386/398）未生成 |
| 弹窗 | `Common/ConfirmDialog/InputDialog/UnsavedDialog` | 🔴 零动画 | 无任何入场/退出类 |
| 右面板折叠 | `src/components/Layout/RightPanel.tsx` | 🔴 硬切换 | `hidden` 直切（L48），保活注释 |
| 左面板关闭 | `src/App.tsx` L287-291 | 🔴 无退出 | 条件渲染卸载 |
| 终端全屏 | `src/App.tsx` / `TerminalPanel` | 🔴 硬切换 | `flex-1` / `!terminalFullscreen` 直切 |
| ActivityBar 折叠 | `src/components/Layout/ActivityBar.tsx` | 🔴 硬切换 | `forceCollapsed` 后宽仍 42px |
| 设置页 | `SettingsPage.tsx` L210 | 🟡 类名失效 | `animate-in fade-in` 未生效 |
| 搜索/窄窗 | `FileSearchModal.tsx` L608 / `NarrowTabOverlay.tsx` L59 | 🟡 类名失效 | 同上 |
| 进度胶囊 | `CompactHandoffProgress` / DynamicIsland | 🟢 有范式 | 三态状态机全项目最佳 |

## 4. 统一动画规范（token 化）

落点：`tailwind.config.js`（或 `index.css` `@layer`），输出为可直接用在类名/内联上的 token。

```css
/* 时长梯度 */
--ms-1: 140ms;   /* 微交互：hover/active/弹窗遮罩 */
--ms-2: 260ms;   /* 浮层：抽屉/侧滑/胶囊 */
--ms-3: 380ms;   /* 形变：宽度折叠/终端全屏/展开 */

/* 缓动 */
--ease-panel:   cubic-bezier(.32, .72, 0, 1);      /* 进入：面板基线(已有) */
--ease-spring:  cubic-bezier(.34, 1.56, .64, 1);   /* 吸睛：弹窗缩放(已有) */
--ease-exit:    cubic-bezier(.4, 0, 1, 1);         /* 退出：快收 */
```

配套 React 状态机（抽到 `src/hooks/useTransitionState.ts`，复用 DynamicIsland 的
`enter → open ⇄ exiting → 卸载` 语义，用 `transitionend` 收尾）：

```ts
type Phase = 'mounted' | 'entering' | 'open' | 'exiting' | 'unmounted'
// 挂载 → entering(入场) → open(停留) → exiting(出场) → 卸载 触发 onExited
```

## 5. 分场景实施方案（P1 试点 → P2 铺开 → P3 收尾）

### P1 高感知试点（低风险，先验证手感）

**S1 左侧抽屉进出动画** — `LeftPanel.tsx`
- 用 `useTransitionState` 包住抽屉：挂载即 entering，`transitionend` → open；
  关闭时 exiting（滑出+遮罩淡出），结束才卸载。
- 时长 `--ms-2`，缓动 `--ease-panel`，遮罩与抽屉用 `transition-delay` 交错。
- 替换现有失效的 `animate-in slide-in-from-left duration-200`。

**S2 弹窗缩放 + 淡入** — `Common/ConfirmDialog|InputDialog|UnsavedDialog|AiExtractDialog`
- 遮罩 `--ms-1` 淡入淡出；弹窗本体 `--ms-2 --ease-spring` 缩放（0.94→1）+ 轻微上移。
- 退出对称（缩放 0.95 + 淡出，`--ease-exit`）。
- 用 `OverlayGuard` 已有挂载点，不引入新依赖。

**S3 设置页层叠覆盖** — `SettingsPage.tsx` / `App.tsx`
- 覆盖层整体 `--ms-2` 淡入淡出（替换失效 `animate-in fade-in duration-150`）。

### P2 布局开合过渡（需保活/布局配合）

**S4 右面板折叠宽度过渡** — `RightPanel.tsx`（重点：保活）
- 折叠：宽度 `--ms-3` 收缩 + 内容 `opacity` 渐隐，`transitionend` 后才加 `display:none`，
  确保 Virtuoso 消息列表保活不闪白。
- 展开：反向，先恢复 `display` 再补宽。
- 风险点：多窗口 `MultiSessionGrid`/Virtuoso 在过渡期必须保持挂载（现状已满足）。

**S5 左面板关闭退出** — `App.tsx` L287
- `hasLeftPanel` 关闭路径改为走 exiting 卸载（与 S1 共用状态机），避免关闭硬消失。

**S6 终端全屏过渡** — `App.tsx` / `TerminalPanel`
- `terminalFullscreen` 切换时给终端容器 `--ms-3 --ease-panel` inset/尺寸过渡。
- 交互：全屏过渡 380ms 内可接受（全屏是形态变化，允许稍慢）。

**S7 ActivityBar 折叠过渡** — `ActivityBar.tsx` + `App.tsx`
- 折叠态宽度 42px ⇄ 8px，图标同步 `scale/opacity` 渐隐（`--ms-2`）。
- `forceCollapsed` 分支补宽度过渡；真正折叠态需要额外 state（见风险 R4）。

### P3 收尾（一致性 + 无障碍）

**S8 右侧浮层（会话历史/通知中心）** — `App.tsx` L383-406
- 统一用 S1 的侧滑状态机，替换失效 `animate-in slide-in-from-right duration-200`。

**S9 搜索/窄窗/符号面板** — `FileSearchModal` / `NarrowTabOverlay` / `SymbolPalette`
- 逐个替换失效类名 → 状态机 + token。

**S10 全局护栏**
- `index.css` 加 `@media (prefers-reduced-motion: reduce)` 全局降级；
- 面板拖拽宽度过渡（`transition-[width]`）评估是否改 rAF 节流（性能，P3 评估项）。

## 6. 里程碑与验收

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P1 | S1-S3 | 左抽屉/弹窗/设置页 进出有动画，无瞬闪，FPS≥55 | ✅ 已实施 |
| P2 | S4-S7 | 右面板折叠不闪白、消息位置保留；终端/ActivityBar 过渡平滑 | ✅ 已实施 |
| P3 | S8-S10 | 全部浮层统一；reduced-motion 生效；拖拽流畅 | ✅ 已实施 |

> 实施记录（2026-09-26）：
> - 新增 `src/hooks/useTransitionState.ts`（enter→open⇄exiting→卸载 三态状态机，复用 DynamicIsland 范式）
> - 新增 `src/components/Common/RightSlideOver.tsx`（右侧浮层滑入滑出，会话历史/消息中心共用）
> - `tailwind.config.js` 新增统一动画 token（panel/dialog/drawer/mask/capsule/list-item，时长梯度 140/260/380 + 缓动三系）
> - `src/index.css` 全局 `prefers-reduced-motion` 降级
> - 修复：`App.tsx` 左面板退场 ref 渲染期赋值竞态；SettingsPage 双重动画；ActivityBar 折叠态保留设置入口
> - 替换 19 文件全部失效 `animate-in/slide-in-from-*/fade-in/zoom-in-*` 类为统一 token
> - tsc 基线 37 errors（遗留）未增加；vite build 通过；产物 CSS 含全部动画 token + reduced-motion

每个阶段在 `Polaris 动画实验室 v2` 复测对应场景后合入。

## 7. 风险与对策

- **R1 退出瞬间闪白**：一律用 `useTransitionState` 保证 exiting 期间保持挂载，`transitionend` 后卸载。
- **R2 右面板保活**：宽度过渡内不触碰 `display`，结束再 hidden；展开先恢复布局再补动画。
- **R3 reduced-motion**：纯 CSS 降级 + 状态机检测 `matchMedia`，动画时长置 0.001ms 走瞬时切换。
- **R4 ActivityBar 折叠态缺失**：现状仅 `forceCollapsed`，真正折叠需在 viewStore 加
  `activityBarCollapsed` 驱动宽度类（P2 时一并确认，避免改 42px 常量引发布局抖动）。
- **R5 性能**：面板拖拽用布局属性 + 每帧 setState（无 rAF），P3 评估改
  `requestAnimationFrame` 节流或 transform 方案。

## 8. 参考

- 三态状态机范式：`docs/dynamic-island-prd.md` + `DynamicIsland.css`
- 可交互验证：动画实验室 v2（预览 `37ecb314`）
- 盘点证据：本轮分析（见会话）