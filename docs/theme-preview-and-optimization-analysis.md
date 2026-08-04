# 主题系统预览缺失与优化项分析

> 状态：分析文档 v1（2026-08-04）
> 范围：预览能力补全 + 编辑器能力扩展 + 字体/排版/形状独立设置
> 基于实际代码审计，非推测

---

## 一、预览缺失分析

### 1.1 当前预览机制现状

| 位置 | 现状 | 问题 |
|------|------|------|
| **ThemeManager 卡片** | 仅有渐变色条 + 三个圆点 | 只能看到背景渐变和三个色值，无法判断整体视觉效果 |
| **ThemeEditor 编辑中** | `useEffect` 调用 `applyThemeSync(draft.id)` 把变量注入到整个 document | 改颜色时整个设置页背景实时变化，但**编辑器模态框本身也跟着变**，用户无法对比"改前 vs 改后" |
| **颜色色块** | 显示当前色值 `rgb(${value})` | 只能看到单色，看不到该色在真实 UI 中的效果 |
| **沉浸效果** | 无预览 | 改壁纸/透明度/磨砂时完全看不到效果，因为编辑器模态框是 `bg-surface` 不透明的 |
| **排版/形状** | 无预览 | 字号、行高、圆角改动无任何可视反馈 |

### 1.2 核心问题：编辑器即预览 = 无预览

当前 ThemeEditor 的"实时预览"实现是：

```tsx
React.useEffect(() => {
  applyThemeSync(draft.id);  // 把 draft 注入到整个 document
}, [draft]);
```

这会导致：
1. **整个应用跟着变** — 用户改 primary 颜色，设置页、侧栏、聊天区全部变色，但编辑器模态框本身也变色，用户看到的是"已应用"状态而非"对比预览"
2. **取消不回滚** — 点击"取消"时 draft 被丢弃，但 document 上的 CSS 变量不会自动恢复到保存前的状态
3. **沉浸效果不可见** — 编辑器模态框使用 `bg-surface`（不透明），壁纸、面板透明、磨砂效果全部被遮挡
4. **无组件级预览** — 用户改 `--c-status-warning` 时，看不到任何 warning 色块的实际效果

### 1.3 预览方案设计

需要三种预览模式，覆盖不同场景：

#### 模式 A：微缩组件预览面板（ThemePreview 组件）

在编辑器底部或侧边放置一个**固定的微缩 UI 样张**，包含：

```
+-------------------------------------------+
| 预览                                       |
+-------------------------------------------+
| [侧栏]  [主内容区]                         |
|  Item1   你好，我是 Polaris               |
|  Item2   > 这是一条 AI 回复                |
|  Item3   > 代码块：const x = 1;           |
|          [输入框.....................]    |
+-------------------------------------------+
| [按钮] [标签] [警告条] [成功提示]          |
+-------------------------------------------+
```

- 微缩组件使用**当前 draft 的 CSS 变量**（通过 inline style 或独立容器 + class 隔离）
- 每次 draft 变化时，微缩预览实时更新
- 微缩预览**不依赖 document 级变量注入**，而是在容器内独立设置变量
- 沉浸效果预览：微缩容器内显示壁纸 + 半透明面板

**技术实现**：使用 CSS 变量的作用域特性，在预览容器上设置 `style` 属性注入局部变量，子元素通过 `var()` 消费：

```tsx
<div className="preview-container" style={flattenToCSSVars(draft)}>
  {/* 子元素使用 bg-background-base 等 Tailwind 类，但变量来自容器 */}
</div>
```

但注意：Tailwind 的 `bg-background-base` 编译为 `rgb(var(--c-bg-base) / ...)`，CSS 变量是全局的，无法通过容器隔离。因此微缩预览有两种技术路径：

- **路径 1**：预览容器内用 inline style 手写所有颜色（不走 Tailwind），保证隔离
- **路径 2**：预览容器使用独立的变量命名空间（如 `--preview-c-primary`），子元素用 `var(--preview-c-primary)` 引用

推荐路径 2，因为可以复用 Tailwind 的类结构，只需在预览容器上注入 `--preview-*` 变量映射。

#### 模式 B：全屏实时预览（改进现有机制）

保留现有的"编辑时全应用变化"机制，但做两个改进：

1. **对比模式** — 编辑器最小化时，用户可以看到完整应用的变化；取消时自动回滚到 `initialTheme`
2. **取消回滚** — 在 `onClose` 时调用 `applyThemeSync(originalThemeId)` 恢复

```tsx
const handleClose = () => {
  applyThemeSync(initialTheme.id); // 回滚到编辑前的主题
  onClose();
};
```

#### 模式 C：色值用途标注

在颜色编辑网格中，每个色块旁边标注**该变量在 UI 中的实际用途**：

| 色块 | 当前标注 | 应增加的用途说明 |
|------|---------|----------------|
| primary.base | "base" | "主色 — 按钮、链接、选中态" |
| primary.hover | "hover" | "主色悬停 — 按钮按下" |
| background.base | "base" | "最底层背景" |
| background.elevated | "elevated" | "面板背景 — 侧栏、顶栏" |
| background.surface | "surface" | "内容卡片背景" |
| text.primary | "primary" | "正文文字" |
| text.muted | "muted" | "最弱文字 — 占位符、时间戳" |
| status.warning | "warning" | "警告 — 黄色提示条" |

让用户知道改这个色会影响什么。

### 1.4 预览方案优先级

| 方案 | 工作量 | 用户体验提升 | 优先级 |
|------|:------:|:----------:|:------:|
| 模式 B：取消回滚 + 对比 | 0.5 天 | 高 | P0 |
| 模式 A：微缩组件预览 | 2 天 | 极高 | P0 |
| 模式 C：色值用途标注 | 0.5 天 | 中 | P1 |

---

## 二、编辑器能力缺失分析

### 2.1 ThemeDefinition 已定义但编辑器未支持的层

| 层 | 已定义字段 | 编辑器是否支持 | 注入引擎是否支持 |
|----|----------|:----------:|:----------:|
| L0 colors | 40 个颜色变量 | 是 | 是 |
| L1 typography | 12 个排版变量 | **否** | 是 |
| L2 shape | 10 个形状变量 | **否** | 是 |
| L3 motion | 8 个动效变量 | **否** | 是 |
| L4 immersive | 12 个沉浸变量 | 是 | 是 |
| L5 layout | 5 个布局变量 | **否** | 是 |
| L6 customCss | 1 个 CSS 字段 | **否** | 是（applyCustomCss 已实现） |

**结论**：ThemeDefinition 定义了 7 层 ~88 个维度，但编辑器只支持 L0（颜色）和 L4（沉浸），**L1/L2/L3/L5/L6 全部缺失**。

### 2.2 各层缺失详情

#### L1 排版层（typography）— 缺失

已定义字段：
- `fontSans` — 全局无衬线字体
- `fontMono` — 全局等宽字体
- `fontSizeBase` — 基础字号
- `fontWeightNormal/Medium/Semibold` — 字重
- `letterSpacing` — 字间距
- `chatFontSize` — 聊天正文字号
- `chatLineHeight` — 聊天行高
- `chatCodeFontSize` — 代码字号
- `chatInputFontSize` — 输入框字号

编辑器需要增加：
- 字体族选择器（system / serif / mono / 自定义输入）
- 字号滑块（12-20px）
- 行高滑块（1.35-1.80）
- 代码字号滑块（11-18px）
- 字重选择器（normal/medium/semibold，下拉或分段按钮）
- 字间距输入

**与现有 ChatDisplaySettings 的关系**：
- 当前 `config.chatDisplay` 有独立的 fontSize/lineHeight/fontFamily 等
- 主题的 typography 层应**替代** config.chatDisplay，统一管理
- 迁移策略：读取时 `config.chatDisplay` 覆盖到主题的 typography，写入时移除 config.chatDisplay

#### L2 形状层（shape）— 缺失

已定义字段：
- `radiusSm/Md/Lg/Xl/Full` — 圆角尺度（5 个）
- `chatBubbleRadius` — 聊天气泡圆角
- `borderWidth` — 边框宽度
- `borderStyle` — 边框样式
- `chatBubblePaddingX/Y` — 气泡内边距

编辑器需要增加：
- 圆角尺度滑块组（sm/md/lg/xl 联动派生，改一个自动派生其他）
- 气泡圆角独立滑块
- 边框宽度输入
- 气泡内边距滑块

**派生尺度设计**（借鉴 shadcn/ui）：
```
用户设置 --radius-md = 8px
自动派生：
  --radius-sm = calc(var(--radius-md) - 4px) = 4px
  --radius-lg = calc(var(--radius-md) + 4px) = 12px
  --radius-xl = calc(var(--radius-md) + 8px) = 16px
```

用户只调一个 `--radius-md`，整套圆角尺度自动更新。

#### L3 动效层（motion）— 缺失

已定义字段：
- `transitionFast/Normal/Slow` — 过渡时长
- `easeDefault/In/Out/InOut` — 缓动函数
- `motionReduce` — 是否减弱动画

编辑器需要增加：
- 过渡时长输入（0.1s - 0.5s）
- 缓动函数下拉（ease / ease-in / ease-out / ease-in-out / linear / cubic-bezier）
- 减弱动画开关

**优先级**：P2，动效对主题视觉影响较小，用户感知弱。

#### L5 布局层（layout）— 缺失

已定义字段：
- `windowOpacity.normal/compact` — 窗口透明度
- `chatMessageGap` — 消息间距
- `chatBlockGap` — 块间距
- `chatParagraphSpacing` — 段落间距

编辑器需要增加：
- 窗口透明度滑块（已有在 ThemeTab 中，应迁入编辑器）
- 消息间距滑块
- 段落间距滑块

**与现有 ThemeTab 的关系**：
- ThemeTab 底部有"对话显示"和"窗口透明度"区块
- 这些应迁移到主题编辑器内，作为 L5 布局层的一部分
- ThemeTab 简化为：ThemeManager（主题列表）+ 全局快捷设置

#### L6 自定义 CSS 层 — 缺失

`applyCustomCss()` 已实现，但编辑器无入口。

编辑器需要增加：
- CodeMirror CSS 编辑器组件（已在 R10 选型，146KB gzip）
- 实时预览（输入即应用，防抖 300ms）
- 安全校验提示（调用 `validateCustomCss`）
- "应用 !important" 开关
- "重置" 按钮

**优先级**：P0，这是"最大自定义"的核心逃生舱。

### 2.3 编辑器缺失汇总

| 缺失项 | 优先级 | 工作量 | 说明 |
|--------|:------:|:------:|------|
| L6 自定义 CSS 编辑器 | P0 | 1.5 天 | 核心逃生舱，R8 已设计 |
| L1 排版编辑 | P0 | 1 天 | 字体/字号/行高，用户高频需求 |
| L5 布局编辑 | P1 | 0.5 天 | 迁移现有 ThemeTab 的滑块 |
| L2 形状编辑 | P1 | 1 天 | 圆角派生尺度，shadcn 模式 |
| L3 动效编辑 | P2 | 0.5 天 | 感知弱，可选 |
| 色值用途标注 | P1 | 0.5 天 | 改善颜色编辑体验 |
| 取消回滚 | P0 | 0.3 天 | 防止取消后不恢复 |

---

## 三、字体独立设置深度分析

### 3.1 当前字体配置现状

| 配置位置 | 字段 | 作用域 | 持久化 |
|---------|------|--------|:------:|
| `config.chatDisplay.fontFamily` | system/serif/mono 三选一 | 聊天区域 | 是 |
| `config.chatDisplay.fontSize` | 12-20px | 聊天正文 | 是 |
| `config.chatDisplay.codeFontSize` | 11-18px | 代码块 | 是 |
| `config.chatDisplay.inputFontSize` | 跟随正文或独立 | 输入框 | 是 |
| `body` CSS | 硬编码 `-apple-system, ...` | 全局 UI | 否 |
| 代码高亮 CSS | 硬编码 `'SF Mono', ...` | 代码块 | 否 |

**问题**：
- 全局 UI 字体（侧栏、顶栏、按钮）硬编码在 `body` 中，无法自定义
- 代码字体硬编码在 6 处 CSS 规则中
- 聊天字体只支持 system/serif/mono 三选一，不能自定义字体族
- 字体配置分散在 config 和 CSS 中，不统一

### 3.2 字体主题化方案

#### 方案：将字体配置纳入 ThemeDefinition.typography

**新增/调整字段**：

```typescript
interface ThemeTypography {
  // 全局字体
  fontSans: string;          // 全局 UI 字体（替代 body 硬编码）
  fontMono: string;          // 全局等宽字体（替代 6 处硬编码）
  
  // 基础排版
  fontSizeBase: string;      // 全局基础字号（14px）
  fontWeightNormal: string;  // 400
  fontWeightMedium: string;  // 500
  fontWeightSemibold: string;// 600
  letterSpacing: string;     // normal / 0.01em 等
  
  // 聊天排版（替代 config.chatDisplay）
  chatFontFamily: string;    // 聊天字体族（可独立于全局）
  chatFontSize: number;      // 聊天正文字号
  chatLineHeight: number;    // 聊天行高
  chatCodeFontSize: number;  // 代码字号
  chatInputFontSize: number; // 输入框字号
}
```

**编辑器 UI 设计**：

```
+-------------------------------------------+
| 排版                                       |
+-------------------------------------------+
| 全局字体                                   |
|   无衬线: [system-sans    ] [选择] [自定义]|
|   等宽:   [JetBrains Mono ] [选择] [自定义]|
|   基础字号: [14] px                         |
|   字重:    [400] [500] [600]               |
|   字间距:  [normal      ]                   |
+-------------------------------------------+
| 聊天字体                                   |
|   字体族:  [跟随全局 v]                     |
|   正文字号: [14] px                         |
|   行高:    [1.55]                           |
|   代码字号: [13] px                         |
|   输入字号: [跟随正文 v]                     |
+-------------------------------------------+
| 预览                                       |
|  The quick brown fox jumps over the lazy dog|
| ABCDEFGHIJKLMNOPQRSTUVWXYZ                |
|  abcdefghijklmnopqrstuvwxyz                |
|  0123456789                               |
|  const example = "代码预览";                |
+-------------------------------------------+
```

**字体选择器**：
- 预设字体下拉：system-ui / Inter / Roboto / Noto Sans SC / 思源黑体 / 自定义
- 自定义输入框：用户可输入任意 CSS font-family 字符串
- "跟随全局"选项：聊天字体族 = 全局 fontSans

**技术实现**：
1. themeEngine 注入 `--font-sans`、`--font-mono` 到 document
2. `body` 的 `font-family` 改为 `var(--font-sans)`
3. 6 处代码高亮的 `font-family` 改为 `var(--font-mono)`
4. 聊天区域的 `--chat-font-family` 改为从 typography.chatFontFamily 注入

**迁移**：
- `config.chatDisplay` 的字段读取时映射到主题 typography
- 写入时不再写 config.chatDisplay，改写主题 typography

### 3.3 字体预览设计

字体编辑需要**专属预览**，展示不同字号/字重/字体族的实际效果：

```
+-------------------------------------------+
| 字体预览                                   |
+-------------------------------------------+
| Heading 1 — 标题示例 (semibold 24px)       |
| Heading 2 — 标题示例 (semibold 20px)       |
| 正文示例 — The quick brown fox... (14px)   |
| 代码示例 — const x = await fetch(); (13px)|
| 输入示例 — placeholder text...             |
| ABCDEFG 0123456789 !@#$%^&*()              |
| 快速棕狐跳过懒狗（中文测试）                 |
+-------------------------------------------+
```

预览区使用当前 draft 的字体设置，实时反映变化。

---

## 四、其他可优化项

### 4.1 ThemeManager 卡片预览优化

当前卡片预览只是渐变色条 + 三个圆点，应改为**微缩 UI 预览**：

```
+---------------------------+
| [侧栏色块] [主内容色块]     |  <- 模拟应用布局
| [顶栏色块]                  |
|                            |
| ● 圆点 1  ● 圆点 2  ● 圆点 3 |
| Dark                       |
| 内置 · 使用中               |
+---------------------------+
```

使用主题的 colors 绘制微缩布局，让用户一眼看出主题的整体色调。

### 4.2 颜色编辑器交互优化

当前 ColorPicker 只能通过 RGB 滑块调色，应增加：

- **HEX 输入框** — 用户可直接输入 `#3B82F6`
- **色轮选择器** — HSL 色轮，更直观（react-colorful 库，2.9KB）
- **从种子色派生** — 给一个主色，自动生成 50-700 色阶（Material 3 模式）
- **对比度检查** — 实时显示文字与背景的对比度比值（WCAG AA/AAA）

### 4.3 主题继承可视化

ThemeDefinition 有 `extends` 字段，但编辑器未展示继承关系：

- 编辑器头部应显示"继承自：Dark"标签
- 被继承的字段应标记"继承"图标，点击可"覆盖为自定义值"
- 提供"拍平继承"按钮（把所有继承字段固化为当前值）

### 4.4 主题版本与差异对比

- 主题有 `version` 和 `updatedAt`，但无版本历史
- 可增加"查看修改历史"功能（每次保存生成快照）
- 导入时显示与当前主题的差异

### 4.5 ThemeTab 结构优化

当前 ThemeTab 底部有"对话显示"和"窗口透明度"区块，这些应该：
- **迁入主题编辑器**作为 L1/L5 层编辑项
- ThemeTab 简化为：ThemeManager + 全局快捷开关（如"跟随系统暗色模式"）

---

## 五、实施优先级建议

### 第一批（P0，必做，~3 天）

| 项 | 工作量 | 理由 |
|----|:------:|------|
| 取消回滚 | 0.3 天 | 防止取消后主题不恢复，基础体验 |
| 微缩组件预览（ThemePreview） | 2 天 | 让用户看到改动的实际效果 |
| L6 自定义 CSS 编辑器 | 1.5 天 | 核心逃生舱，R8 已设计 |
| L1 排版编辑 | 1 天 | 字体/字号是用户高频需求 |

### 第二批（P1，建议，~2 天）

| 项 | 工作量 | 理由 |
|----|:------:|------|
| L5 布局编辑 | 0.5 天 | 迁移现有 ThemeTab 滑块 |
| L2 形状编辑 | 1 天 | 圆角派生尺度 |
| 色值用途标注 | 0.5 天 | 改善颜色编辑体验 |

### 第三批（P2，可选，~1 天）

| 项 | 工作量 | 理由 |
|----|:------:|------|
| L3 动效编辑 | 0.5 天 | 感知弱 |
| 主题继承可视化 | 0.5 天 | 进阶功能 |
| HEX 输入 + 色轮 | 0.5 天 | 体验优化 |
| 从种子色派生 | 1 天 | Material 3 懒人模式 |

---

## 六、总结

当前主题系统的**数据模型和引擎**已完整支持 7 层 ~88 维度，但**编辑器 UI 只覆盖了 ~52 维度**（L0 颜色 + L4 沉浸），且有三个核心体验缺口：

1. **无有效预览** — 编辑器全屏注入变量导致"编辑器即预览"，用户无法对比改前改后，沉浸效果完全不可见
2. **L1/L2/L5/L6 编辑缺失** — 字体、圆角、布局、自定义 CSS 四个层已定义但无编辑入口
3. **字体配置分散** — 全局字体硬编码在 CSS 中，聊天字体在 config 中，未统一到主题

建议优先补全预览能力（微缩组件 + 取消回滚）和 L6 自定义 CSS 编辑器，这是"最大自定义"承诺的核心交付。字体独立设置作为 L1 排版编辑的一部分，一并补齐。