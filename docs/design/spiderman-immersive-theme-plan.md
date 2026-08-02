# Spider-Man 沉浸主题 — 设计与实施方案

> **版本**: v4.0  
> **状态**: 待实施  
> **修改文件数**: 8  
> **组件修改**: 0（纯 CSS 变量驱动）

---

## 1. 概述

为 Polaris 项目添加 Spider-Man 沉浸主题，作为第三个主题选项（`dark` / `light` / `spiderman`）。  
主题为 **dark-only**（仅有暗色变体），使用 **红 #DC2626 + 蓝 #3B82F6 + 黑 #05050F** 配色方案。

### 设计原则

- **零组件修改** — 全部通过 CSS 变量驱动，不碰任何组件代码
- **dark-only** — 蜘蛛侠只有暗色变体，匹配电影夜间氛围
- **7层沉浸** — 颜色系统 → 蛛网纹理 → 环境光晕 → 微交互 → 组件主题 → 品牌标识 → 细微特效
- **无外部依赖** — 核心主题纯 CSS，图片资源走 CDN

---

## 2. 项目结构分析

### 当前架构速览

```
src/
├── types/config.ts          → Theme = 'dark' | 'light'        ← 需加 'spiderman'
├── stores/themeStore.ts     → localStorage + data-theme + 服务端持久化
├── main.tsx                 → 内联脚本防 FOUC（首屏闪烁）
├── index.css                → :root (dark) + :root[data-theme="light"]
├── tailwind.config.js       → rgb(var(--c-xxx) / <alpha-value>) 桥接
├── components/Settings/
│   └── tabs/GeneralTab.tsx  → 2 个按钮切换 dark/light
├── locales/*/settings.json  → i18n 翻译
└── assets/spiderman/        → 不存在，需新建
```

### 主题数据流

```
用户选择主题
    ↓
GeneralTab.tsx → onConfigChange({ theme: 'spiderman' })
    ↓
configStore → updateConfigPatch → 服务端持久化
    ↓
themeStore.setTheme() → writeDom() + writeStorage()
    ↓
document.documentElement.setAttribute('data-theme', 'spiderman')
    ↓
index.css → :root[data-theme="spiderman"] { ... } 生效
    ↓
Tailwind 变量 → rgb(var(--c-primary) / <alpha-value>) → 全组件自动更新
```

---

## 3. 配色方案

| Token | Dark 默认值 | Spider-Man 值 | 色块 |
|-------|------------|--------------|------|
| `--c-primary` | 59 130 246 (蓝) | **220 38 38** (红) | 🟥 |
| `--c-primary-hover` | 37 99 235 | **185 28 28** | 🟥 |
| `--c-primary-50` | 239 246 255 | **254 226 226** | |
| `--c-primary-100` | 219 234 254 | **254 202 202** | |
| `--c-primary-200` | 191 219 254 | **252 165 165** | |
| `--c-primary-300` | 147 197 253 | **248 113 113** | |
| `--c-primary-400` | 96 165 250 | **239 68 68** | |
| `--c-primary-500` | 59 130 246 | **220 38 38** | |
| `--c-primary-600` | 37 99 235 | **185 28 28** | |
| `--c-primary-700` | 29 78 216 | **153 27 27** | |
| `--c-bg-base` | 15 15 17 | **5 5 15** | ⬛ |
| `--c-bg-elevated` | 26 26 31 | **11 11 24** | |
| `--c-bg-surface` | 37 37 43 | **17 17 34** | |
| `--c-bg-hover` | 45 45 53 | **22 22 40** | |
| `--c-bg-active` | 53 53 61 | **28 28 48** | |
| `--c-accent-ai` | 167 139 250 | **220 38 38** | 🟥 |
| `--c-accent-workspace` | 251 191 36 | **59 130 246** | 🔵 |

---

## 4. 7 层沉浸体验

### Layer 1: 颜色系统
- 主色从蓝色切换为红色
- 背景色加深为极黑 #05050F
- 强调色从紫色切换为红色

### Layer 2: 蛛网纹理
- 4 方向交叉线（0°/90°/45°/-45°）
- 透明度 0.15（可调 0~0.35）
- 径向渐变遮罩，边缘淡出

### Layer 3: 环境光晕
- 3 层径向渐变叠加
  - 左上 15% 位置：红色光晕
  - 右上 85% 位置：蓝色光晕
  - 底部 50% 位置：微弱红色

### Layer 4: 微交互
- 加载动画（ThinkingOrb）从蓝色变为红色脉冲
- 输入框聚焦时红色边框发光
- 头像发光效果

### Layer 5: 组件主题
- 聊天气泡：用户消息红色背景
- 发送按钮：红色渐变
- 滚动条：红色主题

### Layer 6: 品牌标识
- 标题文字红色渐变
- 可更换的面具头像（30+ 选项）
- 背景图片（6 种 Spider-Man 风格 + 自定义上传）

### Layer 7: 细微特效
- 毛玻璃效果（blur）
- 背景图随设置调节位置/大小
- 平滑过渡动画

---

## 5. 修改文件清单（8 个）

### Step 1: `src/types/config.ts`

```typescript
// 修改前
export type Theme = 'dark' | 'light'

// 修改后
export type Theme = 'dark' | 'light' | 'spiderman'
```

### Step 2: `src/stores/themeStore.ts`

```typescript
// readInitialTheme 识别 spiderman
function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'spiderman') return 'spiderman'
  return stored === 'light' ? 'light' : 'dark'
}

// applyTheme 切换 favicon
function updateFavicon(theme: Theme): void {
  const link = document.querySelector('link[rel="icon"]') || document.createElement('link')
  link.rel = 'icon'
  link.href = theme === 'spiderman'
    ? '/src/assets/spiderman/favicon.svg'
    : '/favicon.ico'
  document.head.appendChild(link)
}
```

### Step 3: `src/main.tsx`

```typescript
// FOUC 内联脚本
(() => {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null
    const theme = stored === 'spiderman' ? 'spiderman' : stored === 'light' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', theme)
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark')
  }
})()
```

### Step 4: `src/index.css`（核心）

新增 `:root[data-theme="spiderman"]` 块，包含：
- 全部 CSS 变量覆盖（参考第 3 节配色方案）
- 背景装饰层（伪元素）
- 蛛网纹理（CSS 渐变）
- 环境光晕（径向渐变）

```css
:root[data-theme="spiderman"] {
  color-scheme: dark;

  /* Primary - Red */
  --c-primary: 220 38 38;
  --c-primary-hover: 185 28 28;
  /* ... 其他变量 */

  /* Background - Deep Dark */
  --c-bg-base: 5 5 15;
  /* ... 其他变量 */
}
```

### Step 5: `src/App.css`

添加 Spider-Man 专属动画：

```css
/* 红色脉冲加载动画 */
[data-theme="spiderman"] .thinking-orb-ring {
  border-top-color: #DC2626;
}

[data-theme="spiderman"] .thinking-orb-ring--reverse {
  border-right-color: #DC2626;
}
```

### Step 6: `src/components/Settings/tabs/GeneralTab.tsx`

添加 Spider-Man 主题按钮，与 dark/light 并列：

```tsx
<button onClick={() => onConfigChange({ ...config, theme: 'spiderman' })}>
  🕷️ 蜘蛛侠
</button>
```

### Step 7: `src/locales/*/settings.json`

```json
{
  "appearance": {
    "dark": "深色",
    "light": "浅色",
    "spiderman": "蜘蛛侠"
  }
}
```

### Step 8: `src/assets/spiderman/`

新建目录，包含：
- `favicon.svg` — 蜘蛛侠图标
- `web-pattern.svg` — 蛛网纹理
- `spider-icon.svg` — 蜘蛛图标

---

## 6. 背景图片

### 预设背景（6 种 Spider-Man 风格）

| # | 图片 | 来源 | 说明 |
|---|------|------|------|
| 1 | `https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920` | Unsplash | 纽约天际线 · 经典 |
| 2 | `https://images.unsplash.com/photo-1635805737707-575885ab0820?q=80&w=1920` | Unsplash | 面具发光眼 |
| 3 | `https://images.unsplash.com/photo-1715783735932-2aaa7bcfab34?q=80&w=1920` | Unsplash | 金色蜘蛛 Logo |
| 4 | `https://images.unsplash.com/photo-1642456074142-92f75cb84533?q=80&w=1920` | Unsplash | 战衣·发光眼 |
| 5 | `https://images.unsplash.com/photo-1505925456693-124134d66749?q=80&w=1920` | Unsplash | 城市之巅 |
| 6 | 关闭 | — | 纯色暗黑模式 |

### 自定义上传
- 支持用户上传本地图片作为背景
- 上传后通过 FileReader 转为 Data URL 存储
- 自动保存到 localStorage

### 位置与大小控制
- 缩放模式：铺满 / 适应 / 自适应高 / 自适应宽
- 水平偏移：左 ← 居中 → 右（0-100%）
- 垂直偏移：上 ← 居中 → 下（0-100%）

---

## 7. 面具头像

### 来源
从以下网站收集了 25+ 个 Spider-Man 面具透明 PNG：

| 来源 | 数量 | 质量 |
|------|------|------|
| PNG Mart | 3 | 高清 (2400×2400) |
| StickPNG | 2 | 高清 (1600×1114) |
| Creazilla | 1 | 高清 (1920×1366) |
| PNG Arts | 5 | 高清 (900×900) |
| PurePNG | 1 | 高清 (750×750) |
| IconScout | 2 | 图标 (512×512) |
| IconFinder | 2 | 图标 (512×512) |
| 其他 | 10+ | 中等 |

### 分类
- 🔥 热门：经典面具造型
- 🦸 图标：适合做头像的图标风格
- 🎬 特别：平行宇宙、英雄归来等
- 🎨 更多：剪贴画、Logo 等

---

## 8. 设置面板功能

### 界面布局
- 右侧滑出设置面板（520px 宽）
- 毛玻璃背景（backdrop-filter: blur(24px)）
- 点击遮罩层或 ESC 关闭

### 设置项

| 区域 | 功能 | 说明 |
|------|------|------|
| 🎭 面具头像 | 25+ 面具选择 | 点击即切换，实时预览 |
| 🕸️ 背景图片 | 6 预设 + 上传 | 网格缩略图展示 |
| 📐 位置与大小 | 缩放 + 偏移 | 4 种缩放模式 + 2 个滑块 |
| 🎨 视觉效果 | 透明度/纹理 | 2 个滑块调节 |
| ℹ️ 实施信息 | 文件清单 | 修改文件数等 |

---

## 9. 实现步骤

### 执行顺序

```
Step 1: config.ts          (1 分钟)
    ↓
Step 2: themeStore.ts      (2 分钟)
    ↓
Step 3: main.tsx           (1 分钟)
    ↓
Step 4: index.css          (15 分钟) ← 核心
    ↓
Step 5: App.css            (2 分钟)
    ↓
Step 6: GeneralTab.tsx     (3 分钟)
    ↓
Step 7: locales            (1 分钟)
    ↓
Step 8: assets/spiderman/  (5 分钟)
```

### 预估总工时：30 分钟

---

## 10. 注意事项

1. **FOUC 预防**：main.tsx 和 themeStore.ts 必须同步更新，确保 spiderman 主题在首屏就能正确渲染
2. **localStorage 兼容**：`'spiderman'` 作为新值，旧版 Polaris 只认识 `'dark'` | `'light'`，降级为 `'dark'`
3. **Tailwind 桥接**：所有组件颜色自动跟随 CSS 变量，无需修改组件代码
4. **图片加载失败**：面具图片加载失败时自动隐藏，不影响其他选项
5. **性能**：背景图使用 `fixed` 定位，不随滚动重绘；蛛网纹理使用 CSS 渐变而非图片

---

## 11. 参考

- [Polaris 视觉现代化 v3](../docs/design/polaris-visual-modernization-v3.md)
- [Polaris 布局重设计](../docs/design/polaris-layout-redesign-plan.md)
- 原型预览：`.polaris/previews/df233b16-4d10-4a75-99b0-a687f21601fa/index.html`