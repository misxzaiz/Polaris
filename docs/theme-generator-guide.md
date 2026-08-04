# 主题生成指南

> 本文档是 `.polaris-theme` 文件的完整生成规范，可直接复制给 AI 用于生成新主题。

---

## 快速开始

将以下提示词发给 AI，即可生成一个 .polaris-theme 文件：

```text
请根据 Polaris 主题系统的 7 层模型（L0-L6），生成一份 .polaris-theme 主题文件。

主题名称：[填写主题名]
主题描述：[描述主题风格]
主色调：[填写主色，如：蓝色 / 红色 / 紫色]
风格：[暗色 / 浅色 / 自定义]
壁纸：[可选，填入 Unsplash 或任意图片 URL]

请严格按照以下 JSON Schema 生成，确保字段完整、类型正确。
```

---

## 文件格式概览

```jsonc
{
  "formatVersion": 1,           // 格式版本，当前为 1
  "type": "polaris-theme",      // 固定标识
  "exportedAt": "2026-08-04T12:00:00.000Z",  // 导出时间
  "minAppVersion": "1.0.0",     // 最低兼容版本
  "theme": {
    "name": "主题名称",          // 必填，最长 32 字符
    "description": "主题描述",   // 可选
    "author": "作者名",         // 可选
    "version": 1,               // 版本号
    "extends": null,            // 继承基础主题，预留字段

    // ---- 7 层数据模型 ----
    "colors": { /* L0 */ },
    "typography": { /* L1 */ },
    "shape": { /* L2 */ },
    "motion": { /* L3 */ },
    "layout": { /* L4（命名保留，实际是 L5） */ },
    "immersive": { /* L4 沉浸层 */ },
    "customCss": "/* L6 逃生舱 */"
  }
}
```

---

## L0 颜色层（40 个字段，必填）

### 颜色值格式

所有颜色值使用 **RGB 三元组字符串**，三个数字以空格分隔，**不带括号**：

```
"59 130 246"   // 正确 ✅ —— 对应 rgb(59, 130, 246)
"rgb(59,130,246)"  // 错误 ❌
"#3B82F6"         // 错误 ❌
```

### 字段列表

#### primary（9 字段）— 主色调

```json
"primary": {
  "base":  "59 130 246",   // 主色，也是 rgb(--c-primary)
  "hover": "37 99 235",    // 悬停态
  "50":    "239 246 255",  // 最浅 tint
  "100":   "219 234 254",
  "200":   "191 219 254",
  "300":   "147 197 253",
  "400":   "96 165 250",
  "500":   "59 130 246",   // 与 base 一致
  "600":   "37 99 235",    // 与 hover 一致
  "700":   "29 78 216"     // 最深 shade
}
```

> 50→700 提供渐变色阶，用于按钮、标签、高亮等场景。建议从 base 向两端均匀延伸。

#### background（7 字段）— 背景色系

```json
"background": {
  "base":      "0 0 0",       // 最底层背景
  "elevated":  "26 26 31",    // 卡片、面板背景
  "surface":   "37 37 43",    // 控件、输入框背景
  "hover":     "45 45 53",    // 悬停态背景
  "active":    "53 53 61",    // 激活态背景
  "tertiary":  "33 38 45",    // 三级背景（侧边栏等）
  "secondary": "22 27 34"     // 二级背景
}
```

> 暗色主题：base 最黑，逐层变亮。浅色主题：base 最灰白，逐层变深。

#### border（1 字段）— 边框色

```json
"border": { "base": "255 255 255" }
```

> 暗色主题用偏白值（低透明度），浅色主题用偏深值。

#### text（4 字段）— 文字色

```json
"text": {
  "primary":   "248 248 248",  // 主文字
  "secondary": "180 180 184",  // 次要文字
  "tertiary":  "142 142 147",  // 辅助文字
  "muted":     "109 109 112"   // 最淡文字（占位符等）
}
```

#### status（7 字段）— 状态色

```json
"status": {
  "warning": "251 191 36",  // 警告
  "success": "52 211 153",  // 成功
  "danger":  "248 113 113", // 危险
  "info":    "96 165 250",  // 信息
  "done":    "16 185 129",  // 已完成
  "failed":  "239 68 68",   // 已失败
  "neutral": "156 163 175"  // 中性
}
```

#### priority（4 字段）— 优先级色

```json
"priority": {
  "low":    "156 163 175",  // 低优先级
  "normal": "96 165 250",   // 普通
  "high":   "251 146 60",   // 高优先级
  "urgent": "248 113 113"   // 紧急
}
```

#### accent（3 字段）— 强调色

```json
"accent": {
  "ai":         "167 139 250",  // AI 相关
  "prototype":  "34 211 238",   // 原型
  "workspace":  "251 191 36"    // 工作区
}
```

#### misc（5 字段）— 杂项色

```json
"misc": {
  "overlay":   "0 0 0",       // 遮罩层底色
  "onPrimary": "255 255 255", // 主色上的文字色
  "canvas":    "255 255 255", // 画布色
  "tagBg":     "255 255 255", // 标签背景
  "shadow":    "0 0 0"        // 阴影色
}
```

---

## L1 排版层（11 字段，必填）

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `fontSans` | string | 无衬线字体族 | `"-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif"` |
| `fontMono` | string | 等宽字体族 | `"\"JetBrains Mono\", \"Fira Code\", Consolas, monospace"` |
| `fontSizeBase` | string | 基础字号 | `"14px"` |
| `fontWeightNormal` | string | 常规字重 | `"400"` |
| `fontWeightMedium` | string | 中等字重 | `"500"` |
| `fontWeightSemibold` | string | 半粗字重 | `"600"` |
| `letterSpacing` | string | 字间距 | `"normal"` 或 `"0.02em"` |
| `chatFontFamily` | string? | 聊天字体（可选，默认跟随 fontSans） | 同上 |
| `chatFontSize` | number | 聊天字号 | `14` |
| `chatLineHeight` | number | 聊天行高倍率 | `1.55` |
| `chatCodeFontSize` | number | 聊天代码字号 | `13` |
| `chatInputFontSize` | number | 聊天输入框字号 | `14` |

### 默认值

```json
{
  "fontSans": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
  "fontMono": "\"JetBrains Mono\", \"Fira Code\", \"Cascadia Code\", \"SF Mono\", Consolas, monospace",
  "fontSizeBase": "14px",
  "fontWeightNormal": "400",
  "fontWeightMedium": "500",
  "fontWeightSemibold": "600",
  "letterSpacing": "normal",
  "chatFontSize": 14,
  "chatLineHeight": 1.55,
  "chatCodeFontSize": 13,
  "chatInputFontSize": 14
}
```

---

## L2 形状层（10 字段，必填）

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `radiusSm` | string | 小圆角 | `"4px"` |
| `radiusMd` | string | 中圆角 | `"8px"` |
| `radiusLg` | string | 大圆角 | `"12px"` |
| `radiusXl` | string | 超大圆角 | `"16px"` |
| `radiusFull` | string | 全圆角 | `"9999px"` |
| `chatBubbleRadius` | string | 聊天气泡圆角 | `"16px"` |
| `borderWidth` | string | 边框宽度 | `"1px"` |
| `borderStyle` | string | 边框样式 | `"solid"` |
| `chatBubblePaddingX` | string | 气泡水平内边距 | `"16px"` |
| `chatBubblePaddingY` | string | 气泡垂直内边距 | `"12px"` |

### 默认值

```json
{
  "radiusSm": "4px",
  "radiusMd": "8px",
  "radiusLg": "12px",
  "radiusXl": "16px",
  "radiusFull": "9999px",
  "chatBubbleRadius": "16px",
  "borderWidth": "1px",
  "borderStyle": "solid",
  "chatBubblePaddingX": "16px",
  "chatBubblePaddingY": "12px"
}
```

---

## L3 动效层（8 字段，可选，推荐提供）

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `transitionFast` | string | 快速过渡 | `"0.15s"` |
| `transitionNormal` | string | 正常过渡 | `"0.3s"` |
| `transitionSlow` | string | 慢速过渡 | `"0.5s"` |
| `easeDefault` | string | 默认缓动函数 | `"ease"` 或 `"cubic-bezier(0.4, 0, 0.2, 1)"` |
| `easeIn` | string | 缓入 | `"ease-in"` |
| `easeOut` | string | 缓出 | `"ease-out"` |
| `easeInOut` | string | 缓入缓出 | `"ease-in-out"` |
| `motionReduce` | boolean | 是否减少动效 | `false` |

### 默认值

```json
{
  "transitionFast": "0.15s",
  "transitionNormal": "0.3s",
  "transitionSlow": "0.5s",
  "easeDefault": "ease",
  "easeIn": "ease-in",
  "easeOut": "ease-out",
  "easeInOut": "ease-in-out",
  "motionReduce": false
}
```

---

## L4 沉浸层（可选，推荐提供）

### wallpaper — 壁纸

| 字段 | 类型 | 说明 | 可选值 |
|------|------|------|--------|
| `type` | string | 壁纸类型 | `"image"` / `"gradient"` / `"solid"` / `"none"` |
| `image` | string? | 图片 URL | 仅 type=image 时使用 |
| `gradient` | string? | CSS 渐变 | 仅 type=gradient 时使用 |
| `solidColor` | string? | 纯色 RGB | 仅 type=solid 时使用 |
| `opacity` | number | 壁纸不透明度 | `0.0` ~ `1.0` |
| `positionX` | number | 水平偏移 | `0` ~ `100`（百分比） |
| `positionY` | number | 垂直偏移 | `0` ~ `100`（百分比） |
| `size` | string | 背景缩放 | `"cover"` / `"contain"` / 自定义 |

### layerOpacity — 磨砂透明度

| 字段 | 类型 | 说明 |
|------|------|------|
| `panel` | number | 面板层不透明度（`0~1`，越低越透明） |
| `surface` | number | 表面层不透明度 |
| `child` | number | 子元素层不透明度 |

### effects — 效果

| 字段 | 类型 | 说明 |
|------|------|------|
| `panelBlur` | number | 面板模糊半径（px） |
| `webTexture` | number | 纹理强度（`0~1`） |
| `blueAccent` | number | 蓝色调叠加强度（`0~1`） |
| `hoverOpacity` | number | 悬停透明度变化量 |

### avatar — 头像（可选）

```json
"avatar": {
  "url": "https://example.com/avatar.png"
}
```

> 头像 URL 建议使用稳定、可跨域访问的图片 CDN。
> 推荐来源：Unsplash、GitHub 头像、稳定的图标 CDN。

### 沉浸层完整示例

```json
"immersive": {
  "enabled": true,
  "wallpaper": {
    "type": "image",
    "image": "https://images.unsplash.com/photo-xxxxx?q=80&w=1920",
    "opacity": 0.65,
    "positionX": 50,
    "positionY": 50,
    "size": "cover"
  },
  "layerOpacity": {
    "panel": 0.45,
    "surface": 0.35,
    "child": 0.45
  },
  "effects": {
    "panelBlur": 12,
    "webTexture": 0.08,
    "blueAccent": 0.4,
    "hoverOpacity": 0.5
  }
}
```

---

## L5 布局层（4 字段，必填）

| 字段 | 类型 | 说明 |
|------|------|------|
| `windowOpacity.normal` | number | 窗口正常不透明度（`0~100`） |
| `windowOpacity.compact` | number | 窗口紧凑态不透明度（`0~100`） |
| `chatMessageGap` | number | 消息间距（px） |
| `chatBlockGap` | number | 块间距（px） |
| `chatParagraphSpacing` | number | 段落间距（px） |

### 默认值

```json
{
  "windowOpacity": {
    "normal": 100,
    "compact": 100
  },
  "chatMessageGap": 10,
  "chatBlockGap": 6,
  "chatParagraphSpacing": 4
}
```

---

## L6 自定义 CSS（可选，终极逃生舱）

纯文本 CSS 字符串，用于实现标准字段无法覆盖的样式。

```css
/* 示例：霓虹光晕效果 */
input:focus, textarea:focus {
  box-shadow: 0 0 0 2px rgba(0, 217, 255, 0.15) !important;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 217, 255, 0.2) !important;
}
```

> 注意：需要 `!important` 覆盖默认样式。

---

## 设计原则与建议

### 颜色搭配

1. **主色选择**：选择一种主色调，primary 的 50→700 应自然过渡
2. **背景层次**：暗色主题从 base 到 elevated 逐层变亮，层次分明
3. **文字对比度**：primary / secondary / tertiary / muted 之间的亮度差要足够
4. **状态色可识别**：成功用绿色系、危险用红色系、警告用黄色系，保持直觉
5. **AI 强调色**：建议使用紫色系，与主色区分开

### 沉浸效果

1. 壁纸选择**高分辨率**、**色彩不杂乱**的图片
2. `opacity` 建议 `0.4~0.7`，太低看不清、太高喧宾夺主
3. `panelBlur` 建议 `8~16px`，模糊适中
4. `layerOpacity` 面板层建议 `0.4~0.6`，保证内容可读

### 形状调整

1. 圆角越大越现代柔和，但控件圆角不宜超过 `16px`
2. 聊天气泡圆角建议比普通卡片大 `2~4px`

---

## 完整主题示例（最小结构）

```json
{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-04T00:00:00.000Z",
  "theme": {
    "name": "示例主题",
    "description": "这是一个简洁的主题示例",
    "author": "Polaris",
    "version": 1,
    "colors": {
      "primary": {
        "base": "59 130 246", "hover": "37 99 235",
        "50": "239 246 255", "100": "219 234 254", "200": "191 219 254",
        "300": "147 197 253", "400": "96 165 250",
        "500": "59 130 246", "600": "37 99 235", "700": "29 78 216"
      },
      "background": {
        "base": "0 0 0", "elevated": "26 26 31", "surface": "37 37 43",
        "hover": "45 45 53", "active": "53 53 61",
        "tertiary": "33 38 45", "secondary": "22 27 34"
      },
      "border": { "base": "255 255 255" },
      "text": {
        "primary": "248 248 248", "secondary": "180 180 184",
        "tertiary": "142 142 147", "muted": "109 109 112"
      },
      "status": {
        "warning": "251 191 36", "success": "52 211 153",
        "danger": "248 113 113", "info": "96 165 250",
        "done": "16 185 129", "failed": "239 68 68", "neutral": "156 163 175"
      },
      "priority": {
        "low": "156 163 175", "normal": "96 165 250",
        "high": "251 146 60", "urgent": "248 113 113"
      },
      "accent": {
        "ai": "167 139 250", "prototype": "34 211 238", "workspace": "251 191 36"
      },
      "misc": {
        "overlay": "0 0 0", "onPrimary": "255 255 255",
        "canvas": "255 255 255", "tagBg": "255 255 255", "shadow": "0 0 0"
      }
    },
    "typography": {
      "fontSans": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
      "fontMono": "\"JetBrains Mono\", \"Fira Code\", Consolas, monospace",
      "fontSizeBase": "14px",
      "fontWeightNormal": "400",
      "fontWeightMedium": "500",
      "fontWeightSemibold": "600",
      "letterSpacing": "normal",
      "chatFontSize": 14, "chatLineHeight": 1.55,
      "chatCodeFontSize": 13, "chatInputFontSize": 14
    },
    "shape": {
      "radiusSm": "4px", "radiusMd": "8px", "radiusLg": "12px",
      "radiusXl": "16px", "radiusFull": "9999px",
      "chatBubbleRadius": "16px", "borderWidth": "1px",
      "borderStyle": "solid", "chatBubblePaddingX": "16px",
      "chatBubblePaddingY": "12px"
    },
    "layout": {
      "windowOpacity": { "normal": 100, "compact": 100 },
      "chatMessageGap": 10, "chatBlockGap": 6, "chatParagraphSpacing": 4
    }
  }
}
```

---

## AI 生成模板

可直接复制以下提示词发给 AI：

```text
请根据以下规范生成一份 .polaris-theme 主题文件，输出为纯 JSON（不要用代码块包裹）。

【主题信息】
- 名称：[主题名]
- 描述：[风格描述]
- 作者：[作者]

【配色要求】
- 整体风格：暗色 / 浅色 / 自定义
- 主色调：[颜色]
- 背景色倾向：[冷/暖/中性]
- 文字：高对比度 / 柔和

【可选要求】
- 壁纸：[描述想要的壁纸，AI 会选择合适的 Unsplash 图片]
- 圆角风格：锐利 / 标准 / 圆润
- 字体：有特殊字体要求吗？
- 自定义 CSS：需要额外效果吗？

【格式要求】
- 所有颜色值使用 RGB 三元组字符串格式："R G B"（如 "59 130 246"）
- 字段必须完整，尤其是 colors 层的 40 个字段
- JSON 语法必须合法，不能有尾随逗号
- 输出纯 JSON，不要用 markdown 代码块包裹
```

---

## 常见错误

| 错误 | 示例 | 正确 |
|------|------|------|
| 颜色值带括号 | `"rgb(59, 130, 246)"` | `"59 130 246"` |
| 颜色值带 # | `"#3B82F6"` | `"59 130 246"` |
| 缺少字段 | 缺少 `background.secondary` | 补全 40 个颜色字段 |
| 尾随逗号 | `"base": "0 0 0",}` | 去掉最后一个字段后的逗号 |
| 类型错误 | `chatFontSize: "14"` | `chatFontSize: 14`（数字） |
| avatar 链接不稳定 | flaticon 等第三方 CDN | 使用 Unsplash 或 GitHub 等稳定源 |