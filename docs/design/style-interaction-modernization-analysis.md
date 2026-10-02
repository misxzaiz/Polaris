# Polaris 样式 / 布局 / 交互现代化 — 现状分析报告

> 状态：仅分析，未实施（2026-10-02）
> 分析范围：`src/`（265 个组件 tsx、742 个 ts/tsx）、`src/index.css`（2091 行）、`src/App.css`（999 行）、`tailwind.config.js`、主题体系（`themeEngine` / `builtInThemes` / `ThemeEditor`）、近 40 条相关 git 历史、既有 4 份设计规划文档。

---

## 0. 一句话结论

**架构比观感先进得多**：token 化、主题引擎、动效 token 这些"底层"已经现代化；「枯燥、落后」的感受主要来自**设计决策层**——默认配色保守、形态语言不统一、反馈与活力层缺失。这是一次"换皮 + 补神经"的改造，不需要推倒重来。

---

## 1. 现状资产盘点（这些是好东西，改造时必须保住）

| 资产 | 位置 | 评价 |
|---|---|---|
| RGB 三元组 CSS 变量 → Tailwind 语义 token | `index.css` + `tailwind.config.js` | ✅ 先进。primary/background/border/text/status/priority/accent 全语义化，支持 `<alpha-value>` 与 `--window-opacity` 复合 |
| 7 层主题模型（L0 颜色 ~ L6 自定义 CSS，约 88 维） | `src/types/theme.ts` | ✅ 维度覆盖超过多数桌面产品 |
| 主题引擎（合并/扁平化/注入/亮度自适应遮罩/用户 CSS 逃生舱） | `src/services/themeEngine.ts` | ✅ 完整，3 个内置主题（dark / light / spiderman 沉浸） |
| 动效 token 化（近期 commit `28cbfd8b`） | `tailwind.config.js` keyframes/animation | ✅ 时长梯度 140/260/380ms + 统一缓动 `cubic-bezier(.32,.72,0,1)`，panel/dialog/drawer/mask/capsule/list-item 全覆盖 |
| Chat 排版变量注入链路 | `getChatDisplayStyleVars()` → 4 个表面同步 | ✅ 字号/行高/密度设置实时生效（主聊天/多会话/输入框/设置预览） |
| Common/Button variant 体系 | `src/components/Common/Button.tsx` | ✅ 有雏形（4 variant × 3 size），但全项目仅此一处，未推广 |
| 高密度工具面板骨架 | ActivityBar / LeftPanel / CenterStage / RightPanel | ✅ IDE 型分区稳定，viewStore 状态集中 |
| 多会话网格（差异化能力） | `MultiSessionGrid` / `SessionCell` | ✅ 产品强项，只是视觉未被加持 |

**关键判断：改造应"在 token 体系上做加法"，而不是引入新样式架构。**

---

## 2. 问题清单（带证据）

### 2.1 色彩：三层"灰底灰框"，无品牌记忆点
- Dark 主题背景阶：`纯黑(0,0,0)` → `#1a1a1f` → `#25252b` → `#2d2d35`，**中性灰阶无色温倾向**，层级只能靠"更灰的灰 + 细线"，观感接近 2018 年 VSCode 默认暗色。
- 边框是白色 `0.15` alpha，全局一律——**没有"极弱边框 + 底色差分层"的现代做法**（Linear 式）。
- 主色是 stock Tailwind 蓝 `#3b82f6`（`--c-primary: 59 130 246`），最大公约数配色，与上千个 AI 工具同质。
- 状态色（success/warning/danger）饱和度平均，`*-faint` token 已定义但使用率低——状态色没有成为界面语言。

### 2.2 硬编码样式债（"落后感"的直接来源之一）
- 组件内硬编码 hex：**158 处**（tsx 内 `#3c3c3c`×25、GitHub-dark 语法高亮色 `#79c0ff`/`#ffa657`/`#e6edf3` 等成组出现）。
- `index.css` 内 `.prose` 与 59 条 `.hljs` 规则硬编码深色 hex（`#F8F8F8`/`#25252B`/`#B4B4B8`…）——**浅色主题下已知发暗/失效**（`chat-style-revamp-plan.md` 早已记录此债）。
- 滚动条 `rgba(255,255,255,0.15)` 硬编码——浅色主题下不可见。
- inline `style={{}}` 203 处（部分合理：动态值；部分是逃逸 token 体系）。

### 2.3 形状与节奏：语言不统一
圆角使用分布（全组件库）：

| rounded | 683 | rounded-lg | 586 | rounded-md | 282 | rounded-full | 246 | rounded-xl | 59 | rounded-2xl | 6 |

没有定义"什么层级用什么圆角"，同一屏内 4/6/8/12px 混用。间距同理（`p-2`×169、`px-3`×157、`p-1`×142、`p-1.5`×99…），无 4/8 网格节奏约定。

### 2.4 排版：系统默认字体，无排版设计
- 字体栈是纯 system-ui fallback，**无品牌字体**（项目无任何 `@font-face`/Inter/Geist），中文 fallback 顺序未优化。
- 无字号阶梯规范：`text-xs`(12) / `text-sm`(14) / `text-base`(16) 随手混用；统计数字（token 统计、成本）未用 `tabular-nums`，数值跳动。
- 面板标题、工具栏、正文视觉权重接近——"处处同等重要"，扫描成本高。

### 2.5 动效：有肌肉、无神经
- 动效 token 很全，但组件实际使用 95% 只有 `transition-colors` + `animate-spin` / `animate-pulse`（加载语义全是转圈/呼吸点）。
- **无消息入场动画、无流式光标、无骨架屏**（全项目 grep `skeleton|shimmer` = 0）、无数字滚动、无进度语义色。AI "正在工作"的生命力感知弱——这正是"枯燥"的核心体感。
- `prefers-reduced-motion` 仅 2 处 CSS 接线，token 化动画未全部受控。

### 2.6 交互反馈：悬停专属、转瞬即逝
- 操作按钮普遍 `opacity-0 group-hover:opacity-100`（如 `UserBubble` 操作栏）——纯鼠标逻辑，键盘用户不可达。
- `focus-visible` 全项目仅 3 个文件使用；无全局键盘焦点环规范。
- 复制成功 = 图标变绿 1.5s，无统一反馈系统（Toast 有容器但微反馈不成体系）。
- 空状态：18 个文件有处理，但基本是图标+一行灰字，无行动引导。

### 2.7 结构层（已被既有文档识别，未实施）
- 顶部菜单栏 / ActivityBar / QuickSwitch 入口分散，"当前上下文"感知弱（v1 文档）。
- Agent 优先的结构（Agent Control Bar / Context Sidebar / Session Dock / Run Dock）已在 v2 锁定方向（v2-A），未落地。
- 小屏模式 = 隐藏左栏，非重新组织。
- **历史教训**：会话底部 tab 化 + 灵动岛 v4 曾实施后回退（`f242294c` → `428d0594` revert）——活力化方向试过，但形态不稳定；新方案需更克制。

---

## 3. 现代参照系（2025-26 桌面工作台基准）

| 参照 | 可迁移模式 | 对 Polaris 的启示 |
|---|---|---|
| Linear | 极弱边框(α≈0.06) + 底色差 2-3% 分层 + 键盘优先 + 命令面板 | 边框减淡、层级改用底色差表达；全局 focus-visible |
| Cursor / Zed | AI 状态渗入界面（运行中=标题/边框状态色呼吸） | SessionCell、ChatStatusBar 用状态色说话 |
| Raycast | 命令面板动效、渐进入场、玻璃质感克制 | QuickSwitch 升级为门面 |
| Claude / ChatGPT 桌面 | 对话排版：正文 15-16px、宽松行高、代码块内嵌工具栏 | chat prose 重排（hex 清债时一并做） |
| Arc / Warp | 单一品牌 accent + 状态色，点缀精准而非铺陈 | primary 换色 + accent 体系激活 |
| VSCode 2025 | 面板一致性（header/toolbar/content 三段式尺寸规范） | PanelHeader 尺寸统一（v1 方案 A 已提出） |

**PRODUCT.md 的品牌约束要遵守**：refined / calm / quietly powerful；**反对**过度 glassmorphism、响亮渐变、营销风仪表盘。方向应贴近 "Graphite Minimal"（v3 文档推荐项）。

---

## 4. 机会地图（按投入产出比排序）

### P0 视觉底座（纯 token/CSS，1-2 天量级，全局见效）
1. **默认主题换肤**：按 v3 已论证的 Graphite Minimal 方向重定义 dark —— 背景换 `#14161a` 石墨蓝调系（弃纯黑）、边框 alpha 0.15→0.06~0.08、文本 4 阶重排、primary 换柔和蓝（`#7c9cff` 一类）。全部改动落在 `builtInThemes.ts` + `index.css :root`，组件零改动。
2. **硬编码清债**：158 处 tsx hex + prose/hljs + 滚动条 token 化。收益是双主题真正可用，而不仅是观感。
3. **形状/间距收敛**：定义圆角语义（4=控件内元素、6=控件、8=卡片、12=浮层、14=弹窗）+ 4/8 间距节奏，先规范新增代码，存量渐进。
4. **字体升级**：UI 引入 Inter/Geist（本地打包）+ 中文字体栈优化 + `tabular-nums` + 字号阶梯（12/13/14/16/20）文档化。

### P1 活力层（2-4 天，直接回应"枯燥"）
1. **消息动效体系**：入场 stagger、流式光标、思考块 shimmer、骨架屏——`chat-style-revamp-plan.md` 的 pulse 方案与 `data-chat-style`/`data-chat-motion` 架构可直接实施。
2. **状态色语言**：running=主色呼吸描边、waiting=amber、question=rose blink、idle=灰；落到 SessionCell 头部、ChatStatusBar、通知。
3. **微交互补全**：按钮按压 `scale(0.98)`、复制/发送/折叠反馈统一、数字滚动（token 统计）。
4. **reduced-motion 全局接线**（一条 CSS 即可让全部 token 动画受控）。

### P2 交互层（1-2 周）
1. 键盘可达：全局 focus-visible 环、`kbd` 样式、快捷键提示。
2. 空状态设计系统：插画位 + 主行动按钮 + 快捷入口（18 处统一）。
3. 拖放/上传视觉语言（聊天附件拖放、文件导入）。
4. 设置页信息架构：分组卡片 + 搜索 + 即时预览（ModelProviderTab 228 个 className 是最重灾区）。

### P3 结构层（2-4 周，v2-A 落地）
- Agent Control Bar / Context Sidebar / Agent Board / Session Dock / Run Dock —— 按既有 v2 文档实施，视觉用 P0 的 Graphite 语言。

---

## 5. 与既有 4 份设计文档的关系

| 文档 | 状态 | 本报告的处理 |
|---|---|---|
| `polaris-layout-redesign-plan.md` (v1) | 结构建议，被 v2 取代 | 其"方案 A 稳健增强"的 PanelHeader/尺寸规范部分仍有效，吸收进 P0-3 |
| `polaris-agent-first-layout-v2.md` (v2) | **结构方向已锁定（v2-A），未实施** | 即本报告 P3，无冲突 |
| `polaris-visual-modernization-v3.md` (v3) | 视觉选型**未决**（4 风格对比完成，推荐 Graphite） | 本报告 P0-1 直接采纳其推荐，仍建议最终由用户确认 |
| `chat-style-revamp-plan.md` | 方案完整，**未实施** | 即本报告 P1-1，无冲突 |

⚠️ **注意**：v1/v2/v3 引用的原型 HTML（`docs/design/prototypes/*.html`）**已不存在**（目录为空、git 无记录）。若要走"先选型后实施"流程，原型需重建。

---

## 6. 风险与约束

1. **多主题兼容**：改动默认主题变量会同时影响 spiderman 沉浸主题的叠加逻辑与 `--window-opacity` 复合——换肤前需过一遍 `themeMerger` 深合并路径。
2. **性能红线**：PRODUCT.md 明确反对重 glassmorphism；`backdrop-filter` 在 Tauri/低端机代价高（v3 已论证 Glass 不作默认）。blur 仅限个别浮层。
3. **存量用户习惯**：采用 chat 方案已确立的 "default=现状、新用户=推荐新风格" 策略可平滑过渡；主题层面同理（新增内置主题而非篡改 Dark，Dark 更新需单独评估）。
4. **回退教训**：灵动岛 v4 被回退说明"活力化"要克制、可关闭、状态导向，避免抢主内容。

---

## 7. 建议推进顺序（供决策，未实施）

1. **阶段 0（选型）**：重建一份轻量视觉原型（Graphite + Warm 双风格 × 聊天/SessionCell/Git/设置 4 表面），确认视觉语言 —— 半天内。
2. **阶段 1（P0）**：token 换肤 + 清债 + 形状收敛 + 字体 —— 当天全局见效，风险最低。
3. **阶段 2（P1）**：动效/状态色/微交互 —— "枯燥"问题的直接答案。
4. **阶段 3（P2/P3）**：交互层与 v2-A 结构演进，按既有文档分批。

每阶段独立可交付、可回滚（token 层改动天然低风险）。
