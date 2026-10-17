# PRD：工具切换器优化 —— hover 直达 + 高密度飞出面板

> 状态：草案（待评审） | 范围：前端 UI | 日期：2026-10-17
>
> 可交互原型：`plans/tool-switcher-hover-flyout-prototype.html`（新方案 / 现状可切换对比，hover 展开与双列网格可真实操作）

## 1. 背景与现状

> **v5 设计重做（2026-10-17 评审后）**：交互方向确认，视觉执行重做。对应预览 `plans/tool-switcher-hover-flyout-v5.html`（previewId `8ccc26ec` v5）。相对 v2 修正以下 7 点：
>
> 1. **视觉语言对齐**：弃用原型里的「通用蓝 + 中性灰」，改用 Shenzhen 主题 token（背景 elevated `12 15 34`、主色霓虹青 `0 217 255`、文字 tertiary `130 145 190`）。active 态、图标、focus 环、mini-dot 全走 primary。
> 2. **锚定触发按钮**：`getBoundingClientRect` 定位（left = 按钮左缘、top = 按钮下缘 + 6px），替换现状固定 `left-2 top-11` 钉左上角。浏览器实测 1440px 宽下 `deltaX=0` 精确对齐；窄窗用 clamp 兜底。
> 3. **pinned + 溢出分层**：常驻 4 项（文件/变更/浏览器/终端）icon 大按钮置顶，溢出工具 3 列紧凑网格；不再 12 项平铺 6 组的稀疏覆盖。落地实现按 §13-1 评审结论（配得上一级的 pinned + 低频工具收纳）。
> 4. **单行头部**：标题 + 当前侧栏 pill + X；「关闭侧栏」沉到底部一条（`fly-foot`），不再塞头部 11px 副行。
> 5. **无魔数高度**：flex column + 滚动区 `min-height:0`，唯一 max-height 源 `min(70dvh, calc(100dvh - 64px))`。
> 6. **3 列吃满宽度**：356px 面板 / 3 列 / tile 图标 15px + label，右侧不再空置（v2 双列 34px tile 每列 ~168px 只用 ~70px 是「宽而空」）。
> 7. **项目契约对齐**（explore 调研 `src/` 现网组件）：浮层 `bg-elevated + border + rounded-xl(12px) + shadow-medium(0 8px 24px/0.2) + panel-in(260ms translateY4px)`；tile/芯片 8px、小控件 6px 分级。对比度实测：tile 文字 10.2:1、分组标题 5.7:1 均 AA。
>
> 实现注意事项：现网 ToolSwitcher.tsx:232 组标题仍用 `text-muted`（≈3.0:1 不达标），落地提高为 `text-text-tertiary`；⚠ 沉浸主题浮层背景须显式不透明（FileSuggestion/MessageContextMenu 的先例，防 `--window-opacity` 透底）。

工具切换器现状（`src/components/Layout/ToolSwitcher.tsx` + `ActivityBar.tsx` + `toolSwitcherData.tsx`）：

- ActivityBar 宽 42px、纯图标无文字；容器放不下的工具全部收进「更多工具」（Grid2X2）按钮。
- 「更多工具」**必须点击**才弹出 ToolSwitcher 浮层（fixed，360px 宽，单列列表，7 个工作流分组 + 搜索框）；小屏/折叠态下 TopMenuBar 承接同款入口。
- 浮层列表信息密度低：每项一行（40px）、32px 图标杯、description 独占次行，一屏放不下要滚动。
- 桌面鼠标 hover 到 ActivityBar / 更多工具时无任何预展开反馈，切换永远 2 步起。

## 2. 问题清单

| # | 问题 | 影响 |
|---|---|---|
| P1 | 切换工具需「点击打开浮层 → 扫视/滚动 → 点击目标」，≥2 次交互 | 高频切换成本高 |
| P2 | 单列列表密度低，垂直空间浪费在图标杯与描述行 | 找工具慢 |
| P3 | 无 hover 展开预期，桌面端手感差 | 与现代编辑器（VSCode 溢出菜单等）体验脱节 |

## 3. 目标（非目标）

**目标**
1. 桌面 hover「更多工具」自动展开飞出面板，移开后延时收起；点击 retain 现有 toggle 语义（触屏/键盘无 hover 设备完全回退现状）。
2. 浮层信息密度约 ×2：单列 → 双列密排网格；description 不再独占行（降级为 tooltip）。
3. 点选即生效并关闭，`onSelect` / 数据源（`toolSwitcherData`、`viewStore`、插件 contributes 协议）零改动。

**非目标**
- 不改 ActivityBar 自适应图标数量逻辑（visibleCount ResizeObserver）。
- 不动 z-index 体系（保留 `--z-popover`，已知窄窗 overlay 反压问题另行处理）。
- 不新增设置开关（先验证 hover 手感，反馈差再说）。

## 4. 交互规格

| 参数 | 值 | 理由 |
|---|---|---|
| hover 展开 intent 延迟 | 120ms | 高于快速扫过的误触阈值、低于"故意停靠"的感知阈值 |
| 移出收起 grace 延迟 | 300ms | 允许指针斜向移动进浮层途中不闪断（220ms 对触控板斜向路径偏短，评审 P3 上调） |
| 指针进入浮层内 | 不收起，且重置 grace 计时 | 浏览/搜索不被打断 |
| **焦点迁移** | **hover 打开不迁移焦点；仅 click 打开 `focus({ preventScroll: true })`；关闭时焦点归还触发按钮** | hover 语义下用户注意力仍在终端/编辑器，自动 focus 会吞正被输入的字符（评审 P0，数据丢失级） |
| Escape / 点击浮层外 | 立即关闭 | 维持现状 |
| 点击触发按钮（无 hover 路径） | toggle | 触屏与键盘可达性回退 |
| 重复 hover 抖动防护 | 展开/收起均用过渡动画（120~160ms），计时器可打断重置 | 防闪烁 |

## 5. 布局规格

- 浮层宽：activityBar 放置 `min(380px, calc(100vw - 72px))`；top 放置 `min(380px, calc(100vw - 16px))`。
- 列表项：双列 `grid-template-columns: repeat(2, 1fr)`；高 34px；icon 16px（去掉 32px 底杯）；label 13px 单行 truncate。
- description：降级为原生 `title` tooltip；「当前侧栏 + 关闭侧栏」操作保留在头部。
- 分组标题：11px，**颜色用 `text-tertiary`（≈5.3:1 达 AA），不得用 `text-muted`（≈3.0:1，评审检出不达标）**；段间距收紧（`space-y-1` → 分组间 10px）。
- 字体档位收敛为 3 档（11 / 14 / 17.5px，检测器 `flat-type-hierarchy` 修复），去掉 11.5/12/12.5/13/13.5 散档。
- 面板高度容器与内部滚动区**单一事实源**（现状 `min(70dvh)` 与 `calc(...) - 104px` 双写魔数，头部变更即错位）。
- active 项：primary 浅底 + 图标着色 + 标题色，双列内可见性保持；tile 补 `:focus-visible` 焦点环。
- 搜索框：保留在头部下方一行；搜索态仍双列。
- 空态文案与 i18n key 全部沿用。
- 语义角色：容器 `role="listbox"` + 项 `role="option"` + `aria-selected`（替换现状非模态 popover 上误用的 `role="dialog"`）；触发按钮挂 `aria-expanded`。
- 溢出位置反馈：溢出工具激活时「更多工具」按钮加 mini-dot 常驻小红点，修复"切到溢出工具后 bar 上位置感消失"。

## 6. 验收标准

1. 鼠标停靠「更多工具」≤120ms 浮层展开（保留 animate-panel-in）；斜向移入浮层不闪收（grace 300ms）。
2. **hover 打开全程不发生焦点迁移**；click 打开后搜索框 focus 且 `preventScroll`；关闭（Esc/点外/选中）后焦点归还触发按钮。
3. 键盘契约：触发按钮 `aria-expanded` 正确；面板内 ↑↓ 焦点循环、Enter 选中、Tile 有可见 `:focus-visible` 焦点环；容器 `listbox/option` 语义。
4. 双列网格无横向溢出；长 label truncate + title tooltip 生效。
5. 点击工具项：立即 `onSelect` 并关闭，行为与现状一致；active 高亮正确渲染新旧两种布局；溢出工具激活时「更多工具」呈 mini-dot。
6. 用户折叠态 ActivityBar（w-2）不触发 hover 展开。
7. 无 hover 设备（触屏）行为与现状完全一致。
8. 正文级小字（分组标题等）对比度 ≥4.5:1（AA）；动效遵循 `prefers-reduced-motion`。
9. `pnpm exec tsc --noEmit` + `pnpm lint` 通过；既有相关 vitest 通过。

## 7. 改动面

| 文件 | 改动 |
|---|---|
| `src/components/Layout/ToolSwitcher.tsx` | 新增 hover 触发模式（controlled `trigger: 'click' \| 'hover'`），双列渲染，tooltip 化 description |
| `src/components/Layout/ActivityBar.tsx` | 更多工具按钮接入 hover 展开回调 |
| `src/components/TopMenuBar/index.tsx` | top 放置同步 hover 触发 |

## 8. 风险

- 「路过即展开」打扰：intent 延迟 + 大偏移命中（可增 pointer 偏移检测，v1 暂用纯 hover + delay）。
- hover 反复进出动画闪烁：所有计时器在 enter/leave 时可打断并重置。
- 触控板用户误触频率高于鼠标：数据期观察（暂无埋点，可后续加 panel 打开来源打点）。
- ~~grace 220ms~~ → 300ms：上一版 grace 对触控板斜向路径偏短（评审 P3），已上调；参数暂无实证，dev 构建内打点误触率后定稿。
- **评审遗留的方案级质疑（见 §13）**：Cmd-K palette 对照与 pinned 锁定 IA 是否应取代本方案部分参数。

## 9. 移动端 / 触屏适配（手机浏览器）

手机浏览器（compact 模式：`useWindowSize` 命中宽度阈值）下，ActivityBar 被 `forceCollapsed` 不渲染，工具切换入口由 TopMenuBar 的 Grid2X2 按钮承接（现状 tap toggle，语义天然正确）。移动端没有 hover，桌面版 hover 直达语义需整体禁用，密度改进保留并强化触控规格。评审 P2 追加两条硬规格：

- **打开 sheet 禁止自动 focus 搜索框**——软键盘弹出占屏 ~45%，恰好盖住 78% sheet 的网格区；搜索入口留给用户主动触发。
- **sheet 内所有可点元素 ≥44×44**（现状 `sheet-x` 34px、`close-side` 26px、搜索框 36px 不达标）；键盘输入展开时用 `visualViewport` 监听压缩 sheet 高度并把搜索行 sticky 在可视区上缘。

| 参数 | 手机端值 | 理由 / 与桌面差异 |
|---|---|---|
| 触发动作 | 仅 tap toggle | `hover` 在粗指针设备无意义；触发判定用 `matchMedia('(pointer: coarse)')` 或 hover 触发回调不注册 |= 检测 |
| 飞出面板形态 | 底部抽屉（bottom sheet） | 顶栏下拉遮挡操作区、拇指不可达（360px 面板顶部弹出离拇指最远）；自下而上滑入，圆角顶缘 + 抓手条 |
| 面板宽度 | `calc(100vw - 16px)` 距两侧 8px | 竖屏 ~390px 视口下单列/双列均可容纳；现状固定 360px 同样受限但无抓手条 |
| 触控目标 | tile 高 34px → **44px**（pointer: coarse） | WCAG 2.5.5 / Material 最小触控目标；桌面维持 34px 不变 |
| 背景遮罩 | 加半透明 backdrop，点击关闭 | 桌面无遮罩；移动端防误触下层内容 + 明确关闭语义 |
| 滚动 | `overscroll-behavior: contain` + `touch-action: pan-y` | 防面板滚动连带页面 rubber-band |
| 安全区 | `padding-bottom: env(safe-area-inset-bottom)` | iOS 全面屏 home indicator |
| 双列网格 / 分组 / 搜索 / 关闭侧栏 | 全部沿用 | 密度优化在移动端同样成立 |

**行为矩阵**：

| 设备 | hover 直达 | tap toggle | 面板形态 | 触控目标 |
|---|---|---|---|---|
| 桌面鼠标 | ✅（120ms intent） | ✅ | 侧向 flyout | 34px tile |
| 触屏笔记本 | ❌（coarse 检测禁用） | ✅ | 同桌面 | 34px + 系统触控命中 |
| 手机浏览器 | ❌ | ✅ | 底部 sheet + 遮罩 | 44px tile |

**原型**：
- 桌面版：`plans/tool-switcher-hover-flyout-prototype.html`（预览 v1）
- 手机版：`plans/tool-switcher-mobile-prototype.html`（预览 v2，电话框内含完整触控交互）

## 10. 移动端改动面（增量）

| 文件 | 改动 |
|---|---|
| `src/components/Layout/ToolSwitcher.tsx` | 新增 `variant: 'flyout' \| 'sheet'`：coarse 指针 / isCompact 时渲染 bottom sheet（backdrop、抓手条、44px tile、safe-area），其余走现有 fixed flyout |
| `src/components/TopMenuBar/index.tsx` | tap toggle 保留；面板形态由 ToolSwitcher 内部按指针类型自选，无需改动触发代码 |

> 实现注意（遵循 app 内既有约束）：`isCompactMode` 已经由 `useWindowManager` 下发，sheet 判定直接复用，不新增第三套小屏判定；z-index 沿用 `--z-popover`，backdrop 挂同一容器低于面板本身。

## 13. 评审存档：方案级质疑（2026-10-17 critique，20/40 基线）

.impeccable/critique 快照 `src-components-layout-toolswitcher-tsx`。未纳入本 PRD 实施范围、需产品决策的三条：

1. **IA 根因**：本面板存在的理由即 ActivityBar 溢出收纳失败——应先审计"哪些工具配得上一级位置"（pinned 锁定 4 项 + 低频工具藏进各自域），本轮以 mini-dot 打补丁，收纳策略列为 v2 课题。
2. **Cmd-K palette 对照方案**：面板内搜索框即 palette 替身；palette（键盘第一、fuzzy、零 hover 参数）可能使 hover 全家参数退役。建议列入对照原型评审后再投票。
3. **"一屏 20 个可见"作为指标存疑**：7 组切 12-20 项一次全暴露是认知负荷（5/8 失败项）；备选形态 pinned + MRU（最近使用）+ "其他"折叠，首屏 6 项。
