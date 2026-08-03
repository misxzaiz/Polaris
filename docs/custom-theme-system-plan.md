# 自定义主题系统 — 完整规划分析

> 状态：规划分析 v2
> 日期：2026-08-03
> 范围：从硬编码三主题到全用户自定义主题系统

---

## 1. 设计哲学

### 1.1 核心理念

dark、light、spider-man 三个内置主题，本质上只是自定义主题系统的**三个内置预设**。用户不应被限制在预设中，而是可以：

- 创建自己的主题（颜色 + 背景 + 透明度 + 效果）
- 修改已有主题（包括基于内置预设二次修改）
- 删除不需要的主题
- 导出/导入主题分享给他人
- 保存多个主题随时切换

### 1.2 主题 = 取值集合

一个主题本质上是一个**CSS 变量取值集合**，包含：

```
主题 = 颜色系统 + 沉浸效果 + 界面布局 + 元数据
```

每个用户可拥有 0~N 个主题，但同一时刻只能激活一个。

---

## 2. 完整数据模型

### 2.1 ThemeDefinition

```typescript
interface ThemeDefinition {
  /** 元数据 */
  id: string                          // UUID v4，内置主题用固定 ID
  name: string                        // 显示名称，1-32 字符
  description?: string                // 描述，可选
  author?: string                     // 作者名，导出时记录
  version: number                     // 数据格式版本，当前=1
  builtIn: boolean                    // 是否内置预设（不可删除/改名）
  createdAt: string                   // ISO 8601
  updatedAt: string                   // ISO 8601

  /** 颜色系统（RGB 三元组，与现有 --c-* 兼容） */
  colors: {
    primary: {
      base: string                    // 如 '59 130 246'
      hover: string
      50: string
      100: string
      200: string
      300: string
      400: string
      500: string
      600: string
      700: string
    }
    background: {
      base: string
      elevated: string
      surface: string
      hover: string
      active: string
      tertiary: string
      secondary: string
    }
    border: { base: string }
    text: {
      primary: string
      secondary: string
      tertiary: string
      muted: string
    }
    status: {
      warning: string
      success: string
      danger: string
      info: string
      done: string
      failed: string
      neutral: string
    }
    priority: {
      low: string
      normal: string
      high: string
      urgent: string
    }
    accent: {
      ai: string
      prototype: string
      workspace: string
    }
    misc: {
      overlay: string
      onPrimary: string
      canvas: string
      tagBg: string
      shadow: string
    }
  }

  /** 界面布局 */
  layout: {
    chatDisplay: {
      fontSize: number                // 12-20
      lineHeight: number              // 1.35-1.80
      paragraphSpacing: number        // 0-12
      messageSpacing: 'compact' | 'comfortable' | 'spacious'
      codeFontSize: number            // 11-18
      fontFamily: 'system' | 'serif' | 'mono'
    }
    windowOpacity: {
      normal: number                  // 0-100
      compact: number                 // 0-100
    }
  }

  /** 沉浸效果（可选，非沉浸主题可省略） */
  immersive?: {
    enabled: boolean                  // 是否启用沉浸效果
    wallpaper: {
      type: 'image' | 'gradient' | 'solid' | 'none'
      image?: string                  // URL 或 data URI
      gradient?: string               // CSS gradient 字符串
      solidColor?: string             // 纯色 RGB 三元组
      opacity: number                 // 0-1，背景可见度
      positionX: number               // 0-100
      positionY: number               // 0-100
      size: 'cover' | 'contain' | string
    }
    layerOpacity: {
      panel: number                   // L0: 0-1
      surface: number                 // L1: 0-1
      child: number                   // L2: 0-1
    }
    effects: {
      panelBlur: number               // 0-32 px
      webTexture: number              // 0-1
      blueAccent: number              // 0-1
    }
    avatar?: {
      url: string                     // 面具头像 URL 或 data URI
    }
    decorations?: {
      ambientLight: boolean           // 环境光晕
      webTexture: boolean             // 蛛网纹理
    }
  }
}
```

### 2.2 内置主题定义

三个内置主题在代码中硬编码为常量，不可修改：

```typescript
const BUILT_IN_THEMES: ThemeDefinition[] = [
  darkTheme,      // id: 'dark'
  lightTheme,     // id: 'light'
  spidermanTheme, // id: 'spiderman'
]
```

**dark 主题：** 仅 colors + layout，无 immersive 字段
**light 主题：** 仅 colors + layout，无 immersive 字段
**spiderman 主题：** colors + layout + immersive（完整）

### 2.3 导出文件格式 (.polaris-theme)

```json
{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-03T12:00:00Z",
  "theme": {
    "name": "赛博朋克2077",
    "description": "受 Cyberpunk 2077 启发的霓虹主题",
    "author": "user123",
    "version": 1,
    "builtIn": false,
    "colors": { /* 完整 colors */ },
    "layout": { /* 完整 layout */ },
    "immersive": { /* 完整 immersive */ }
  }
}
```

导出时排除：`id`, `createdAt`, `updatedAt`（导入时重新生成）

---

## 3. 所有涉及位置分析

### 3.1 当前 CSS 变量定义位置

| 文件 | 内容 | 改造方式 |
|------|------|---------|
| `src/index.css` :root | Dark 主题变量（~57 个颜色 + ~15 效果） | 保留为回退默认 |
| `src/index.css` :root[data-theme="light"] | Light 主题变量覆盖 | 移除，改为从 themeService 注入 |
| `src/index.css` :root[data-theme="spiderman"] | Spider-Man 变量覆盖 | 移除，改为从 themeService 注入 |
| `src/App.css` | spiderman 选择器（~30 条 CSS 规则） | 改为 `[data-theme-immersive]` 通用选择器 |

### 3.2 当前 JS 逻辑位置

| 文件 | 功能 | 改造方式 |
|------|------|---------|
| `src/main.tsx` | 首屏读取 localStorage theme → 写 data-theme | 改为读取 activeThemeId → 加载主题 → 注入变量 |
| `src/stores/themeStore.ts` | 管理 theme state + applyTheme/setTheme | 完全重写为多主题 store |
| `src/utils/spiderman-theme.ts` | 同步 Spider-Man CSS 变量到 DOM | 合并到通用 themeEngine，移除 |
| `src/stores/configStore.ts` | 持久化 config.theme | 改为 config.activeThemeId |
| `src/types/config.ts` | SpiderManThemeConfig 类型 | 移除，由 ThemeDefinition 替代 |
| `src/components/Settings/tabs/ThemeTab.tsx` | 主题选择 + Spider-Man 配置 UI | 拆分为 ThemeManager + ThemeEditor |

### 3.3 CSS 选择器位置

| 文件 | 选择器 | 改造方式 |
|------|--------|---------|
| `src/App.css` | `[data-theme="spiderman"]` | 改为 `[data-theme-immersive="true"]` |
| `src/App.css` | `[data-spiderman-panel]` | 改为 `[data-theme-panel]` |
| `src/App.css` | `--spiderman-*` 变量 | 改为 `--theme-*`，兼容旧名 |
| `src/App.css` | `.chat-display-root` | 保留，与主题无关 |
| `src/App.css` | `.theme-root` | 保留，与主题无关 |
| `src/App.css` | `.theme-web-texture` / `.theme-ambient` | 保留，但由 immersive.enabled 控制 |

### 3.4 data-spiderman-panel 使用位置

| 文件 | 行数 | 改造方式 |
|------|------|---------|
| `Layout/ActivityBar.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `Layout/LeftPanel.tsx` | 2 | 同上 |
| `Layout/RightPanel.tsx` | 2 | 同上 |
| `Common/Layout.tsx` | 3（Header/Sidebar/Aside） | 同上 |
| `Chat/ChatInput.tsx` | 1 | 同上 |
| `TopMenuBar/index.tsx` | 1 | 同上 |
| `Settings/SettingsPage.tsx` | 1 | 同上 |
| `Settings/SettingsSidebar.tsx` | 1 | 同上 |
| `Browser/BrowserPanel.tsx` | 1 | 同上 |
| `Browser/BrowserSidebarPanel.tsx` | 1 | 同上 |

合计：14 处，全局替换即可。

### 3.5 spiderman 相关 CSS 变量使用位置

| 变量 | 文件 | 用途 |
|------|------|------|
| `--spiderman-bg-overlay` | `App.css:137` | html 背景遮罩 |
| `--spiderman-bg-image` | `App.css:141` | 壁纸图片 |
| `--spiderman-bg-position` | `App.css:142` | 背景定位 |
| `--spiderman-bg-size` | `App.css:143` | 背景缩放 |
| `--spiderman-panel-blur` | `App.css:171` | 面板磨砂 |
| `--spiderman-panel-opacity` | `App.css:259-260` | L0 面板透明度 |
| `--spiderman-surface-opacity` | `App.css:269` | L1 内容透明度 |
| `--spiderman-child-opacity` | `App.css:294-300` | L2 子内容透明度 |
| `--spiderman-web-opacity` | `App.css:191,229` | 蛛网纹理 |
| `--spiderman-avatar-url` | `ThemeTab.tsx` | 面具头像 |
| `--spiderman-blue-accent` | `ThemeTab.tsx` | 蓝色强调 |
| `--spiderman-hover-opacity` | `App.css:286` | 悬停背景 |

全部改为 `--theme-*` 命名，兼容旧名（通过注入两份）。

### 3.6 本地化翻译

| 文件 | 键 | 改造方式 |
|------|-----|---------|
| `src/locales/zh-CN/settings.json` | `spiderman.*` | 保留，但添加通用主题编辑器翻译 |
| `src/locales/en-US/settings.json` | `spiderman.*` | 同上 |

---

## 4. 数据存储方案

### 4.1 存储架构

```
┌─────────────────────────────────────────────────────────┐
│                    存储架构                              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  localStorage（首屏快速读取）                              │
│  ├── activeThemeId: string          ← 当前激活的主题 ID  │
│  └── themeListCache: string[]       ← 主题 ID 列表缓存  │
│                                                         │
│  DataRoot/themes/（主存储，持久化）                       │
│  ├── index.json                     ← 主题索引文件       │
│  │   { "themes": [                                     │
│  │     { "id": "uuid", "name": "...", "builtIn": false },│
│  │     ...                                              │
│  │   ]}                                                 │
│  ├── {theme-id}.json                ← 每个主题定义文件   │
│  ├── {theme-id}.json                                   │
│  └── ...                                               │
│                                                         │
│  内置主题（代码内硬编码）                                 │
│  └── BUILT_IN_THEMES 常量                               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.2 读写流程

```
读取主题列表：
  1. 读取 DataRoot/themes/index.json → 主题索引
  2. 合并内置主题 BUILT_IN_THEMES
  3. 返回完整列表（内置 + 用户）

读取单个主题：
  1. 如果是内置主题 → 从 BUILT_IN_THEMES 获取
  2. 如果是用户主题 → 读取 DataRoot/themes/{id}.json
  3. 验证 Schema
  4. 返回 ThemeDefinition

保存主题：
  1. 生成/更新 id
  2. 写入 DataRoot/themes/{id}.json
  3. 更新 DataRoot/themes/index.json
  4. 更新 localStorage 缓存

删除主题：
  1. 检查非内置（禁止删除内置）
  2. 删除 DataRoot/themes/{id}.json
  3. 更新 index.json
  4. 如果当前激活的是被删除主题 → 回退到 dark
```

### 4.3 主题加载到运行时

```
用户选择主题 / 应用启动：
  1. 从 localStorage 读取 activeThemeId
  2. 加载对应 ThemeDefinition
  3. 扁平化为 CSS 变量映射表
  4. 注入到 document.documentElement.style
  5. 设置 data-theme = activeThemeId
  6. 设置 data-theme-immersive = immersive.enabled
  7. 持久化 activeThemeId 到 localStorage
```

### 4.4 CSS 变量注入规则

```typescript
function flattenThemeToCSSVars(theme: ThemeDefinition): Record<string, string> {
  const vars: Record<string, string> = {}

  // 颜色变量
  for (const [category, shades] of Object.entries(theme.colors)) {
    for (const [shade, value] of Object.entries(shades)) {
      const key = `--c-${category}${shade === 'base' ? '' : `-${shade}`}`
      vars[key] = value
    }
  }

  // layout 变量
  vars['--window-opacity'] = String(theme.layout.windowOpacity.normal / 100)
  // chat display 变量...

  // 沉浸效果变量（仅当 immersive.enabled）
  if (theme.immersive?.enabled) {
    const im = theme.immersive
    vars['--theme-bg-image'] = `url('${im.wallpaper.image}')`
    vars['--theme-bg-overlay'] = String(1 - im.wallpaper.opacity)
    vars['--theme-panel-opacity'] = String(im.layerOpacity.panel)
    vars['--theme-surface-opacity'] = String(im.layerOpacity.surface)
    vars['--theme-child-opacity'] = String(im.layerOpacity.child)
    vars['--theme-panel-blur'] = `blur(${im.effects.panelBlur}px)`
    // ... 更多效果变量
  }

  return vars
}
```

### 4.5 回退链

```
用户主题 → 合并到 Dark 主题 → CSS var() fallback
  1. 用户主题提供值 → 使用用户值
  2. 用户主题未提供 → 使用 Dark 主题对应值
  3. Dark 主题也未提供 → 使用 CSS var(--x, initial) fallback

实现：主题加载时做深合并
  const merged = deepMerge(DARK_THEME, userTheme)
  const cssVars = flattenThemeToCSSVars(merged)
```

---

## 5. 导入导出方案

### 5.1 导出格式

文件扩展名: `.polaris-theme`
MIME 类型: `application/json`

```json
{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-03T12:00:00Z",
  "theme": {
    "name": "赛博朋克2077",
    "description": "受 Cyberpunk 2077 启发的霓虹主题",
    "author": "user123",
    "version": 1,
    "builtIn": false,
    "colors": {
      "primary": { "base": "255 0 128", "hover": "200 0 100", ... },
      "background": { "base": "10 0 20", ... },
      ...
    },
    "layout": {
      "chatDisplay": { ... },
      "windowOpacity": { ... }
    },
    "immersive": {
      "enabled": true,
      "wallpaper": { ... },
      "layerOpacity": { "panel": 0.55, "surface": 0.50, "child": 0.55 },
      "effects": { ... }
    }
  }
}
```

### 5.2 导出流程

```
用户点击"导出"：
  1. 获取当前主题 ThemeDefinition
  2. 移除内部字段（id, createdAt, updatedAt, builtIn）
  3. 包装为导出格式
  4. 触发文件下载（.polaris-theme）
```

### 5.3 导入流程

```
用户点击"导入" / 拖拽 .polaris-theme 文件：
  1. 读取文件内容
  2. 验证 formatVersion + type
  3. 验证 theme 字段的 Schema
  4. 生成新的 UUID id
  5. 检查 name 是否冲突 → 自动添加 "(2)" 后缀
  6. 写入 DataRoot/themes/{id}.json
  7. 更新 index.json
  8. 刷新主题列表 UI
  9. 提示导入成功
```

### 5.4 导入验证清单

| 检查项 | 失败处理 |
|--------|---------|
| 文件格式不是 JSON | 提示"文件格式错误" |
| formatVersion 不支持 | 提示"版本过低/过高，请更新应用" |
| type 不是 polaris-theme | 提示"不是有效的主题文件" |
| 缺少必填字段 | 提示"主题数据不完整" |
| 颜色值格式错误 | 使用默认值替代并警告 |
| 名称超过 32 字符 | 截断 |
| 与已有主题同名 | 自动添加后缀 |

---

## 6. 修改文件清单

### Phase 0：数据模型 + 存储

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/types/theme.ts` | **新建** | ThemeDefinition 完整类型、Schema 验证 |
| `src/services/themeService.ts` | **新建** | 主题持久化（读写 index.json + 单文件） |
| `src/stores/themeStore.ts` | **重写** | 多主题 store（列表/CRUD/激活/导入导出） |
| `src/data/builtInThemes.ts` | **新建** | 三个内置主题的完整 ThemeDefinition 常量 |
| `src/types/config.ts` | 修改 | 移除 SpiderManThemeConfig 相关字段 |
| `src/stores/configStore.ts` | 修改 | config.theme → config.activeThemeId |

### Phase 1：加载引擎

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/themeEngine.ts` | **新建** | 主题加载器（扁平化 + CSS 变量注入） |
| `src/services/themeMerger.ts` | **新建** | 深合并 + 回退链 |
| `src/main.tsx` | 修改 | 内联脚本改为调用 themeEngine |
| `src/utils/spiderman-theme.ts` | **删除** | 功能合并到 themeEngine |
| `src/index.css` | 修改 | 移除 light/spiderman 的 :root 块 |
| `src/App.css` | 修改 | `[data-theme="spiderman"]` → `[data-theme-immersive="true"]` |
| `src/App.css` | 修改 | `--spiderman-*` → `--theme-*`（兼容旧名） |
| 14 个 tsx 文件 | 修改 | `data-spiderman-panel` → `data-theme-panel` |

### Phase 2：编辑器 UI

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/components/Settings/tabs/ThemeTab.tsx` | **拆分为** | ThemeManager + ThemeEditor |
| `src/components/Theme/ThemeManager.tsx` | **新建** | 主题列表管理（CRUD + 导入导出） |
| `src/components/Theme/ThemeEditor.tsx` | **新建** | 可视化主题编辑（颜色/效果/布局） |
| `src/components/Theme/ColorPicker.tsx` | **新建** | 颜色选择器组件 |
| `src/components/Theme/ThemePreview.tsx` | **新建** | 实时预览面板 |
| `src/components/Theme/LayerOpacityEditor.tsx` | **新建** | 透明度层级编辑器 |
| `src/components/Theme/WallpaperEditor.tsx` | **新建** | 壁纸/背景编辑器 |
| `src/locales/*/settings.json` | 修改 | 添加主题编辑器翻译 |

---

## 7. 完整的实施路线图

```
Phase 0: 数据模型 + 存储（2天）
├── 定义 ThemeDefinition 类型
├── 编写三个内置主题的完整数据
├── 实现 themeService（IndexedDB + JSON 文件）
├── 重写 themeStore（多主题 CRUD）
└── 现有 config 迁移

Phase 1: 加载引擎（3天）
├── 实现 themeEngine（扁平化 + 注入）
├── 实现 themeMerger（深合并 + 回退）
├── 改造 main.tsx 首屏加载
├── 删除 spiderman-theme.ts
├── 改造 index.css / App.css
└── 全局替换 data-spiderman-panel → data-theme-panel

Phase 2: 基础 UI（2天）
├── ThemeManager 主题列表
├── 主题导入/导出
├── 主题激活/删除/重命名
└── 设置页 Tab 调整

Phase 3: 编辑器 UI（3-5天）
├── ThemeEditor 主框架
├── ColorPicker 颜色选择器
├── LayerOpacityEditor 透明度层级
├── WallpaperEditor 壁纸编辑器
├── ThemePreview 实时预览
└── 翻译文件更新

Phase 4: 社区分享（远期，3-5天）
├── 在线主题市场
├── 主题评分/收藏
├── 一键安装
└── 主题分享 URL
```

---

## 8. 与当前工作的关系

### 8.1 当前透明度层级工作

当前正在做的 L0/L1/L2 透明度滑块，是 **Phase 3 编辑器 UI 的一部分**。先按独立功能落地，后续自然融入自定义主题系统的 `layerOpacity` 编辑器。

### 8.2 过渡策略

```
当前 → Phase 0-1 → Phase 2-3 → Phase 4
├── 三主题硬编码 → 数据模型化 → 编辑器可编辑 → 社区分享
├── spiderman 专属 → 引擎通用化 → 编辑器全面 → 主题市场
├── 透明度滑块 → 数据模型已含 → 编辑器内调节 → 模板预设
└── 无导出导入 → 无 → JSON 导入导出 → 在线市场
```

### 8.3 当前工作不冲突

- 透明度滑块的数据模型可直接对应 `immersive.layerOpacity`
- `--spiderman-*` 变量后续通过兼容性注入过渡到 `--theme-*`
- 当前代码改动不会浪费，每个改动都是长期方案的一部分