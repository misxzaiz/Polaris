# Polaris AI 对话样式改版方案 —— 多风格选择 + 活力化

> 状态：规划稿（待确认）
> 日期：2026-07-14
> 配套原型：`docs/design/prototypes/polaris-chat-style-revamp.html`（4 风格实时切换 + 动效演示）
> 前置文档：`docs/design/prototypes/polaris-chat-vitalization-prd.html`（2026-06 动效层 PRD，本方案为其超集）

---

## 1. 背景与现状诊断

### 1.1 现有实现盘点

聊天视觉当前由三层混合构成：

| 层 | 位置 | 内容 |
|---|---|---|
| Tailwind 工具类 | `UserBubble.tsx` / `AssistantBubble.tsx` 等 TSX | 主体视觉（渐变、阴影、圆角修饰）**硬编码在组件里** |
| 全局语义 class | `src/index.css` L389-489 | `.chat-display-root` 作用域 + `--chat-*` 排版变量（字号/行高/密度） |
| inline 变量注入 | `getChatDisplayStyleVars()` (`types/config.ts` L116) | 4 个挂载点：EnhancedChatMessages / ChatInput / SessionCell / GeneralTab 预览 |

### 1.2 问题清单

1. **只有一种形态**：用户渐变蓝气泡 + AI 通栏，无法适配不同使用偏好（社交感 vs 文档感 vs 终端感）。
2. **视觉写死在组件里**：`UserBubble.tsx` L100-102 的 `bg-gradient-to-br from-primary to-primary-600 text-white shadow-glow` 无法被主题/风格覆盖，浅色主题下也无法调整。
3. **动效贫瘠且不成体系**：流式指示只有三个 `animate-bounce` 圆点；消息入场无动画；工具卡运行态只有 `animate-pulse` 虚线边框。"AI 正在工作"的生命力感知弱。
4. **遗留样式债**：`.prose` Markdown 段（index.css L196-387）与 hljs 代码高亮（L647-807）硬编码深色 hex（`#F8F8F8`、`#25252B` 等），浅色主题下已知发暗；工具卡使用 `border-l-2` 彩色左条纹（设计上应淘汰的模式）。
5. **旧动效 PRD 未落地**：2026-06 的活力化 PRD 定义了入场动画/流式光标/骨架屏，但缺少承载它们的"风格体系"，孤立实施容易再次形成硬编码。

### 1.3 现有可复用资产（改版基座）

- `data-theme` 属性驱动的双主题机制 + 全变量化 Tailwind（`rgb(var(--c-xxx))`），扩展成本低。
- `.chat-display-root` 作用域 + `--chat-*` 变量注入链路已打通 4 个表面（含多会话网格与设置预览）。
- `ChatDisplaySettings` 配置链路完整：类型 → normalize → styleVars → 设置页实时预览 → `updateConfigPatch` 持久化。
- Tailwind 已有 `flow` / `shake-once` / `breathe` 等 keyframes 可复用。

**结论**：不需要重写渲染链，改版 = 在现有变量体系上新增"风格维度 + 动效系统"，同时清偿硬编码债。

---

## 2. 目标与非目标

### 目标

1. **多风格选择**：提供 4 种对话风格预设，设置页一键切换、实时预览、全表面（主聊天/多会话网格/移动端）一致生效。
2. **活力化**：建立成体系的动效系统（消息入场、流式反馈、工具卡状态、思考块），让对话"看起来在流动"，同时保持 product 级克制（150-250ms、状态导向、无弹跳）。
3. **架构可持续**：一套 DOM、多套 CSS 皮肤；新增风格 = 新增一段变量覆盖，不分叉组件。
4. **清债**：Markdown/hljs 硬编码 hex token 化；用户气泡样式从 TSX 迁入语义 class；工具卡左条纹改为图标色点 + 状态边框。

### 非目标

- 不改消息数据结构、渲染链（Virtuoso/blocks 架构）与交互逻辑（右键菜单/复制/编辑）。
- 不引入新颜色主题（dark/light 之外的配色属后续迭代，本方案预留接口）。
- 不做每条消息级别的皮肤（风格是会话全局的）。

---

## 3. 总体设计：三个正交维度

```
颜色主题 (data-theme)        对话风格 (data-chat-style)      动效档位 (data-chat-motion)
  dark / light        ×     classic / pulse / duo / zen  ×    full / subtle / off
  —— 管颜色                   —— 管形态与密度                  —— 管动画强度
```

- **正交性**：任意组合合法（4 风格 × 2 主题 × 3 档位 = 24 种组合全部可用）。风格只引用语义色 token（`--c-*`），不定义颜色值，因此天然适配深浅主题及未来新主题。
- **挂载方式**：与现有 `data-theme` 同构 —— 在 `.chat-display-root` / `.chat-input-root` 上追加 `data-chat-style` 与 `data-chat-motion` 属性，CSS 用属性选择器覆盖变量与少量结构规则。
- **默认值**：`chatStyle: 'classic'`（存量用户零惊吓），新用户引导推荐 `pulse`；`motionLevel: 'full'`，且无条件尊重系统 `prefers-reduced-motion`（介质查询优先级高于用户档位）。

---

## 4. 四种对话风格定义

> 设计原则：Restrained 色彩策略（product 默认）；品牌蓝为唯一主 accent，AI 紫（`--c-accent-ai`）仅用于思考/AI 身份点缀；一套 DOM，形态差异全部由作用域 CSS 表达。

### 4.1 Classic · 经典（迁移基线）

现状还原，作为默认值保证升级无感。用户右侧渐变蓝气泡，AI 头像 + 通栏内容。唯一变化：样式来源从 TSX 硬编码迁移到 `chat-user-bubble-skin` 语义 class（观感逐像素一致）。

### 4.2 Pulse · 活力（本次主打，推荐新默认）

| 维度 | 规格 |
|---|---|
| 布局 | 同 Classic 骨架（用户右气泡 / AI 通栏），消息间距 +2px，回合间渐隐 hairline 分隔 |
| 用户气泡 | 品牌蓝实色 + 顶部 1px 内高光（`inset 0 1px 0 rgba(255,255,255,.18)`），圆角 18px，发送侧底角 6px（方向感） |
| AI 身份 | 头像 22px；**流式时**外圈品牌蓝呼吸光环（2.4s），静止时无光环 |
| 动效 | 全套活力动效（见 §5）：用户消息 pop 入场、AI 块 stagger 浮现、shimmer 流式光标、工具卡扫光 |
| 点缀 | 思考块用 `--c-accent-ai` 紫 tint 背景 + 呼吸图标；工具卡类别色点（替代左条纹） |

### 4.3 Duo · 对话（双侧气泡）

| 维度 | 规格 |
|---|---|
| 布局 | AI 内容也进气泡：左侧 `bg-elevated` + 1px border 气泡（max-width 88%），用户右侧品牌蓝气泡；双侧头像 |
| 圆角 | 18px，双侧内角 6px；无尾巴（避免幼稚化） |
| 适用 | 把 AI 当"对话伙伴"的用户；多会话网格中角色辨识度最高 |
| 动效 | 中档：气泡 pop 入场 + 流式光标，无扫光/光环 |
| 注意 | 代码块/表格在气泡内自动降低内边距（`--chat-bubble-padding-x` 收窄至 12px），宽内容（表格/diff）允许贴气泡边缘通排 |

### 4.4 Zen · 极简（文档流）

| 维度 | 规格 |
|---|---|
| 布局 | 全通栏无气泡：用户消息为 `--c-primary` 6% tint 整行块 + 左侧 "你" 角色标签；AI 消息无头像，角色行仅 引擎名·时间 |
| 密度 | 最高：message-gap 6px、无气泡 padding、代码块 padding 12px |
| 适用 | 长技术会话、深度阅读、低刺激环境；最接近 CLI/文档心智 |
| 动效 | 仅 160ms opacity fade；流式光标为 1.5px 竖线闪烁（终端心智） |

### 4.5 风格 × 变量映射总表（实现规格）

| Token（新增） | classic | pulse | duo | zen |
|---|---|---|---|---|
| `--chat-user-bubble-bg` | 渐变(primary→primary-600) | rgb(--c-primary) | rgb(--c-primary) | rgba(--c-primary/.06) |
| `--chat-user-bubble-fg` | --c-on-primary | --c-on-primary | --c-on-primary | --c-text-primary |
| `--chat-user-max-width` | 85% | 82% | 78% | 100% |
| `--chat-ai-surface-bg` | transparent | transparent | rgb(--c-bg-elevated) | transparent |
| `--chat-ai-surface-border` | none | none | 1px rgba(--c-border/.08) | none |
| `--chat-avatar-display` | flex | flex | flex(双侧) | none |
| 结构规则 | — | 头像光环层 | AI 气泡容器 padding | 用户整行块/隐藏头像 |

---

## 5. 活力化动效系统（横切所有风格）

### 5.1 动效规范表

| # | 动效 | 触发 | 规格 | 档位 |
|---|---|---|---|---|
| M1 | 用户消息入场 | 发送新消息 | translateY(6px)+scale(.98)→1 / opacity，180ms `cubic-bezier(.25,1,.5,1)` | full/subtle |
| M2 | AI 内容块入场 | 新块追加 | translateY(8px)→0 / opacity，220ms 同曲线，块间 stagger 40ms（上限 3 块） | full |
| M3 | 流式光标 | isStreaming | 8×16px 圆角块光标，品牌蓝 35% → 12% shimmer 呼吸 1.2s；zen 为 1.5px 竖线 blink | 全档位（off 时静态色块） |
| M4 | 头像流式光环 | isStreaming（pulse） | box-shadow 0→6px rgba(primary/.25) 呼吸 2.4s | full |
| M5 | 工具卡运行态 | status=running | 卡片顶部 1.5px 品牌蓝扫光（translateX -100%→100%，1.6s linear 循环） | full/subtle（subtle 降为边框呼吸） |
| M6 | 工具卡完成 | status=success | 状态图标 scale(.5)→1 pop，200ms | full/subtle |
| M7 | 工具卡失败 | status=failed | 复用现有 `animate-shake-once` + `--c-status-danger` 边框 | 全档位 |
| M8 | 思考块思考中 | thinking streaming | 图标 opacity 呼吸 1.8s + 紫 tint 背景 | full/subtle |
| M9 | 发送按钮反馈 | 点击发送 | scale(.92)→1，140ms + 输入框清空 fade | full/subtle |
| M10 | 骨架屏 | 会话加载 | 3 行渐变 shimmer 占位（替代空白闪现） | 全档位 |

### 5.2 强制约束

- **只动 transform / opacity / box-shadow**，禁止 layout 属性动画；循环动画（M3/M4/M5/M8）限定同屏只在"最后一条流式消息"上运行。
- **入场动画只对增量消息触发**：以"消息时间戳 > 列表挂载时间"判定，Virtuoso 滚动回收重挂载的历史消息不得重放动画（旧 PRD 的 MessageEntranceAnimation 思路，判定条件收紧）。
- **`@media (prefers-reduced-motion: reduce)`**：所有 M1-M10 降级为 ≤120ms opacity crossfade 或静态态，无条件生效。
- 动效档位实现为 `data-chat-motion` 作用域下的变量开关（`--m-entrance-duration: 0ms` 即关闭），不在 JS 里分支。

---

## 6. 技术架构与落地改动清单

### 6.1 配置链路（类型 → 注入 → 持久化）

```ts
// types/config.ts
export type ChatStyleId = 'classic' | 'pulse' | 'duo' | 'zen'
export type ChatMotionLevel = 'full' | 'subtle' | 'off'

export interface ChatDisplaySettings {
  // ...现有字段不变
  chatStyle: ChatStyleId        // 默认 'classic'
  motionLevel: ChatMotionLevel  // 默认 'full'
}
```

`getChatDisplayStyleVars()` 保持只管排版变量；新增 `getChatStyleAttrs(settings)` 返回 `{ 'data-chat-style': ..., 'data-chat-motion': ... }`，与 styleVars 一起挂到 4 个根节点。

### 6.2 改动文件清单

| # | 文件 | 改动 | 阶段 |
|---|---|---|---|
| 1 | `src/types/config.ts` | `ChatStyleId`/`ChatMotionLevel` 类型、默认值、normalize、`getChatStyleAttrs()` | P1 |
| 2 | `src/index.css` | 新增「聊天风格皮肤」段（4 段属性选择器变量覆盖 + 结构规则）+「聊天动效」段（keyframes + reduced-motion）；`.prose`/hljs 段 hex → `--c-*` token | P0/P1/P2 |
| 3 | `src/components/Chat/chatBubbles/UserBubble.tsx` | L100-102 硬编码渐变 → `chat-user-bubble-skin` 语义 class；入场动画 class 判定 | P0/P2 |
| 4 | `src/components/Chat/chatBubbles/AssistantBubble.tsx` | 头像/头部/容器加语义 class（`chat-assistant-avatar/surface`）；三点光标 → `<StreamingCursor/>`；memo 比较器同步 | P1/P2 |
| 5 | `src/components/Chat/StreamingCursor.tsx`（新建） | 风格感知流式光标（shimmer 块 / 竖线两种形态，读 CSS 变量自动切换） | P2 |
| 6 | `src/components/Chat/chatBlocks/ToolCallBlockRenderer.tsx` | 左条纹 `border-l-2` → 类别色点；running 扫光层；success pop | P2 |
| 7 | `src/components/Chat/chatBlocks/ThinkingBlockRenderer.tsx` + `blockGrouping.tsx` | 紫 tint 统一、呼吸图标接动效变量 | P2 |
| 8 | `src/components/Chat/EnhancedChatMessages.tsx` | 根节点挂 `getChatStyleAttrs`；挂载时间戳 ref（入场判定）；骨架屏 | P1/P2 |
| 9 | `src/components/Chat/ChatInput.tsx` | 根节点挂属性；发送按钮 M9 | P1/P2 |
| 10 | `src/components/MultiSession/SessionCell.tsx` | 根节点挂属性（与主聊天一致） | P1 |
| 11 | `src/components/Settings/tabs/GeneralTab.tsx` | 「对话风格」选择卡（4 张迷你缩略图卡片 + 即时预览）+「动效」SegmentedButton；预览区挂属性 | P3 |
| 12 | `src/locales/zh-CN/settings.json` + `en-US` | chatStyle/motionLevel 文案 | P3 |
| 13 | `tailwind.config.js` | 若干 keyframes 补充（或全部收敛进 index.css，二选一，倾向后者以便变量参数化） | P2 |
| 14 | `src/components/Settings/SettingsPage.tsx` | `topLevelKeysByTab.general` 已含 `chatDisplay`，无需改（确认即可） | P1 |

### 6.3 兼容性要点

- **旧配置迁移**：`normalizeChatDisplaySettings` 对缺失字段回落默认值，天然兼容存量配置，无迁移脚本。
- **多表面**：`SessionCell` / 移动端 `MobileSessions` 复用 `renderChatMessage`，属性注入点齐备后自动生效；移动端 P3 验证一轮触控/性能。
- **AIPopover / SessionPreviewModal**：共用渲染链，默认继承主设置；预览模态属只读场景，动效档强制 subtle。

---

## 7. 分期实施计划

| 阶段 | 内容 | 预估 | 出口标准 |
|---|---|---|---|
| **P0 清债** | hljs/.prose token 化；UserBubble 样式语义化（观感不变） | 0.5 天 | 深浅主题下截图逐像素对比无回归 |
| **P1 风格机制** | 配置链路 + data 属性注入 + classic/zen 双风格落地 | 1 天 | 设置项手改配置可切换，4 表面一致 |
| **P2 活力化** | 动效系统 M1-M10 + pulse 风格 + motionLevel + StreamingCursor | 1.5 天 | 流式会话中动效按档位/系统偏好正确降级 |
| **P3 补全** | duo 风格 + 设置页风格选择卡（迷你预览）+ i18n + 移动端验证 | 1 天 | 设置页切换即时生效并持久化 |

总计约 4 人日。P0 可独立先行合并。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Virtuoso 回收导致历史消息重放入场动画 | 挂载时间戳判定 + 仅最后 N 条参与动画；P2 加长会话滚动回归用例 |
| 流式高频 setState 下动画掉帧 | 循环动画仅限最后一条流式消息；只用 compositor 属性；`will-change` 限定光标/扫光两处 |
| AssistantBubble memo 比较器漏更新导致动效状态不刷新 | 新增 props 时同步 comparator（清单 #4 显式列出） |
| 风格切换时 Virtuoso 已渲染行高变化 | 切换后调用既有的重算逻辑（与密度切换同路径，已验证） |
| 浅色主题对比度 | 用户气泡蓝底白字 ≥4.5:1（light 用 `--c-primary: 37 99 235`）；zen 的 6% tint 行文字用 `--c-text-primary`，逐风格跑对比度检查 |

---

## 9. 验收标准

1. 设置页可在 4 风格 × 3 动效档间切换，即时生效、持久化、重启保持。
2. 深/浅主题 × 4 风格全组合：正文对比度 ≥4.5:1，无硬编码色残留（grep `#[0-9A-Fa-f]{6}` 于聊天相关段为零新增）。
3. 系统开启"减少动态效果"时，所有循环/入场动画降级为 crossfade。
4. 流式输出 60fps（DevTools Performance 采样，长会话 200+ 消息场景）。
5. 主聊天 / 多会话网格 / 设置预览 / 移动端四表面风格一致。
6. 历史消息滚动无入场动画重放。

---

## 10. 原型使用说明

`docs/design/prototypes/polaris-chat-style-revamp.html`（亦通过 Polaris 面板预览渲染）：

- 顶栏可实时切换 **4 种风格 / 深浅主题 / 3 档动效**；
- 「重播对话」按钮完整演示 M1-M8：用户消息入场 → 思考块呼吸 → 工具卡运行扫光→完成 pop → 流式 shimmer 光标逐字输出；
- 原型内 CSS 变量命名与 §4.5 映射表一致，可直接作为 P1/P2 的实现参照。
