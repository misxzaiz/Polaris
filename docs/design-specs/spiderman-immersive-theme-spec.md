# Spider-Man 沉浸主题 — 开发规格说明书

> **文档版本**: v1.0  
> **状态**: 待开发  
> **修改文件数**: 8  
> **组件修改**: 0（纯样式/CSS 变量）  
> **预估工时**: 30 分钟  
> **优先级**: P0

---

## 1. 概述

为 Polaris 项目添加 Spider-Man 沉浸主题，作为第三个主题选项。  
**注意：只改样式，不改布局。** 所有设置项遵循现有 GeneralTab 的 UI 模式（卡片 + 按钮/滑块）。

### 1.1 设计原则

- ✅ **纯 CSS 变量驱动** — 不修改任何组件逻辑
- ✅ **dark-only** — 蜘蛛侠只有暗色变体
- ✅ **遵循现有 UI 模式** — 设置项使用 `bg-surface rounded-lg border border-border` 卡片布局
- ✅ **设置持久化** — 通过 `onConfigChange` 写入 Config，服务端持久化

---

## 2. 修改文件清单

| # | 文件 | 修改类型 | 影响范围 |
|---|------|---------|---------|
| 1 | `src/types/config.ts` | 类型扩展 | Theme 联合类型 + Config 接口 |
| 2 | `src/stores/themeStore.ts` | 逻辑修改 | 识别 spiderman 主题 |
| 3 | `src/main.tsx` | 逻辑修改 | FOUC 内联脚本 |
| 4 | `src/index.css` | 样式新增 | 全部 CSS 变量 + 装饰层 |
| 5 | `src/App.css` | 样式新增 | 动画 |
| 6 | `src/components/Settings/tabs/GeneralTab.tsx` | 组件修改 | 主题按钮 + 设置卡片 |
| 7 | `src/locales/*/settings.json` | i18n 新增 | 翻译键值 |
| 8 | `src/assets/spiderman/` | 新建目录 | SVG 素材 |

---

## 3. 详细修改规格

### 3.1 `src/types/config.ts`

#### 3.1.1 修改 Theme 类型

```typescript
// 第 10 行附近
// 修改前
export type Theme = 'dark' | 'light'

// 修改后
export type Theme = 'dark' | 'light' | 'spiderman'
```

#### 3.1.2 新增 SpiderManThemeConfig 接口

在 `Config` 接口中新增 `spidermanTheme` 字段：

```typescript
// 在 Config 接口末尾添加
/** Spider-Man 沉浸主题配置 */
spidermanTheme?: SpiderManThemeConfig;
```

新增接口定义（放在 `WindowSettings` 之后）：

```typescript
/** Spider-Man 主题配置 */
export interface SpiderManThemeConfig {
  /** 背景图片 URL（空 = 使用预设） */
  backgroundImage?: string;
  /** 背景图片透明度 (0-1) */
  backgroundOpacity?: number;
  /** 蛛网纹理强度 (0-1) */
  webTextureOpacity?: number;
  /** 背景缩放模式: cover | contain | auto-height | auto-width */
  backgroundSize?: string;
  /** 背景水平偏移 (0-100) */
  backgroundPositionX?: number;
  /** 背景垂直偏移 (0-100) */
  backgroundPositionY?: number;
  /** 面具头像 URL */
  avatarUrl?: string;
}
```

#### 3.1.3 默认值

```typescript
export const DEFAULT_SPIDERMAN_THEME: SpiderManThemeConfig = {
  backgroundOpacity: 0.2,
  webTextureOpacity: 0.15,
  backgroundSize: 'cover',
  backgroundPositionX: 50,
  backgroundPositionY: 50,
};
```

---

### 3.2 `src/stores/themeStore.ts`

#### 3.2.1 修改 Theme 导出

```typescript
// 第 14 行
// 修改前
export type Theme = 'dark' | 'light';

// 修改后
export type Theme = 'dark' | 'light' | 'spiderman';
```

#### 3.2.2 修改 readInitialTheme

```typescript
function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'spiderman') return 'spiderman';
  return stored === 'light' ? 'light' : 'dark';
}
```

#### 3.2.3 添加 favicon 切换（可选增强）

```typescript
function updateFavicon(theme: Theme): void {
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (!link) return;
  link.href = theme === 'spiderman'
    ? '/src/assets/spiderman/favicon.svg'
    : '/favicon.ico';
}
```

在 `applyTheme` 和 `setTheme` 中调用 `updateFavicon(theme)`。

---

### 3.3 `src/main.tsx`

修改 FOUC 内联脚本（第 18-24 行）：

```typescript
(() => {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null;
    const theme = stored === 'spiderman' ? 'spiderman' : stored === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
```

---

### 3.4 `src/index.css`（核心）

#### 3.4.1 新增 `:root[data-theme="spiderman"]` 块

在 `:root[data-theme="light"]` 之后追加。全部 CSS 变量覆盖：

```css
:root[data-theme="spiderman"] {
  color-scheme: dark;

  /* Primary - Spider-Man Red */
  --c-primary: 220 38 38;
  --c-primary-hover: 185 28 28;
  --c-primary-50: 254 226 226;
  --c-primary-100: 254 202 202;
  --c-primary-200: 252 165 165;
  --c-primary-300: 248 113 113;
  --c-primary-400: 239 68 68;
  --c-primary-500: 220 38 38;
  --c-primary-600: 185 28 28;
  --c-primary-700: 153 27 27;

  /* Background - Deep Dark */
  --c-bg-base: 5 5 15;
  --c-bg-elevated: 11 11 24;
  --c-bg-surface: 17 17 34;
  --c-bg-hover: 22 22 40;
  --c-bg-active: 28 28 48;
  --c-bg-tertiary: 20 24 36;
  --c-bg-secondary: 14 18 28;

  /* Border - Red tint */
  --c-border: 220 38 38;

  /* Text - unchanged from dark */
  --c-text-primary: 248 248 248;
  --c-text-secondary: 180 180 184;
  --c-text-tertiary: 142 142 147;
  --c-text-muted: 109 109 112;

  /* Status - Red tint */
  --c-status-warning: 251 191 36;
  --c-status-success: 52 211 153;
  --c-status-danger: 248 113 113;
  --c-status-info: 220 38 38;
  --c-status-done: 16 185 129;
  --c-status-failed: 239 68 68;
  --c-status-neutral: 156 163 175;

  /* Priority */
  --c-priority-low: 156 163 175;
  --c-priority-normal: 220 38 38;
  --c-priority-high: 251 146 60;
  --c-priority-urgent: 248 113 113;

  /* Accent */
  --c-accent-ai: 220 38 38;
  --c-accent-prototype: 34 211 238;
  --c-accent-workspace: 59 130 246;

  /* Misc */
  --c-overlay: 0 0 0;
  --c-on-primary: 255 255 255;
  --c-canvas: 255 255 255;
  --c-tag-bg: 255 255 255;
  --c-shadow: 0 0 0;
}
```

#### 3.4.2 背景装饰层（CSS 伪元素）

在 `:root[data-theme="spiderman"]` 块内或单独添加：

```css
/* 背景装饰层 - 仅 spiderman 主题生效 */
[data-theme="spiderman"] .main-layout::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--spiderman-bg-image, url('https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920'))
    var(--spiderman-bg-position, center) / var(--spiderman-bg-size, cover) fixed;
  opacity: var(--spiderman-bg-opacity, 0.2);
  pointer-events: none;
  z-index: 0;
  transition: opacity 0.3s;
}
```

**注意**：`main-layout` 类名需确认是否与 App.tsx 中的根容器类名一致。  
实际实现时需用 JS 动态设置 CSS 变量（通过 `themeStore` 或直接在 `GeneralTab` 中设置 `document.documentElement.style.setProperty`）。

#### 3.4.3 蛛网纹理

```css
[data-theme="spiderman"] .web-texture {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: var(--spiderman-web-opacity, 0.15);
  background-image:
    repeating-linear-gradient(0deg, transparent, transparent 60px, rgba(220,38,38,0.04) 60px, rgba(220,38,38,0.04) 61px),
    repeating-linear-gradient(90deg, transparent, transparent 60px, rgba(220,38,38,0.04) 60px, rgba(220,38,38,0.04) 61px),
    repeating-linear-gradient(45deg, transparent, transparent 85px, rgba(220,38,38,0.02) 85px, rgba(220,38,38,0.02) 86px),
    repeating-linear-gradient(-45deg, transparent, transparent 85px, rgba(220,38,38,0.02) 85px, rgba(220,38,38,0.02) 86px);
  mask-image: radial-gradient(ellipse at center, black 25%, transparent 72%);
  -webkit-mask-image: radial-gradient(ellipse at center, black 25%, transparent 72%);
}
```

#### 3.4.4 环境光晕

```css
[data-theme="spiderman"] .main-layout::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 15% 50%, rgba(220,38,38,0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 30%, rgba(59,130,246,0.06) 0%, transparent 50%);
  pointer-events: none;
  z-index: 0;
}
```

---

### 3.5 `src/App.css`

在文件末尾添加 Spider-Man 主题专属动画：

```css
/* ========================================
   Spider-Man 主题动画
   ======================================== */

/* 红色脉冲加载动画 */
[data-theme="spiderman"] .thinking-orb-ring {
  border-top-color: #DC2626;
}
[data-theme="spiderman"] .thinking-orb-ring--reverse {
  border-top-color: transparent;
  border-right-color: #DC2626;
}
[data-theme="spiderman"] .thinking-orb-ring:nth-child(3) {
  border-top-color: transparent;
  border-bottom-color: #EF4444;
}

/* 发送按钮渐变 */
[data-theme="spiderman"] .send-btn {
  background: linear-gradient(135deg, #DC2626, #EF4444);
}
```

---

### 3.6 `src/components/Settings/tabs/GeneralTab.tsx`

#### 3.6.1 主题按钮区 — 增加 Spider-Man 按钮

在现有的 dark/light 按钮之后添加第三个按钮：

```tsx
<button
  type="button"
  onClick={() => onConfigChange({ ...config, theme: 'spiderman' })}
  disabled={loading}
  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
    currentTheme === 'spiderman'
      ? 'bg-primary text-on-primary'
      : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
  } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
>
  🕷️ {t('appearance.spiderman')}
</button>
```

#### 3.6.2 新增 Spider-Man 设置卡片

在「外观主题」卡片之后，新增一个 Spider-Man 专属设置卡片，**仅在 `theme === 'spiderman'` 时渲染**：

```tsx
{/* Spider-Man 主题设置 */}
{currentTheme === 'spiderman' && (
  <SpiderManSection config={config} onConfigChange={onConfigChange} loading={loading} />
)}
```

#### 3.6.3 SpiderManSection 组件

新建 `SpiderManSection` 组件，包含以下设置项：

**a) 面具头像选择**

```tsx
<div className="p-4 bg-surface rounded-lg border border-border">
  <h3 className="text-sm font-medium text-text-primary mb-3">
    🎭 {t('spiderman.avatar.title')}
  </h3>
  <div className="text-xs text-text-secondary mb-3">{t('spiderman.avatar.hint')}</div>
  {/* 预设头像网格：3列，点击选择 */}
  <div className="grid grid-cols-4 gap-2">
    {AVATAR_OPTIONS.map((avatar) => (
      <button
        key={avatar.src}
        onClick={() => onConfigChange({
          ...config,
          spidermanTheme: { ...spidermanTheme, avatarUrl: avatar.src }
        })}
        className={`w-full aspect-square rounded-lg overflow-hidden border-2 transition-all ${
          (spidermanTheme.avatarUrl || DEFAULT_AVATAR) === avatar.src
            ? 'border-primary'
            : 'border-transparent hover:border-border'
        }`}
      >
        <img src={avatar.src} alt={avatar.label} className="w-full h-full object-contain p-1"
             onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
      </button>
    ))}
  </div>
</div>
```

**b) 背景图片选择 + 自定义上传**

```tsx
<div className="p-4 bg-surface rounded-lg border border-border">
  <h3 className="text-sm font-medium text-text-primary mb-3">
    🕸️ {t('spiderman.background.title')}
  </h3>
  {/* 预设背景网格 */}
  <div className="grid grid-cols-2 gap-2 mb-3">
    {BACKGROUND_OPTIONS.map((bg) => (...))}
  </div>
  {/* 自定义上传按钮 */}
  <label className="flex items-center justify-center gap-2 p-2 rounded-lg border border-dashed border-primary/50 text-primary text-xs cursor-pointer hover:bg-primary/5">
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
    </svg>
    {t('spiderman.background.upload')}
    <input type="file" accept="image/*" className="hidden" onChange={handleUpload} />
  </label>
</div>
```

**c) 透明度与效果滑块**

```tsx
<div className="p-4 bg-surface rounded-lg border border-border">
  <h3 className="text-sm font-medium text-text-primary mb-3">
    🎨 {t('spiderman.effects.title')}
  </h3>
  
  {/* 背景透明度滑块 */}
  <OpacitySlider
    label={t('spiderman.effects.bgOpacity')}
    hint={t('spiderman.effects.bgOpacityHint')}
    value={Math.round((spidermanTheme.backgroundOpacity ?? 0.2) * 100)}
    onChange={(v) => {
      updateSpiderManConfig({ backgroundOpacity: v / 100 });
      document.documentElement.style.setProperty('--spiderman-bg-opacity', String(v / 100));
    }}
  />
  
  {/* 蛛网纹理强度滑块 */}
  <OpacitySlider
    label={t('spiderman.effects.webOpacity')}
    hint={t('spiderman.effects.webOpacityHint')}
    value={Math.round((spidermanTheme.webTextureOpacity ?? 0.15) * 100)}
    onChange={(v) => {
      updateSpiderManConfig({ webTextureOpacity: v / 100 });
      document.documentElement.style.setProperty('--spiderman-web-opacity', String(v / 100));
    }}
  />
</div>
```

**d) 位置与大小控制**

```tsx
<div className="p-4 bg-surface rounded-lg border border-border">
  <h3 className="text-sm font-medium text-text-primary mb-3">
    📐 {t('spiderman.position.title')}
  </h3>
  
  {/* 缩放模式按钮组 */}
  <div className="flex items-center justify-between mb-3">
    <span className="text-xs text-text-secondary">{t('spiderman.position.scaleMode')}</span>
    <div className="flex gap-1">
      {SCALE_OPTIONS.map(opt => (
        <button key={opt.value} onClick={() => updateSpiderManConfig({ backgroundSize: opt.value })}
          className={`px-2 py-1 text-xs rounded ${
            (spidermanTheme.backgroundSize || 'cover') === opt.value
              ? 'bg-primary text-on-primary' : 'bg-background-surface border border-border text-text-secondary'
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  </div>
  
  {/* 水平偏移滑块 */}
  <ChatSlider
    label={t('spiderman.position.horizontal')}
    hint={t('spiderman.position.horizontalHint')}
    value={spidermanTheme.backgroundPositionX ?? 50}
    min={0} max={100} step={1}
    format={(v) => v === 50 ? '居中' : v > 50 ? `右${v-50}%` : `左${50-v}%`}
    onChange={(v) => {
      updateSpiderManConfig({ backgroundPositionX: v });
      document.documentElement.style.setProperty('--spiderman-bg-position', `${v}% ${spidermanTheme.backgroundPositionY ?? 50}%`);
    }}
  />
  
  {/* 垂直偏移滑块 */}
  <ChatSlider
    label={t('spiderman.position.vertical')}
    hint={t('spiderman.position.verticalHint')}
    value={spidermanTheme.backgroundPositionY ?? 50}
    min={0} max={100} step={1}
    format={(v) => v === 50 ? '居中' : v > 50 ? `下${v-50}%` : `上${50-v}%`}
    onChange={(v) => {
      updateSpiderManConfig({ backgroundPositionY: v });
      document.documentElement.style.setProperty('--spiderman-bg-position', `${spidermanTheme.backgroundPositionX ?? 50}% ${v}%`);
    }}
  />
</div>
```

#### 3.6.4 辅助函数

```typescript
// 更新 spidermanTheme 配置
const spidermanTheme = config.spidermanTheme ?? DEFAULT_SPIDERMAN_THEME;

const updateSpiderManConfig = (patch: Partial<SpiderManThemeConfig>) => {
  onConfigChange({
    ...config,
    spidermanTheme: { ...spidermanTheme, ...patch },
  });
};

// 图片上传处理
const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target?.result as string;
    updateSpiderManConfig({ backgroundImage: dataUrl });
    document.documentElement.style.setProperty('--spiderman-bg-image', `url('${dataUrl}')`);
  };
  reader.readAsDataURL(file);
};

// 预设数据
const AVATAR_OPTIONS = [
  { src: 'https://www.pngmart.com/files/10/Spider-Man-Mask-Logo-PNG-Transparent-Image.png', label: '经典 #1' },
  { src: 'https://assets.stickpng.com/images/5853bcc7ec0c270fc2f62de8.png', label: '经典 #2' },
  // ... 25+ 选项
];

const BACKGROUND_OPTIONS = [
  { src: 'https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920', label: '纽约天际线' },
  { src: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?q=80&w=1920', label: '面具发光眼' },
  // ... 5 选项
];

const SCALE_OPTIONS = [
  { value: 'cover', label: '铺满' },
  { value: 'contain', label: '适应' },
  { value: 'auto 100%', label: '自适应高' },
  { value: '100% auto', label: '自适应宽' },
];
```

---

### 3.7 `src/locales/*/settings.json`

#### 3.7.1 en-US/settings.json

在 `appearance` 区块中添加：

```json
"appearance": {
  // ... 现有字段
  "spiderman": "Spider-Man"
}
```

新增 `spiderman` 区块：

```json
"spiderman": {
  "title": "Spider-Man Theme",
  "avatar": {
    "title": "Mask Avatar",
    "hint": "Choose your Spider-Man mask avatar"
  },
  "background": {
    "title": "Background",
    "hint": "Choose or upload a background image",
    "upload": "Upload Custom Image"
  },
  "effects": {
    "title": "Visual Effects",
    "bgOpacity": "Background Opacity",
    "bgOpacityHint": "Adjust the visibility of the background image",
    "webOpacity": "Web Texture",
    "webOpacityHint": "Adjust the intensity of the spider web texture"
  },
  "position": {
    "title": "Position & Size",
    "scaleMode": "Scale Mode",
    "horizontal": "Horizontal Offset",
    "horizontalHint": "Move the background left or right",
    "vertical": "Vertical Offset",
    "verticalHint": "Move the background up or down"
  }
}
```

#### 3.7.2 zh-CN/settings.json

```json
"appearance": {
  // ... 现有字段
  "spiderman": "蜘蛛侠"
}

"spiderman": {
  "title": "蜘蛛侠主题",
  "avatar": {
    "title": "面具头像",
    "hint": "选择你的蜘蛛侠面具头像"
  },
  "background": {
    "title": "背景图片",
    "hint": "选择或上传背景图片",
    "upload": "上传自定义图片"
  },
  "effects": {
    "title": "视觉效果",
    "bgOpacity": "背景透明度",
    "bgOpacityHint": "调节背景图片的可见度",
    "webOpacity": "蛛网纹理",
    "webOpacityHint": "调节蛛网纹理的强度"
  },
  "position": {
    "title": "位置与大小",
    "scaleMode": "缩放模式",
    "horizontal": "水平偏移",
    "horizontalHint": "左右移动背景位置",
    "vertical": "垂直偏移",
    "verticalHint": "上下移动背景位置"
  }
}
```

---

### 3.8 `src/assets/spiderman/`

新建目录，包含以下文件：

```
src/assets/spiderman/
├── favicon.svg          # 蜘蛛侠图标（16x16 SVG）
├── web-pattern.svg      # 蛛网纹理（备用）
└── spider-icon.svg      # 蜘蛛图标（备用）
```

`favicon.svg` 内容（简化版蜘蛛侠面具图标）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#DC2626">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
  <path d="M12 6c-1.1 0-2 .9-2 2v1.17l-1.17-1.17c-.39-.39-1.02-.39-1.41 0s-.39 1.02 0 1.41L10.59 12l-3.17 3.17c-.39.39-.39 1.02 0 1.41s1.02.39 1.41 0L12 13.41l3.17 3.17c.39.39 1.02.39 1.41 0s.39-1.02 0-1.41L13.41 12l3.17-3.17c.39-.39.39-1.02 0-1.41s-1.02-.39-1.41 0L12 9.17V8c0-1.1-.9-2-2-2z"/>
</svg>
```

---

## 4. CSS 变量动态控制

### 4.1 全局 CSS 变量

用于 JS 动态控制的 CSS 变量，在 `:root` 中定义默认值：

```css
:root {
  /* Spider-Man 动态变量（默认值，非 spiderman 主题时无效果） */
  --spiderman-bg-image: none;
  --spiderman-bg-opacity: 0.2;
  --spiderman-bg-position: center;
  --spiderman-bg-size: cover;
  --spiderman-web-opacity: 0.15;
}
```

### 4.2 JS 动态更新

在 `GeneralTab` 的 `SpiderManSection` 组件中，通过 `useEffect` 在挂载时恢复上次设置：

```tsx
useEffect(() => {
  const theme = config.spidermanTheme;
  if (!theme) return;
  
  if (theme.backgroundImage) {
    document.documentElement.style.setProperty('--spiderman-bg-image', `url('${theme.backgroundImage}')`);
  }
  document.documentElement.style.setProperty('--spiderman-bg-opacity', String(theme.backgroundOpacity ?? 0.2));
  document.documentElement.style.setProperty('--spiderman-web-opacity', String(theme.webTextureOpacity ?? 0.15));
  document.documentElement.style.setProperty('--spiderman-bg-position', 
    `${theme.backgroundPositionX ?? 50}% ${theme.backgroundPositionY ?? 50}%`);
  document.documentElement.style.setProperty('--spiderman-bg-size', theme.backgroundSize ?? 'cover');
}, [config.spidermanTheme]);
```

---

## 5. 预设数据

### 5.1 背景图片（6 种）

| # | URL | 说明 |
|---|-----|------|
| 1 | `https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920` | 纽约天际线 · 经典 |
| 2 | `https://images.unsplash.com/photo-1635805737707-575885ab0820?q=80&w=1920` | 面具发光眼 |
| 3 | `https://images.unsplash.com/photo-1715783735932-2aaa7bcfab34?q=80&w=1920` | 金色蜘蛛 Logo |
| 4 | `https://images.unsplash.com/photo-1642456074142-92f75cb84533?q=80&w=1920` | 战衣·发光眼 |
| 5 | `https://images.unsplash.com/photo-1505925456693-124134d66749?q=80&w=1920` | 城市之巅 |
| 6 | `''` (空字符串) | 关闭背景 |

### 5.2 面具头像（25+）

见原型预览中的 `masks` 数组，按组分类：
- 🔥 热门（8 个经典面具）
- 🦸 图标（4 个图标风格）
- 🎬 特别（4 个特别版）
- 🎨 更多（9+ 个其他）

### 5.3 Spider-Man 经典语录

用于加载状态（ThinkingOrb）和空闲状态展示，随机选取一条：

| # | 英文 | 中文 | 出处 |
|---|------|------|------|
| 1 | "With great power comes great responsibility." | "能力越大，责任越大。" | 本叔 · 蜘蛛侠 1 |
| 2 | "I'm Spider-Man. I'm the good guy." | "我是蜘蛛侠，我是好人。" | 蜘蛛侠：英雄无归 |
| 3 | "My spidey-sense is tingling!" | "我的蜘蛛感应正在报警！" | 蜘蛛侠系列 |
| 4 | "No matter what I do, the ones I love will always be the ones who pay." | "无论我做什么，我爱的人总是要付出代价。" | 蜘蛛侠 2 |
| 5 | "Everybody loves a hero. People line up for them, cheer them, scream their names." | "人人都爱英雄。人们为他们排队，为他们欢呼，尖叫他们的名字。" | 蜘蛛侠 2 |
| 6 | "Anyone can wear the mask. You could wear the mask." | "任何人都可以戴上面具。你也可以。" | 蜘蛛侠：平行宇宙 |
| 7 | "If you're nothing without the suit, then you shouldn't have it." | "如果你没了战衣就什么都不是，那你就不配拥有它。" | 蜘蛛侠：英雄无归 |
| 8 | "I can't be Spider-Man. There's only one Spider-Man." | "我不能是蜘蛛侠。蜘蛛侠只有一个。" | 蜘蛛侠：平行宇宙 |
| 9 | "You're the one who needs to be locked up, not me." | "需要被关起来的是你，不是我。" | 蜘蛛侠 1 |
| 10 | "I protect the little guy." | "我保护弱小。" | 蜘蛛侠：英雄归来 |
| 11 | "The hardest part of this job is that you can't always save everybody." | "这份工作最难的部分是，你没法总是救到所有人。" | 蜘蛛侠 2 |
| 12 | "When you help someone, you help everyone." | "当你帮助一个人，你就在帮助所有人。" | 蜘蛛侠：平行宇宙 |
| 13 | "Whatever life holds in store for me, I will never forget these words." | "无论生活为我准备了什么，我永远不会忘记这些话。" | 蜘蛛侠 1 |
| 14 | "I'm gonna put some dirt in your eye." | "我要往你眼睛里撒点灰。" | 蜘蛛侠 1 |
| 15 | "It's you who's out, Gobby. Out of your mind!" | "是你出局了，绿魔。你疯了！" | 蜘蛛侠 1 |

#### 展示位置

1. **ThinkingOrb 加载动画** — AI 回复等待时，在脉冲动画下方显示随机经典语录
2. **状态栏（Status Bar）** — 空闲时在状态栏左侧滚动显示
3. **空对话状态** — 当对话列表为空时展示

#### 实现方式

```typescript
// 随机选取语录工具函数
const SPIDERMAN_QUOTES = [
  { en: "With great power comes great responsibility.", zh: "能力越大，责任越大。" },
  { en: "I'm Spider-Man. I'm the good guy.", zh: "我是蜘蛛侠，我是好人。" },
  // ... 全部 15 条
];

export function getRandomSpiderManQuote(lang: 'en-US' | 'zh-CN'): string {
  const quote = SPIDERMAN_QUOTES[Math.floor(Math.random() * SPIDERMAN_QUOTES.length)];
  return lang === 'zh-CN' ? quote.zh : quote.en;
}
```

---

## 6. 实现步骤

### 执行顺序

```
Step 1: config.ts          (1 分钟) — Theme 类型 + Config 接口
    ↓
Step 2: themeStore.ts      (2 分钟) — 识别 spiderman
    ↓
Step 3: main.tsx           (1 分钟) — FOUC
    ↓
Step 4: index.css          (15 分钟) — CSS 变量 + 装饰层
    ↓
Step 5: App.css            (2 分钟) — 动画
    ↓
Step 6: locales            (2 分钟) — 中英文翻译
    ↓
Step 7: assets/spiderman/  (3 分钟) — SVG 素材
    ↓
Step 8: GeneralTab.tsx     (15 分钟) — 设置 UI（核心交互）
```

### 预估工时：约 40 分钟

---

## 7. 注意事项

### 7.1 布局不变
- 所有 UI 改动只在 GeneralTab 内部新增卡片，不修改任何外部布局
- 背景装饰层使用 CSS 伪元素，不修改 DOM 结构
- 不使用任何额外的悬浮按钮或浮动面板

### 7.2 兼容性
- `localStorage` 中 `theme='spiderman'` 对旧版 Polaris 不可识别，降级为 `'dark'`
- 图片加载失败时自动隐藏（`onError` 处理）
- 所有 CSS 变量都有默认值，不会因缺失而样式崩溃

### 7.3 性能
- 背景图使用 `fixed` 定位，不随滚动重绘
- 蛛网纹理使用 CSS 渐变而非图片，零网络请求
- 设置变更通过 CSS 变量实时生效，不触发 React 重渲染

### 7.4 代码风格
- 严格遵循项目现有代码风格（Tailwind 类名、组件模式）
- 所有新字符串通过 i18n 管理（中英双语）
- 使用 `useCallback` 优化回调函数

---

## 8. 参考

- 项目文件：`src/types/config.ts`、`src/stores/themeStore.ts`、`src/main.tsx`
- 样式文件：`src/index.css`、`src/App.css`、`tailwind.config.js`
- 设置组件：`src/components/Settings/tabs/GeneralTab.tsx`
- 语言文件：`src/locales/en-US/settings.json`、`src/locales/zh-CN/settings.json`
- 设计文档：`docs/design/spiderman-immersive-theme-plan.md`
- 原型预览：`.polaris/previews/df233b16-4d10-4a75-99b0-a687f21601fa/index.html`