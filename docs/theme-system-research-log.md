# 主题系统 10 轮研究日志

> 目标：设计支持"用户最大程度自定义所有内容"的主题模块，经 10 轮研究后选定实施方案。
> UI 风格参考方案B（卡片沉浸型），但核心是自定义能力深度，非设置面板。

---

## 进度追踪

| 轮次 | 主题 | 状态 | 关键产出 |
|------|------|:----:|---------|
| R1 | 现状全量 CSS 变量审计 | ✅ 完成 | 40 颜色 + 12 沉浸 + 1 布局 + 3 内部 + 11 聊天 = 67 变量 |
| R2 | Tailwind 映射 + 消费方 + 配置结构审计 | ✅ 完成 | Tailwind 全覆盖 40 颜色；24 字段可持久化；Mermaid/xterm 硬编码二分 |
| R3 | 行业最大自定义能力调研 | ✅ 完成 | 9 系统对比；Obsidian 最细粒度；M3 唯一自动调色板 |
| R4 | 既有规划文档"自定义深度"审视 | ✅ 完成 | 发现 6 类硬编码未变量化 |
| R5 | 自定义能力边界定义 | ✅ 完成 | 7 层能力模型 + 必做/可选分级 |
| R6 | 技术实现路径选型对比 | ✅ 完成（内联） | 推荐路径A+C 组合，分阶段 |
| R7 | 主题文件格式与版本迁移 | ✅ 完成 | 5格式对比；推荐 .polaris-theme schema |
| R8 | 用户自定义 CSS 注入机制 | ✅ 完成 | 独立style标签+CSP配置+CSS校验 |
| R9 | 风险与回退链验证 | ✅ 完成 | 10 风险+8 不变量+6 迁移场景+性能预算 |
| R10 | 最终方案定稿 | ✅ 完成 | 见下方 R10 章节 |

---

## R1-R2：现状全量审计（2026-08-04）

### 变量总览（67 个 CSS 变量）

| 层级 | 变量家族 | 数量 | Tailwind 消费 | 用户可自定义 |
|------|---------|:----:|:---:|:---:|
| **L0 颜色** | `--c-primary*`(9) `--c-bg-*`(7) `--c-border`(1) `--c-text-*`(4) `--c-status-*`(7) `--c-priority-*`(4) `--c-accent-*`(3) `--c-misc`(5) | 40 | ✅ 全覆盖 | ✅ 已支持 |
| **L4 沉浸** | `--spiderman-*`(12) + 2 JS-only 派生 | 12+2 | ❌ 仅 App.css | ✅ 已支持 |
| **L5 布局** | `--window-opacity`(1) | 1 | ✅ 复合进 bg | ✅ 已支持 |
| **L1 排版** | `--chat-*`(11) | 11 | ❌ | ⚠️ 部分（chatDisplay） |
| **L3 内部** | `--orb-color-*`(3) | 3 | ❌ | ❌ **定义了却未消费** |

### 关键问题（新增 7 项）

| 编号 | 问题 | 影响 |
|------|------|------|
| Q1 | `--orb-*` 变量定义了但 App.css 硬编码 Orb 环颜色 | 主题切换无效 |
| Q2 | Mermaid `getMermaidConfig` 硬编码 dark/light，spiderman 回落 dark | 视觉割裂 |
| Q3 | xterm `getXtermTheme` 硬编码 dark/light 16 色，不消费 --c-* | 视觉割裂 |
| Q4 | App.css Git 面板大量硬编码颜色（#1A1A1D 等） | light/spiderman 不感知 |
| Q5 | spiderman 三处双写源（index.css / spiderman-theme.ts / main.tsx）需保持一致 | 维护负担 |
| Q6 | border-radius 60+ 处硬编码 | 用户无法自定义圆角 |
| Q7 | font-family 10+ 处硬编码（仅 chat 部分变量化） | 用户无法自定义全局字体 |

### 可持久化字段（24 个，TS/Rust 完全对齐）

- SpiderManThemeConfig: 13 字段
- ChatDisplaySettings: 8 字段
- WindowSettings: 2 字段
- theme: 1 字段

---

## R3：行业最大自定义能力调研（2026-08-04）

### 9 系统自定义能力对比（核心结论）

| 系统 | 颜色 | 间距 | 圆角 | 字体 | 动效 | 组件级覆盖 | 自定义 CSS | 用户 Snippet | 自动调色板 |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **VS Code** | ✅ 900+键 | ❌ | ❌ | ⚠️ 仅 settings | ❌ | ✅ 系统化 | ❌ 需扩展 | ✅ colorCustomizations | ❌ |
| **Obsidian** | ✅ 变量+任意 | ✅ 变量 | ✅ `--radius-*` | ✅ 变量 | ✅ 自由 | ✅ 任意选择器 | ✅ **纯 CSS** | ✅ **热加载** | ❌ |
| **JetBrains** | ✅ ui+XML | ❌ | ❌ | ⚠️ 仅编辑器 | ❌ | ✅ element.property | ❌ 非 Web | ⚠️ Scheme | ❌ |
| **shadcn/ui** | ✅ 语义对 | ⚠️ Tailwind | ✅ `--radius` 派生 | ✅ 可加 | ❌ | ✅ 源码可见 | ✅ globals.css | ✅ | ❌ |
| **M3 Builder** | ✅ HCT 种子 | ❌ | ⚠️ 规范 | ❌ | ❌ | ❌ 角色级 | ❌ | ✅ | ✅ **核心卖点** |
| Arc/Raycast/Linear/Geist | ✅ token | ❌ | ❌ | ⚠️ | ❌ | ❌ 黑盒 | ❌ | ❌ | ❌/✅Arc |

### 关键结论

1. **Obsidian 模式 = "最大自定义"的黄金参考**：纯 CSS + CSS 变量 + Snippets 热加载，间距/圆角/字体/动效全可改，组件级到任意选择器，单笔记 `cssclasses` 级覆盖。Polaris 作为 Web 栈（Tauri+React+Tailwind）天然适合此模式。

2. **VS Code 模式 = 系统化但封闭**：900+ 命名颜色键组件级覆盖，但无自定义 CSS、无间距/圆角/字体令牌。适合"开箱即用但不深改"的用户。

3. **Material 3 = 自动调色板唯一选项**：HCT 种子色 → 完整 tonal palette + light/dark 双套。Polaris 可借鉴作为"懒人模式"（用户给一个种子色自动生成主题）。

4. **shadcn/ui = 圆角派生尺度值得借鉴**：单一 `--radius` 派生 sm/md/lg/xl，改一处更新全套。Polaris 当前 60+ 处硬编码 border-radius 正需要此模式。

5. **闭源客户端普遍不支持深度自定义**：Arc/Raycast/Linear/Geist 都是 token 或预设主题级切换，无组件级覆盖/自定义 CSS。Polaris 作为开源应用应走得更深。

### Polaris 应融合的能力
- Obsidian 的 CSS 变量 + 用户 Snippet 注入（终极逃生舱）
- shadcn 的圆角派生尺度（解决 60+ 硬编码）
- Material 3 的种子色自动调色板（可选懒人模式）
- VS Code 的主题继承覆盖（`[*Dark*]` 通配按主题覆盖）

---

## R4：既有规划文档审视（2026-08-04）

### 发现：当前规划自定义深度严重不足

之前 `custom-theme-system-plan-analysis.md` 的 `ThemeDefinition` 仅覆盖：
- colors（颜色系统，~30 变量）
- layout.chatDisplay + layout.windowOpacity（2 项布局）
- immersive（沉浸效果，~13 变量）

### 代码中存在但**未被变量化**的硬编码样式（用户无法自定义）

| 类别 | 硬编码位置 | 数量 | 当前状态 |
|------|-----------|:----:|---------|
| **border-radius 圆角** | App.css / index.css 散落 | 60+ 处 | 全硬编码（2px~12px） |
| **font-family 字体** | index.css body / chat / code | 10+ 处 | 仅 chat 部分变量化（--chat-font-family） |
| **animation 动效** | orb/web/spiderman-btn/suggestion 等 | 15+ 处 | 全硬编码字面量 |
| **transition 过渡** | 各组件 hover/focus | 20+ 处 | 全硬编码（0.1s~0.3s） |
| **box-shadow 阴影** | tailwind boxShadow | 6 处 | 部分变量化（--c-shadow） |
| **spacing 间距** | tailwind spacing | 全部 | 未主题化（tailwind 默认值） |

### 结论

"最大自定义"要求把这些都纳入主题定义。需要分层设计：
1. **L0 颜色层**（已有基础）：所有 --c-* 变量
2. **L1 排版层**（待新增）：字体族、字号、行高、字重
3. **L2 形状层**（待新增）：圆角（组件级）、边框宽度
4. **L3 动效层**（待新增）：过渡时长、缓动函数、动画开关
5. **L4 沉浸层**（已有基础）：壁纸、透明度、磨砂
6. **L5 布局层**（部分已有）：窗口透明度、间距密度
7. **L6 用户 CSS 层**（待新增）：用户自定义 CSS 注入（终极逃生舱）

---

## R5：自定义能力边界定义（2026-08-04）

### 7 层能力模型（Polaris 主题能力清单）

基于 R1-R4 综合，定义 Polaris 主题系统的完整自定义能力边界：

#### L0 颜色层（40 变量）— **必做 P0**

| 子组 | 变量 | 数量 | 当前状态 |
|------|------|:----:|---------|
| Primary | base/hover/50-700 | 9 | ✅ 已变量化 |
| Background | base/elevated/surface/hover/active/tertiary/secondary | 7 | ✅ 已变量化 |
| Border | base | 1 | ✅ 已变量化 |
| Text | primary/secondary/tertiary/muted | 4 | ✅ 已变量化 |
| Status | warning/success/danger/info/done/failed/neutral | 7 | ✅ 已变量化 |
| Priority | low/normal/high/urgent | 4 | ✅ 已变量化 |
| Accent | ai/prototype/workspace | 3 | ✅ 已变量化 |
| Misc | overlay/onPrimary/canvas/tagBg/shadow | 5 | ✅ 已变量化 |

**结论**：颜色层基础完备，只需从 CSS 硬编码迁移到 ThemeDefinition 数据模型。

#### L1 排版层（~12 变量）— **必做 P0**

| 变量 | 当前状态 | 改造 |
|------|---------|------|
| `--font-sans` 全局字体族 | ❌ body 硬编码 | 新增变量 + ThemeDefinition |
| `--font-mono` 代码字体族 | ❌ 散落硬编码 SF Mono/Consolas | 新增变量 |
| `--font-chat` 对话字体族 | ✅ `--chat-font-family` | 纳入 ThemeDefinition |
| `--chat-font-size` | ✅ | 纳入 |
| `--chat-line-height` | ✅ | 纳入 |
| `--chat-code-font-size` | ✅ | 纳入 |
| `--chat-input-font-size` | ✅ | 纳入 |
| `--font-size-base` 基础字号 | ❌ 散落 12-14px | 新增 |
| `--font-weight-normal/medium/semibold/bold` | ❌ 散落 | 新增（可选） |
| `--letter-spacing` | ❌ | 新增（可选） |

**结论**：需新增全局字体族变量，把散落的 font-family/size/weight 收敛。

#### L2 形状层（~10 变量）— **必做 P0**

借鉴 shadcn 的 `--radius` 派生尺度：

| 变量 | 当前状态 | 改造 |
|------|---------|------|
| `--radius-sm` (2-4px) | ❌ 散落 60+ 处 | 新增派生变量 |
| `--radius-md` (6-8px) | ❌ | 新增 |
| `--radius-lg` (10-12px) | ❌ | 新增 |
| `--radius-xl` (14-16px) | ❌ | 新增 |
| `--radius-full` (50%/9999px) | ❌ | 新增 |
| `--chat-bubble-radius` | ✅ | 纳入 |
| `--border-width` | ❌ 散落 1-2px | 新增（可选） |
| `--border-style` | ❌ | 新增（可选） |

**结论**：这是当前最大的硬编码重灾区（60+ 处 border-radius）。引入派生尺度后，全局替换 `border-radius: 6px` → `border-radius: var(--radius-md)`。

#### L3 动效层（~8 变量）— **可选 P1**

| 变量 | 当前状态 | 改造 |
|------|---------|------|
| `--transition-fast` (0.1-0.15s) | ❌ 散落 20+ 处 | 新增 |
| `--transition-normal` (0.2-0.3s) | ❌ | 新增 |
| `--transition-slow` (0.4-0.5s) | ❌ | 新增 |
| `--ease-default` | ❌ 散落 ease/ease-out/cubic-bezier | 新增 |
| `--ease-in` / `--ease-out` / `--ease-in-out` | ❌ | 新增 |
| `--motion-reduce` (prefers-reduced-motion) | ⚠️ 部分媒体查询 | 新增开关 |
| `--animation-orb-duration` | ❌ 硬编码 1s/0.6s | 新增（可选） |

**结论**：动效层是"锦上添花"，非"最大自定义"的核心。P1 优先级，可后期补充。

#### L4 沉浸层（12 变量）— **必做 P0**

| 变量 | 当前状态 | 改造 |
|------|---------|------|
| `--theme-bg-image` | ✅ `--spiderman-bg-image` | 重命名 + 纳入 |
| `--theme-bg-overlay` | ✅ | 重命名 + 纳入 |
| `--theme-bg-position/size` | ✅ | 重命名 + 纳入 |
| `--theme-panel-opacity` | ✅ | 重命名 + 纳入 |
| `--theme-panel-blur` | ✅ | 重命名 + 纳入 |
| `--theme-surface-opacity` | ✅ | 重命名 + 纳入 |
| `--theme-web-opacity` | ✅ | 重命名 + 纳入 |
| `--theme-hover-opacity` | ✅ | 重命名 + 纳入 |
| `--theme-blue-accent` | ✅ | 重命名 + 纳入 |
| `--theme-avatar-url` | ✅ | 重命名 + 纳入 |
| `--theme-chat-tool-opacity` | ✅ | 重命名 + 纳入 |
| `--theme-bg-off` | ✅ data attr | 纳入 |

**结论**：已有基础，只需通用化命名（`--spiderman-*` → `--theme-*`）+ 从 spiderman 专属解耦为任意沉浸主题可用。

#### L5 布局层（~5 变量）— **必做 P0**

| 变量 | 当前状态 | 改造 |
|------|---------|------|
| `--window-opacity` | ✅ | 纳入 ThemeDefinition.layout |
| `--chat-message-gap` | ✅ | 纳入 |
| `--chat-block-gap` | ✅ | 纳入 |
| `--chat-bubble-padding-x/y` | ✅ | 纳入 |
| `--chat-paragraph-spacing` | ✅ | 纳入 |

**结论**：已有基础，纳入 ThemeDefinition 即可。

#### L6 用户 CSS 层 — **必做 P0（终极逃生舱）**

参考 Obsidian Snippets 模式：

- 用户可在主题中附加一段自定义 CSS（`customCss` 字段）
- themeEngine 注入到独立的 `<style id="theme-custom-css">` 标签
- 优先级最高，可覆盖任何内置样式
- 导入导出时随主题一起打包
- 提供语法高亮编辑器（CodeMirror/Monaco）
- 安全性：不执行 JS、不加载外部资源（CSP 限制）

**结论**：这是"最大自定义"的终极保障。即使 ThemeDefinition 漏了某个变量，用户也能通过 customCss 覆盖。

### 能力分级总结

| 层级 | 优先级 | 变量数 | 当前状态 | 改造工作量 |
|------|:------:|:----:|---------|---------|
| L0 颜色 | P0 | 40 | ✅ 已变量化 | 低（数据模型化） |
| L1 排版 | P0 | ~12 | ⚠️ 部分 | 中（收敛硬编码） |
| L2 形状 | P0 | ~10 | ❌ 硬编码 60+ | **高**（全局替换） |
| L3 动效 | P1 | ~8 | ❌ 硬编码 20+ | 中（可选） |
| L4 沉浸 | P0 | 12 | ✅ 已变量化 | 中（通用化命名） |
| L5 布局 | P0 | ~5 | ✅ 已变量化 | 低（纳入模型） |
| L6 用户 CSS | P0 | 1 | ❌ 无 | 中（注入机制） |
| **合计** | | **~88** | | |

### 必做能力清单（P0）

1. ✅ 40 颜色变量数据模型化（L0）
2. ✅ 12 沉浸变量通用化重命名（L4）
3. ✅ 5 布局变量纳入模型（L5）
4. ⚠️ 12 排版变量收敛硬编码（L1）
5. ⚠️ 10 形状变量派生 + 全局替换 60+ 硬编码（L2）
6. ⚠️ 用户自定义 CSS 注入机制（L6）

### 可选能力清单（P1-P2）

7. 动效层 8 变量（L3）
8. 种子色自动调色板生成（借鉴 M3）
9. 主题继承（extends 字段）
10. 主题片段（只导出颜色子集）
11. Mermaid/xterm 主题跟随（解决 Q2/Q3）
12. `--orb-*` 变量消费修复（解决 Q1）

### 最终 ThemeDefinition 能力覆盖

```
ThemeDefinition
├── colors (L0) ............ 40 变量 [P0]
├── typography (L1) ........ 12 变量 [P0]
├── shape (L2) ............. 10 变量 [P0]
├── motion (L3) ........... 8 变量 [P1 可选]
├── immersive (L4) ......... 12 变量 [P0]
├── layout (L5) ............ 5 变量 [P0]
└── customCss (L6) ......... 1 字段 [P0 终极逃生舱]

总计：~88 个可自定义维度
```

这远超当前规划的 ~45 个变量，真正实现"最大程度自定义所有内容"。

---

## R6：技术实现路径选型对比（2026-08-04）

### 三条技术路径对比

基于 R3 行业调研结果（Obsidian 纯 CSS、VS Code 900+键、shadcn 变量+源码、M3 自动生成），对比三条路径：

| 维度 | 路径A 纯CSS变量注入 | 路径B 运行时样式表生成 | 路径C 用户自定义CSS注入 |
|------|:---:|:---:|:---:|
| **自定义能力边界** | 变量值（颜色/尺寸/时长） | 任意选择器+媒体查询+keyframes | **任意CSS**（终极） |
| **能改什么** | 已定义的 ~88 个变量 | 新增规则、覆盖选择器 | **一切** |
| **不能改什么** | 选择器结构、新增规则 | 仍需JS生成，不能让用户写 | 受CSP限制（无JS/外部资源） |
| **与Tailwind兼容** | ✅ 完美（当前就是此模式） | ⚠️ 需绕过Tailwind | ✅ 覆盖在Tailwind之后 |
| **性能** | ✅ 最佳（setProperty批量） | ⚠️ CSSOM操作可能闪烁 | ✅ 单style标签注入 |
| **FOUC风险** | 低（可同步注入） | 中（异步生成可能闪） | 低（独立style标签） |
| **实现复杂度** | 低（~3人日） | 高（~8人日） | 中（~3人日） |
| **用户门槛** | 低（可视化编辑器） | — | **高**（需懂CSS） |
| **行业采用** | shadcn/Geist/当前Polaris | 罕见（CSS-in-JS库） | **Obsidian/VS Code(部分)** |
| **维护成本** | 低 | 高（规则碰撞） | 低（用户自负责） |

### 推荐方案：路径 A + C 组合（分阶段）

**核心决策：不选路径B。**
理由：路径B 的能力完全被路径C 覆盖（用户CSS能写任何选择器和keyframes），且B的实现复杂度是A的3倍，性能风险更高。A+C 组合既保留了A的"可视化低门槛"，又通过C提供了"终极逃生舱"。

#### 阶段 1（P0）：路径 A — CSS 变量注入引擎

```
themeEngine.applyTheme(themeId)
  ├─ loadThemeDefinition(themeId)      // 从 store/service 加载
  ├─ deepMerge(DARK_THEME, theme)      // 回退链
  ├─ flattenToCSSVars(merged)          // 扁平化为 ~88 个键值对
  ├─ injectToDocumentElement(vars)     // style.setProperty 批量
  ├─ setDataAttr('data-theme', id)     // 主题标识
  ├─ setDataAttr('data-theme-immersive', immersive.enabled)
  └─ persistActiveThemeId(id)          // localStorage + config
```

**实现要点：**
- 批量注入：使用 `CSSStyleDeclaration.setProperty`，对 ~88 个变量一次性写入
- FOUC 保护：`main.tsx` 内联 IIFE 同步读取 localStorage + 同步注入（与当前 spiderman 模式一致）
- 回退链：深合并到 DARK_THEME，缺失字段自动用 dark 默认值
- 兼容旧名：过渡期同时注入 `--spiderman-*` 和 `--theme-*`（双写）

#### 阶段 2（P0）：路径 C — 用户自定义 CSS 注入

```
themeEngine.applyCustomCss(cssText)
  ├─ 获取或创建 <style id="theme-custom-css">
  ├─ textContent = cssText             // 替换内容
  └─ 确保在所有样式表之后（最高优先级）
```

**实现要点：**
- 独立 `<style>` 标签，textContent 替换（避免 CSSOM 增量操作）
- 位置：document.head 末尾，确保覆盖 Tailwind 和主题变量
- CSP 限制：`style-src 'unsafe-inline'`（Tauri 默认允许），禁止 `@import` 外部资源
- 安全：不执行 JS、不加载外部图片（`url()` 仅允许 data: 或已验证域名）
- 编辑器：Phase 3 提供带语法高亮的 CSS 编辑器（CodeMirror 轻量版）

#### 阶段 3（P1 可选）：种子色自动调色板

借鉴 Material 3 HCT 算法（可选）：
- 用户输入一个种子色
- 自动生成 primary 50-700 全套色阶
- 自动生成 background/text/status 配套色
- 作为"懒人模式"，降低普通用户门槛

### 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 注入方式 | style.setProperty | 与现有架构兼容，性能最佳 |
| 用户CSS | 独立style标签 | Obsidian 模式，最简最稳 |
| 不用CSSOM | — | 避免闪烁+复杂度 |
| 不用CSS-in-JS | — | 与Tailwind冲突，过度工程 |
| 回退链 | 深合并到DARK | 保证完整性 |
| FOUC | 内联IIFE同步注入 | 与当前main.tsx一致 |
| 双写兼容 | --spiderman-* + --theme-* | 过渡期不破坏现有CSS |

### 实施工作量重估（基于 R5 能力边界）

| Phase | 内容 | 人日 |
|-------|------|:---:|
| Phase 0 | 数据模型 + 存储（含 L0-L6 完整定义） | 2.5 |
| Phase 1 | themeEngine（路径A）+ CSS通用化 | 3.5 |
| Phase 2 | 用户CSS注入（路径C）+ 安全沙箱 | 2 |
| Phase 3 | 管理UI + 编辑器UI（方案B风格） | 4 |
| Phase 4 | 硬编码收敛（L1字体+L2圆角 60+处） | 3 |
| Phase 5 | 可选：种子色调色板 + Mermaid/xterm跟随 | 2 |
| **合计** | | **~17** |

比原规划 ~12 人日增加 ~5 人日，主要来自 L2 形状层 60+ 处硬编码收敛和 L6 用户CSS机制。

---

## R9：风险与回退链验证（2026-08-04）

### 风险清单（基于 R1-R8 综合评估）

| 编号 | 风险 | 等级 | 概率 | 影响 | 缓解措施 | 验证方式 |
|------|------|:---:|:---:|:---:|---------|---------|
| K1 | **首屏 FOUC 闪烁** | 高 | 中 | 高 | main.tsx 内联 IIFE 同步注入（与当前 spiderman 模式一致） | 启动录帧检查 |
| K2 | **CSS 变量注入性能** | 中 | 低 | 中 | 批量 setProperty，~88 变量 < 5ms；requestAnimationFrame 合并 | performance.mark 测量 |
| K3 | **旧配置兼容** | 中 | 高 | 中 | 保留 theme/spidermanTheme 字段读取；迁移逻辑在 configStore 加载时自动执行 | 旧 config.json 单测 |
| K4 | **用户主题文件冲突** | 低 | 中 | 低 | 导入时自动加 "(2)" 后缀；UUID 防重复 | E2E 导入测试 |
| K5 | **沉浸效果渲染开销** | 低 | 低 | 中 | backdrop-filter 仅 immersive.enabled 时生效；prefers-reduced-motion 兜底 | 性能 profiling |
| K6 | **localStorage 容量** | 低 | 低 | 低 | 大背景图用 data URI 注意 ~5MB 限制；主存储走 DataRoot 文件 | 容量监控 |
| K7 | **用户 CSS 破坏布局** | 中 | 中 | 中 | 独立 style 标签可一键禁用；提供"安全模式"重置按钮 | 破坏性CSS测试 |
| K8 | **主题切换 Mermaid/xterm 不跟随** | 中 | 高 | 中 | R1 已知 Q2/Q3；Phase 5 改为读取 CSS 变量动态生成配置 | 视觉回归 |
| K9 | **圆角全局替换遗漏** | 中 | 中 | 低 | 60+ 处 border-radius 需逐一替换；用 grep 校验无残留 | `grep border-radius` 零硬编码 |
| K10 | **--orb-* 变量未消费** | 低 | 已知 | 低 | R1 已知 Q1；Phase 1 修复 App.css 消费 --orb-* | 代码审查 |

### 回退链设计（三层保障）

```
┌─ Layer 1: 用户主题 ThemeDefinition ──────────────┐
│  用户提供完整定义 → flattenToCSSVars()          │
│  缺失字段 → 深合并到 DARK_THEME 兜底             │
└──────────────────────────────────────────────────┘
                       ↓ 缺失时
┌─ Layer 2: 内置 Dark 主题常量 ───────────────────┐
│  DARK_THEME 提供 ~88 个变量完整默认值            │
│  确保任何字段都有兜底                             │
└──────────────────────────────────────────────────┘
                       ↓ 仍缺失时
┌─ Layer 3: CSS var() fallback ────────────────────┐
│  index.css :root 提供静态默认值                  │
│  var(--c-primary, 59 130 246) 内联 fallback      │
│  即使 JS 引擎完全失败，页面仍可阅读               │
└──────────────────────────────────────────────────┘
```

### 关键不变量（验证清单）

| 编号 | 不变量 | 验证时机 |
|------|--------|---------|
| INV1 | `data-theme` 属性始终等于 activeThemeId | 每次 applyTheme 后 |
| INV2 | `data-theme-immersive` 仅在 immersive.enabled 时为 "true" | 切换主题后 |
| INV3 | `--c-primary` 始终有值（用户主题 → dark → CSS fallback） | 启动+切换后 |
| INV4 | 内置主题不可删除、不可改名（builtIn: true 标志） | CRUD 操作时 |
| INV5 | 删除当前激活主题 → 自动回退到 dark | 删除后 |
| INV6 | 用户 CSS style 标签始终在 head 末尾（最高优先级） | 注入后 |
| INV7 | localStorage('activeThemeId') 与 config.activeThemeId 一致 | 每次激活 |
| INV8 | 旧 config.theme 字段读取时自动迁移到 activeThemeId | configStore.loadConfig |

### 迁移验证矩阵

| 场景 | 旧配置 | 期望行为 | 验证 |
|------|--------|---------|------|
| M1 | `{theme:'dark'}` | activeThemeId=dark-uuid | 单测 |
| M2 | `{theme:'spiderman', spidermanTheme:{...}}` | activeThemeId=spiderman-uuid + 沉浸配置合并 | 单测 |
| M3 | `{activeThemeId:'xxx'}` | 直接使用，不迁移 | 单测 |
| M4 | `{theme:'unknown'}` | 回退到 dark | 单测 |
| M5 | 旧 localStorage 有 'theme' 无 'activeThemeId' | 迁移 | 单测 |
| M6 | 自定义主题文件损坏 | 跳过+回退 dark+告警 | E2E |

### 性能预算

| 指标 | 预算 | 测量方式 |
|------|------|---------|
| 主题切换 → CSS 变量注入 | < 16ms (一帧) | performance.mark |
| 首屏 FOUC | 0 帧（内联同步注入） | 录屏 |
| 88 变量 setProperty 批量 | < 5ms | performance.measure |
| 用户 CSS 注入（10KB） | < 2ms | performance.measure |
| 主题文件读取（磁盘） | < 50ms | 文件 IO 计时 |

---

## R7：主题文件格式与版本迁移（2026-08-04）

### 5 种主流格式对比（核心结论）

| 格式 | 扩展名 | 版本字段 | 继承机制 | 颜色编码 | 自动调色板 |
|------|--------|---------|---------|---------|:---:|
| **VS Code** | `.json` | package.json semver | `include` 文件级 | `#RRGGBB` | ❌ |
| **Obsidian** | `.css`+`manifest.json` | semver + `minAppVersion` | 无 | CSS 值 | ❌ |
| **JetBrains .icls** | `.icls`(XML) | 整数模式版本 | `parent_scheme` | 裸 `RRGGBB` | ❌ |
| **JetBrains .theme.json** | `.theme.json` | 无 | `parentScheme` | 裸 `RRGGBB` | ❌ |
| **Material 3** | `.json` | `version:3`+`schemeVersion` | 无（预计算） | `#RRGGBB` | ✅ HCT |
| **shadcn/ui** | `.css`+`components.json` | `$schema` URI + `style` | 无 | HSL三元组/Hex | ❌ |

### 关键设计借鉴

| 借鉴点 | 来源 | 应用于 Polaris |
|--------|------|---------------|
| `formatVersion` 数字版本字段 | M3 + Obsidian | `.polaris-theme` 必须有 |
| `extends` 主题继承 | VS Code `include` + JetBrains `parentScheme` | 可选字段，引用父主题 ID |
| `minAppVersion` 兼容门控 | Obsidian | 主题文件声明最低应用版本 |
| 预计算调色板（不依赖运行时算法） | M3 | 主题文件存最终值，非种子色 |
| 颜色用 RGB 三元组 | 当前 Polaris + shadcn HSL | **保持 RGB 三元组**（与 Tailwind `rgb(var() / <alpha>)` 兼容） |
| 主题 = CSS 变量集 + 元数据 | shadcn + Obsidian | ThemeDefinition 扁平化 → CSS vars |

### `.polaris-theme` 文件格式定稿

```json
{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-04T12:00:00Z",
  "minAppVersion": "10.3.0",
  "theme": {
    "name": "赛博朋克2077",
    "description": "受 Cyberpunk 2077 启发的霓虹主题",
    "author": "user123",
    "version": 1,
    "extends": null,
    "colors": {
      "primary": { "base": "255 0 128", "hover": "200 0 100", "50": "...", "...": "..." },
      "background": { "base": "10 0 20", "elevated": "...", "..." : "..." },
      "border": { "base": "..." },
      "text": { "primary": "...", "..." : "..." },
      "status": { "warning": "...", "..." : "..." },
      "priority": { "low": "...", "..." : "..." },
      "accent": { "ai": "...", "..." : "..." },
      "misc": { "overlay": "...", "..." : "..." }
    },
    "typography": {
      "fontSans": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "fontMono": "'JetBrains Mono', 'Fira Code', monospace",
      "fontSizeBase": "14px",
      "fontWeightNormal": "400",
      "fontWeightMedium": "500",
      "fontWeightSemibold": "600",
      "letterSpacing": "normal"
    },
    "shape": {
      "radiusSm": "4px",
      "radiusMd": "8px",
      "radiusLg": "12px",
      "radiusXl": "16px",
      "radiusFull": "9999px"
    },
    "layout": {
      "windowOpacity": { "normal": 100, "compact": 100 },
      "chatDisplay": { "fontSize": 14, "lineHeight": 1.55, "..." : "..." }
    },
    "immersive": {
      "enabled": true,
      "wallpaper": { "type": "image", "image": "data:...", "opacity": 0.8, "..." : "..." },
      "layerOpacity": { "panel": 0.55, "surface": 0.50, "child": 0.55 },
      "effects": { "panelBlur": 8, "webTexture": 0.15, "blueAccent": 0.5, "hoverOpacity": 0.5 },
      "avatar": { "url": "..." }
    },
    "customCss": "/* 用户自定义 CSS，覆盖一切 */\n:root { --my-custom: red; }"
  }
}
```

### 版本迁移策略

**`formatVersion` 设计：**
- `1` = 初始版本（当前）
- 整数递增，非 semver（与 M3/JetBrains 一致）
- 每次破坏性变更 +1

**迁移函数组织：**
```typescript
const MIGRATIONS: Record<number, (data: any) => any> = {
  1: (d) => d,  // 当前版本，无操作
  // 2: (d) => migrateV1ToV2(d)  // 未来：字段重命名等
};

function migrateThemeFormat(data: any): ThemeDefinition {
  const version = data.formatVersion ?? 1;
  let current = data;
  for (let v = version; v < CURRENT_FORMAT_VERSION; v++) {
    current = MIGRATIONS[v]?.(current) ?? current;
  }
  return current.theme;
}
```

**兼容性矩阵：**

| 场景 | 处理 |
|------|------|
| 新应用读旧格式（v1 → v2） | 迁移函数升级 |
| 旧应用读新格式（v2 → v1） | `minAppVersion` 门控 + 警告"需更新应用" |
| 字段废弃 | 保留读取，导出时不写 |
| 破坏性变更 | formatVersion +1 + 迁移函数 |

### 导入验证清单

| 检查项 | 失败处理 |
|--------|---------|
| JSON 解析失败 | "文件格式错误" |
| formatVersion 不支持 | "版本过低/过高，请更新应用" |
| type !== "polaris-theme" | "不是有效的主题文件" |
| 缺少必填字段（name/colors） | "主题数据不完整" |
| 颜色值格式错误（非 "R G B"） | 用 dark 默认值替代 + 警告 |
| 名称 > 32 字符 | 截断 |
| 与已有主题同名 | 自动加 "(2)" 后缀 |
| customCss 含 `@import` | 拒绝并提示"不允许外部资源" |
| customCss 含 `url(http://)` | 拒绝（仅允许 data: 和白名单） |

### 主题继承决策

**决策：支持 `extends` 字段（可选）。**

理由：
- VS Code `include` 和 JetBrains `parentScheme` 都证明了继承的价值
- 用户可基于内置主题创建变体，只覆盖差异（如只改 primary 颜色）
- 减少主题文件体积
- 实现简单：加载时深合并 `父主题 + 子主题`

**但：导出时拍平继承。**
- 导出的 `.polaris-theme` 不含 `extends`，所有字段已合并
- 确保导入到其他机器时不依赖原父主题存在

---

## R8：用户自定义 CSS 注入机制（2026-08-04）

### 核心结论

基于 Tauri CSP 深度研究 + R3 Obsidian Snippets 模式：

**注入方式：方式 A — 独立 `<style id="theme-custom-css">` 标签 + textContent 替换**

理由（基于 R6 路径选型 + CSP 研究）：
- ✅ 最简单稳定，无 CSSOM 增量操作风险
- ✅ textContent 替换自动清除旧规则，无泄漏
- ✅ Tauri WebView2 完美支持
- ✅ Obsidian 同款模式，已验证可行
- ❌ 方式B（CSSStyleSheet API）复杂度高三倍，且 adoptedStyleSheets 在 WebView2 有兼容性风险

### Tauri CSP 配置（关键发现）

**核心认知：CSP 不检查 CSS 文本内容，只管加载时源白名单。**

- `style-src 'self' 'unsafe-inline'` → 允许内联 `<style>` 元素存在
- `<style>` 内的文本**不受 CSP 内容审查**（CSP 不是 CSS 解析器）
- 但 `<style>` 内 `@import url(http://evil.com)` 触发的样式表**获取请求**受 `style-src` 管控 → `evil.com` 不在白名单则被阻止
- `background: url(http://evil.com/leak)` 受 **`img-src`** 管控（非 style-src）

**推荐 CSP 配置（src-tauri/tauri.conf.json）：**
```json
"security": {
  "csp": {
    "default-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["ipc:", "http://ipc.localhost"],
    "script-src": ["'self'"]
  }
}
```

当前 Polaris 是 `csp: null`（完全禁用），需收紧。注意：收紧前需验证不影响现有功能（IPC、插件面板、图片加载）。

### 安全策略（双层防护）

**层 1：CSP 网络层（浏览器自动执行）**
- `@import` 外部样式表 → 被 `style-src` 拦截
- `url(http://)` 图片 → 被 `img-src` 拦截（仅允许 data:/blob:/self）
- `@font-face src: url(http://)` → 被 `font-src` 拦截

**层 2：应用层 CSS 校验（导入时静态检查）**
```typescript
function validateCustomCss(css: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  // 禁止 @import 外部资源
  if (/@import\s+url\s*\(\s*['"]?\s*https?:\/\//i.test(css)) {
    errors.push('不允许 @import 外部资源');
  }
  // 禁止 url() 引用外部 http(s) 资源
  if (/url\s*\(\s*['"]?\s*https?:\/\//i.test(css)) {
    errors.push('不允许 url() 引用外部 http(s) 资源，仅允许 data: 和相对路径');
  }
  // 禁止 expression()（WebView2 无效但防御性拦截）
  if (/expression\s*\(/i.test(css)) {
    errors.push('不允许 expression()');
  }
  // 禁止 javascript: 协议
  if (/javascript:/i.test(css)) {
    errors.push('不允许 javascript: 协议');
  }
  return { valid: errors.length === 0, errors };
}
```

### 优先级保证

用户 CSS 必须覆盖 Tailwind utility 和主题变量：

**方案：独立 style 标签置于 head 末尾 + `!important` 可选**
- `<style id="theme-custom-css">` 插入到 `document.head` 末尾
- 在 Tailwind 和主题变量之后加载
- 相同 specificity 下，后加载胜出
- 用户可用 `!important` 进一步提升优先级
- 提供"应用 !important"开关（自动给所有规则加 !important）

### 注入流程

```typescript
// themeEngine.applyCustomCss(cssText)
function applyCustomCss(cssText: string): void {
  let styleEl = document.getElementById('theme-custom-css') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'theme-custom-css';
    document.head.appendChild(styleEl);  // 末尾，最高优先级
  }
  styleEl.textContent = cssText;  // textContent 替换，自动清旧
}
```

### 编辑器选型

**决策：CodeMirror 6（basicSetup + @codemirror/lang-css）**

理由（基于实测 gzip 大小）：
- ✅ 146KB gzip（Monaco 是 2.0MB+ gzip，体积差 14 倍）
- ✅ `@codemirror/lang-css` **开箱即用支持 CSS 自定义属性补全**（已验证源码：`cssCompletionSource` 精确匹配 `VariableName` 节点，收集文档中所有 `--*` 声明）
- ✅ 支持 `var(--` 内部补全（`getVariableProposalsForCSSVarFunction`）
- ✅ 纯 ESM，无 workers，无 WASM，Vite+WebView2 完美兼容
- ✅ 实时预览简单（`EditorView.updateListener` 主线程回调，无 worker 往返）
- ✅ TypeScript 完全支持（.d.ts 完备）
- ✅ 移动端友好（Polaris 有移动端）
- ❌ Monaco 2MB+ 过重，且主要为 VS Code 设计
- ⚠️ 无内置 CSS 诊断（Lezer 解析器标记语法错误，但不产生"未知属性"等语义诊断）；如需可加自定义 `@codemirror/lint` linter（+22KB gzip）

**编辑器功能：**
- CSS 语法高亮
- 主题变量补全（输入 `--c-` 提示 40 个颜色变量 + 12 沉浸 + 10 圆角等）
- 实时预览（输入即应用，防抖 300ms）
- 错误标红（基础语法检查）
- "应用 !important" 开关
- "重置" 按钮（清空 customCss）

### 风险清单（R8 特定）

| 风险 | 缓解 |
|------|------|
| 用户 CSS 破坏布局 | "禁用自定义 CSS" 开关 + 安全模式重置 |
| CSP 收紧影响现有功能 | 收紧前全功能回归测试 |
| CSS 注入性能（大段CSS） | 防抖 + requestAnimationFrame |
| 变量补全不全 | 维护变量名常量表，随 ThemeDefinition 同步 |

---

## R10：最终方案定稿（2026-08-04）

### 10 轮研究总结

| 轮次 | 核心产出 |
|------|---------|
| R1-R2 | 现状审计：67 个 CSS 变量（40 颜色+12 沉浸+1 布局+3 内部+11 聊天），24 字段可持久化 |
| R3 | 行业调研：9 系统对比，Obsidian 纯CSS+Snippet 是"最大自定义"黄金参考 |
| R4 | 既有规划审视：发现 6 类硬编码未变量化（圆角60+/字体10+/动效15+/过渡20+） |
| R5 | 能力边界：7 层模型 ~88 个可自定义维度（远超当前 ~45） |
| R6 | 技术路径：路径A(CSS变量注入)+路径C(用户CSS) 组合，弃用路径B |
| R7 | 文件格式：`.polaris-theme` schema 定稿，formatVersion+extends+minAppVersion |
| R8 | 用户CSS机制：独立style标签+CodeMirror编辑器+CSP双层防护 |
| R9 | 风险验证：10 风险+8 不变量+6 迁移场景+性能预算 |

### 最终方案：分层渐进式自定义主题系统

#### 核心架构

```
┌──────────────────────────────────────────────────────────────┐
│              ThemeDefinition（7 层数据模型）                  │
├──────────────────────────────────────────────────────────────┤
│  L0 colors (40 变量) ......... RGB 三元组，Tailwind 消费    │
│  L1 typography (12 变量) ...... fontSans/fontMono/size/weight│
│  L2 shape (10 变量) ........... radius-sm/md/lg/xl/full 派生 │
│  L3 motion (8 变量，P1) ...... transition-fast/normal/ease   │
│  L4 immersive (12 变量) ...... 壁纸/透明度/磨砂/蛛网/光晕    │
│  L5 layout (5 变量) ........... windowOpacity/chat间距       │
│  L6 customCss (1 字段) ........ 用户自定义CSS，终极逃生舱    │
│  合计：~88 个可自定义维度                                     │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              themeEngine（路径A + 路径C 引擎）                │
├──────────────────────────────────────────────────────────────┤
│  loadTheme(id) → 深合并到 DARK_THEME → flattenToCSSVars     │
│  injectCSSVars(~88 vars) → document.documentElement.style   │
│  applyCustomCss(cssText) → <style id="theme-custom-css">    │
│  setDataAttr(data-theme, data-theme-immersive)              │
│  持久化 activeThemeId → localStorage + config              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              存储（双层）                                     │
├──────────────────────────────────────────────────────────────┤
│  localStorage: activeThemeId + themeListCache（首屏快读）   │
│  DataRoot/themes/: index.json + {id}.json（主存储）         │
│  BUILT_IN_THEMES: 代码内常量（dark/light/spiderman）        │
└──────────────────────────────────────────────────────────────┘
```

#### 关键设计决策

| 编号 | 决策 | 选择 | 理由 |
|------|------|------|------|
| D1 | 注入技术 | 路径A style.setProperty + 路径C 独立style标签 | 与现有架构兼容，性能最佳，Obsidian验证 |
| D2 | 颜色编码 | RGB 三元组（"59 130 246"） | 与 Tailwind `rgb(var() / <alpha>)` 兼容 |
| D3 | 文件格式 | `.polaris-theme` JSON + formatVersion | 借鉴 M3+Obsidian，可分享可版本控制 |
| D4 | 主题继承 | 支持 `extends`（可选），导出拍平 | 借鉴 VS Code include + JetBrains parentScheme |
| D5 | 用户CSS | 独立 `<style>` textContent 替换 | 最简最稳，Obsidian 同款 |
| D6 | 安全 | CSP 收紧 + 应用层 CSS 校验 | 双层防护，防外部资源泄露 |
| D7 | 编辑器 | CodeMirror 6 轻量版 | 60KB，移动端友好，支持变量补全 |
| D8 | FOUC | main.tsx 内联 IIFE 同步注入 | 与当前 spiderman 模式一致，0 帧闪烁 |
| D9 | 回退链 | 用户主题→深合并DARK→CSS var() fallback | 三层保障，即使JS失败仍可读 |
| D10 | 兼容性 | 保留旧 theme/spidermanTheme 字段读取 | 自动迁移，不破坏现有用户配置 |

#### 实施路线（5 Phase，~17 人日）

**Phase 0：数据模型 + 存储（2.5 天）**
- 新建 `src/types/theme.ts` — ThemeDefinition 7 层完整类型
- 新建 `src/data/builtInThemes.ts` — 三个内置主题完整常量
- 新建 `src/services/themeService.ts` — DataRoot/themes/ 持久化
- 重写 `src/stores/themeStore.ts` — 多主题 CRUD Store
- 修改 `src/types/config.ts` + `config.rs` — 添加 activeThemeId
- 验证：类型定义完整 + CRUD + 旧配置迁移

**Phase 1：加载引擎 + CSS 通用化（3.5 天）**
- 新建 `src/services/themeEngine.ts` — 扁平化+注入+回退链
- 新建 `src/services/themeMerger.ts` — 深合并
- 修改 `src/main.tsx` — 首屏调用 themeEngine
- 修改 `src/index.css` — 移除 light/spiderman 块，保留 :root 回退
- 修改 `src/App.css` — `[data-theme="spiderman"]` → `[data-theme-immersive="true"]`，`--spiderman-*` → `--theme-*`
- 删除 `src/utils/spiderman-theme.ts` — 合并到 themeEngine
- 修改 14 个组件 — `data-spiderman-panel` → `data-theme-panel`
- 验证：三主题视觉一致 + 首屏无FOUC + cargo check + tsc

**Phase 2：用户 CSS 注入（2 天）**
- themeEngine 增加 applyCustomCss
- 修改 `src-tauri/tauri.conf.json` — CSP 收紧
- 新建 `src/utils/cssValidator.ts` — 应用层校验
- 验证：CSP 拦截外部资源 + 安全模式重置

**Phase 3：管理 UI + 编辑器（4 天）**
- 新建 `src/components/Theme/ThemeManager.tsx` — 卡片列表（方案B风格）
- 新建 `src/components/Theme/ThemeEditor.tsx` — 编辑主框架
- 新建 `src/components/Theme/ColorPicker.tsx` — react-colorful
- 新建 `src/components/Theme/ImmersiveEditor.tsx` — 沉浸编辑
- 新建 `src/components/Theme/ThemePreview.tsx` — 实时预览
- 新建 `src/components/Theme/CssEditor.tsx` — CodeMirror CSS 编辑器
- 导入/导出 `.polaris-theme` 文件
- 验证：CRUD + 导入导出 + 实时预览

**Phase 4：硬编码收敛（3 天）**
- 修改 `src/index.css` + `tailwind.config.js` — 新增 `--radius-*` 派生尺度
- 全局替换 60+ 处 `border-radius: Npx` → `border-radius: var(--radius-*)`
- 收敛 10+ 处 `font-family` 硬编码 → `var(--font-sans/mono)`
- 修改 `src/utils/mermaid-config.ts` — 从 CSS 变量读取
- 修改 `src/components/Terminal/TerminalPanel.tsx` — 从 CSS 变量读取
- 修复 `src/App.css` Thinking Orb — 消费 `--orb-*` 变量
- 验证：`grep border-radius` 零硬编码残留 + 视觉回归

**Phase 5（可选）：种子色调色板（2 天）**
- 新建 `src/services/colorGenerator.ts` — HSL 旋转生成 50-700 色阶
- 编辑器增加"从种子色生成"按钮
- 验证：种子色→完整调色板一致性

#### ThemeDefinition 最终完整定义（R5 升级版）

```typescript
interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description?: string;
  author?: string;
  version: number;
  builtIn: boolean;
  extends?: ThemeId | null;      // R7: 主题继承
  minAppVersion?: string;         // R7: 兼容门控
  createdAt: string;
  updatedAt: string;

  // L0 颜色层（40 变量）
  colors: { primary, background, border, text, status, priority, accent, misc };

  // L1 排版层（12 变量，新增）
  typography: {
    fontSans: string; fontMono: string;
    fontSizeBase: string;
    fontWeightNormal: string; fontWeightMedium: string; fontWeightSemibold: string;
    letterSpacing: string;
    chatFontSize: number; chatLineHeight: number; chatCodeFontSize: number; chatInputFontSize: number;
  };

  // L2 形状层（10 变量，新增）
  shape: {
    radiusSm: string; radiusMd: string; radiusLg: string; radiusXl: string; radiusFull: string;
    chatBubbleRadius: string;
    borderWidth: string; borderStyle: string;
    chatBubblePaddingX: string; chatBubblePaddingY: string;
  };

  // L3 动效层（8 变量，P1 可选）
  motion?: {
    transitionFast: string; transitionNormal: string; transitionSlow: string;
    easeDefault: string; easeIn: string; easeOut: string; easeInOut: string;
    motionReduce: boolean;
  };

  // L4 沉浸层（12 变量）
  immersive?: {
    enabled: boolean;
    wallpaper: { type, image?, gradient?, solidColor?, opacity, positionX, positionY, size };
    layerOpacity: { panel, surface, child };
    effects: { panelBlur, webTexture, blueAccent, hoverOpacity };
    avatar?: { url };
  };

  // L5 布局层（5 变量）
  layout: {
    windowOpacity: { normal, compact };
    chatMessageGap: number; chatBlockGap: number; chatParagraphSpacing: number;
  };

  // L6 用户 CSS 层（1 字段，终极逃生舱）
  customCss?: string;
}
```

#### 最终选定：实施 Phase 0-4

**不实施 Phase 5（种子色调色板）** — 留作远期可选。

理由：
- Phase 0-4 已覆盖"最大自定义"的核心需求（~88 维度 + 用户CSS逃生舱）
- 种子色调色板是"懒人模式"，非"最大自定义"的必要组成
- 优先保证 Phase 4 硬编码收敛（L2 圆角 60+ 处）— 这是当前最大的自定义缺口

#### 与方案B原型UI的关系

方案B（卡片沉浸型）作为 UI 风格参考：
- ThemeManager 用卡片网格展示主题列表
- ThemeEditor 用全屏模态编辑
- 颜色用色板编辑
- 沉浸效果用滑块
- customCss 用 CodeMirror 编辑器（新增）

但**核心是自定义能力深度，非 UI 面板**。UI 可以简化，能力不能缩水。

---

## 研究结论

经过 10 轮研究（R1-R10），最终方案为：

1. **7 层 ThemeDefinition 数据模型**，覆盖 ~88 个可自定义维度（远超当前 ~45）
2. **路径A（CSS变量注入）+ 路径C（用户CSS）组合引擎**
3. **`.polaris-theme` JSON 文件格式**，支持继承、版本迁移、导入导出
4. **CSP 收紧 + 应用层校验**双层安全防护
5. **CodeMirror 6** 轻量 CSS 编辑器
6. **5 Phase 实施，~17 人日**（Phase 0-4 必做，Phase 5 可选）

此方案真正实现"用户最大程度自定义所有内容"：从 40 个颜色到 60+ 处圆角到任意 CSS 覆盖，从三主题硬编码到无限自定义主题，从不可分享到 `.polaris-theme` 文件分发。


