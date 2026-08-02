# Spider-Man 主题蓝调增强 PRD

> **版本**: v1.0  
> **状态**: 待评审  
> **基于项目分析**: `spiderman-blue-accent-analysis.md`  
> **修改文件数**: 6  
> **预估工时**: 30 分钟

---

## 1. 目标

在保持红色主导的前提下，通过调整 CSS 变量赋值 + 新增装饰层样式，让蓝色在 Spider-Man 主题中从「几乎不可见」变为「清晰可见」，形成红蓝黑三色平衡。

**不修改任何组件逻辑**，只改 CSS 变量值和样式。

---

## 2. CSS 变量调整（`src/index.css`）

### 2.1 背景去蓝化（纯黑背景）

```css
/* 当前（蓝染黑）       →   目标（纯黑/中性黑） */
--c-bg-base: 5 5 15;      →   0 0 0      /* 纯黑 #000 */
--c-bg-elevated: 11 11 24; →   8 8 10    /* 近黑，微暖 */
--c-bg-surface: 17 17 34;  →   14 14 18  /* 近黑，中性 */
--c-bg-hover: 22 22 40;    →   20 20 24  /* 深灰 */
--c-bg-active: 28 28 48;   →   26 26 30  /* 深灰 */
```

### 2.2 蓝色注入关键变量（3 个变量改蓝）

| 变量 | 当前值 | 目标值 | 影响组件 |
|------|--------|--------|---------|
| `--c-accent-ai` | `220 38 38` 🟥 | **`59 130 246`** 🔵 | ConnectingOverlay 旋转环、进度条、TopMenuBar、需求面板 AI 标记 |
| `--c-status-info` | `220 38 38` 🟥 | **`59 130 246`** 🔵 | 需求面板状态标签、Todo 标签、Git 历史标记 |
| `--c-priority-normal` | `220 38 38` 🟥 | **`59 130 246`** 🔵 | Todo 优先级图标、需求优先级标记 |

**为什么是这 3 个变量？**
- 它们在 Dark 主题中本来就是蓝色/紫色，用户已有「蓝色 = 信息/AI」的心智模型
- 改成红色后语义混乱（信息 = 红？正常优先级 = 红？）
- 改回蓝色不仅增加蓝色占比，还恢复语义正确性

### 2.3 新增 CSS 变量

```css
:root[data-theme="spiderman"] {
  /* 蓝色强调强度 (0-1)，由设置面板滑块控制，JS 动态覆盖 */
  --spiderman-blue-accent: 0.5;
}
```

---

## 3. 装饰层增强（`src/App.css`）

### 3.1 环境光晕 — 蓝色提升到 15%

```css
/* 当前 */
[data-theme="spiderman"] .theme-ambient {
  background:
    radial-gradient(ellipse at 15% 50%, rgba(220,38,38,0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 30%, rgba(59,130,246,0.06) 0%, transparent 50%);
}

/* 改为 */
[data-theme="spiderman"] .theme-ambient {
  background:
    radial-gradient(ellipse at 15% 50%, rgba(220,38,38,0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 30%, rgba(59,130,246,0.15) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 100%, rgba(59,130,246,0.05) 0%, transparent 40%);
}
```

### 3.2 蛛网纹理 — 加入蓝色线条

```css
[data-theme="spiderman"] .theme-web-texture {
  /* 保留原有红色线条 */
  background-image:
    repeating-linear-gradient(0deg, transparent, transparent 60px, rgba(220,38,38,0.04) 60px, rgba(220,38,38,0.04) 61px),
    repeating-linear-gradient(90deg, transparent, transparent 60px, rgba(220,38,38,0.04) 60px, rgba(220,38,38,0.04) 61px),
    /* 新增：蓝色对角线 */
    repeating-linear-gradient(45deg, transparent, transparent 85px, rgba(59,130,246,0.03) 85px, rgba(59,130,246,0.03) 86px),
    repeating-linear-gradient(-45deg, transparent, transparent 85px, rgba(59,130,246,0.02) 85px, rgba(59,130,246,0.02) 86px);
}
```

### 3.3 滚动条蓝色主题

```css
[data-theme="spiderman"] ::-webkit-scrollbar-thumb {
  background: rgba(59, 130, 246, 0.3);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: content-box;
}
[data-theme="spiderman"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(59, 130, 246, 0.5);
  background-clip: content-box;
}
```

### 3.4 输入框聚焦蓝色发光

```css
[data-theme="spiderman"] .input-textarea:focus {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  border-color: rgba(59, 130, 246, 0.5) !important;
}
```

### 3.5 AI 头像蓝色光晕

```css
[data-theme="spiderman"] .assistant-avatar {
  box-shadow: 0 0 12px rgba(59, 130, 246, 0.3);
}
```

### 3.6 圆角输入框聚焦

```css
[data-theme="spiderman"] .chat-input-root:focus-within {
  border-color: rgba(59, 130, 246, 0.3) !important;
}
```

---

## 4. 类型与配置（`src/types/config.ts`）

```typescript
/** Spider-Man 主题配置 */
export interface SpiderManThemeConfig {
  // ... 现有字段
  /** 蓝色强调强度 (0-1)，0=无蓝色，1=最大蓝色 */
  blueAccent?: number;
}

/** 默认值 */
export const DEFAULT_SPIDERMAN_THEME: SpiderManThemeConfig = {
  // ... 现有默认值
  blueAccent: 0.5,
};
```

---

## 5. CSS 变量同步（`src/utils/spiderman-theme.ts`）

在 `syncSpiderManCssVarsToDom` 中新增：

```typescript
// 蓝色强调强度
document.documentElement.style.setProperty(
  '--spiderman-blue-accent',
  String((cfg.blueAccent as number) ?? 0.5)
);
```

---

## 6. 设置面板 UI（`src/components/Settings/tabs/ThemeTab.tsx`）

在 SpiderManSection 的「视觉效果」区域新增滑块：

```
🎨 视觉效果
├── 背景透明度   [====o====] 20%
├── 面板透明度   [====o====] 55%
├── 面板磨砂     [====o====] 8px
├── 🔵 蓝色强调  [====o====] 50%  ← 新增（在 webOpacity 之前）
├── 蛛网纹理     [====o====] 15%
```

滑块值控制：
- 0%：蓝色元素几乎消失（`--spiderman-blue-accent: 0`）
- 50%：默认平衡（`--spiderman-blue-accent: 0.5`）
- 100%：蓝色最大化（`--spiderman-blue-accent: 1`）

JS 动态控制：
- `--c-accent-ai` 透明度 = `0.3 + blueAccent * 0.7`
- 环境光晕蓝透明度 = `0.05 + blueAccent * 0.15`
- 滚动条蓝透明度 = `0.1 + blueAccent * 0.3`
- 聚焦蓝透明度 = `0.1 + blueAccent * 0.3`
- AI 头像光晕强度 = `blueAccent * 12px`

---

## 7. i18n（`src/locales/*/settings.json`）

```json
// zh-CN
"blueAccent": "蓝色强调",
"blueAccentHint": "调节界面中蓝色元素的强度，0=无蓝色，100=最大蓝色",

// en-US
"blueAccent": "Blue Accent",
"blueAccentHint": "Adjust the intensity of blue elements. 0=no blue, 100=maximum blue",
```

---

## 8. 实现顺序

```
Step 1: index.css       — 背景去蓝化 + 3 变量改蓝 + 新增变量    (5min)
    ↓
Step 2: App.css         — 光晕/纹理/滚动条/聚焦/AI头像增强      (10min)
    ↓
Step 3: config.ts       — SpiderManThemeConfig 新增 blueAccent  (2min)
    ↓
Step 4: spiderman-theme.ts — 同步 blueAccent 到 CSS 变量        (3min)
    ↓
Step 5: ThemeTab.tsx    — 蓝色强调滑块 UI                       (8min)
    ↓
Step 6: locales         — 中英文翻译键                          (2min)
```

**预估总工时：30 分钟**

---

## 9. 验证清单

| 检查项 | 预期效果 |
|--------|---------|
| ConnectingOverlay 加载动画 | 旋转环从红→蓝，进度条红→蓝渐变 |
| 需求面板状态标签 | 从红色变为蓝色 |
| Todo 普通优先级图标 | 从红色变为蓝色 |
| 环境光晕 | 右上角蓝色光晕明显可见 |
| 蛛网纹理 | 可见蓝色线条交织 |
| 滚动条 | 蓝色滑块，悬停加深 |
| 输入框聚焦 | 蓝色发光边框 |
| AI 头像 | 蓝色光晕 |
| 背景色 | 纯黑 `#000000`，无蓝染 |
| 设置面板蓝色强调滑块 | 0% 蓝色消失，100% 蓝色最大 |