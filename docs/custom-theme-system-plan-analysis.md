# 自定义主题系统 — 完整规划分析

> 状态：规划分析 v3（2026-08-04）
> 基于：实际代码审计 + 行业最佳实践参考
> 前置文档：`docs/custom-theme-system-plan.md`（v2，数据模型已定义）

---

## 目录

1. [现状分析](#1-现状分析)
2. [用户需求分析](#2-用户需求分析)
3. [设计目标与原则](#3-设计目标与原则)
4. [数据模型设计](#4-数据模型设计)
5. [存储架构](#5-存储架构)
6. [主题引擎设计](#6-主题引擎设计)
7. [CSS 架构改造](#7-css-架构改造)
8. [UI 组件设计](#8-ui-组件设计)
9. [完整文件影响清单](#9-完整文件影响清单)
10. [实施路线图](#10-实施路线图)
11. [风险与注意事项](#11-风险与注意事项)
12. [附录：关键设计决策](#12-附录关键设计决策)

---

## 1. 现状分析

### 1.1 当前架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    当前主题架构（三主题硬编码）                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  main.tsx ──→ 读 localStorage('theme') → 写 data-theme       │
│                                                              │
│  themeStore (Zustand)                                        │
│  ├─ Theme = 'dark' | 'light' | 'spiderman' (字面量联合类型)  │
│  ├─ applyTheme()  → data-theme + localStorage + state        │
│  └─ setTheme()    → 同上 + configStore.updateConfigPatch()   │
│                                                              │
│  configStore                                                 │
│  ├─ config.theme: Theme                                      │
│  └─ config.spidermanTheme: SpiderManThemeConfig              │
│                                                              │
│  index.css (CSS 变量定义)                                    │
│  ├─ :root .................................. 30+ 颜色变量     │
│  ├─ :root[data-theme="light"] .......... 30+ 颜色变量覆盖    │
│  ├─ :root[data-theme="spiderman"] .... 30+ 颜色变量覆盖      │
│  └─ :root[data-theme="spiderman"] .... 13+ 沉浸效果变量      │
│                                                              │
│  App.css (沉浸样式)                                          │
│  └─ [data-theme="spiderman"] .......... 30+ CSS 规则         │
│                                                              │
│  spiderman-theme.ts (工具函数)                                │
│  ├─ syncSpiderManCssVarsToDom() — 13 个 CSS 变量同步         │
│  ├─ detectImageBrightness() — 32x32 canvas 亮度检测          │
│  └─ computeAdaptiveOverlay() — 自适应遮罩计算                │
│                                                              │
│  ThemeTab.tsx (设置面板)                                      │
│  ├─ 外观主题选择（3 按钮）                                    │
│  ├─ Spider-Man 沉浸设置（7 滑块 + 位置 + 头像 + 背景）       │
│  ├─ 对话显示设置（5 滑块 + 密度预设）                         │
│  └─ 窗口透明度（2 滑块）                                     │
│                                                              │
│  消费方:                                                    │
│  ├─ mermaid-config.ts  → dark/light 双主题                   │
│  ├─ TerminalPanel.tsx  → dark/light 双主题                   │
│  └─ 10 个组件 × data-spiderman-panel 属性                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 三个主题的 CSS 变量对比

| 变量 | Dark | Light | Spider-Man |
|------|------|-------|------------|
| `--c-primary` | 59 130 246 (蓝) | 37 99 235 (蓝) | 220 38 38 (红) |
| `--c-bg-base` | 0 0 0 (纯黑) | 250 250 252 (浅灰) | 0 0 0 (纯黑) |
| `--c-bg-elevated` | 26 26 31 | 255 255 255 | 8 8 10 |
| `--c-bg-surface` | 37 37 43 | 241 245 249 | 14 14 18 |
| `--c-border` | 255 255 255 | 15 23 42 | 220 38 38 (红) |
| `--c-text-primary` | 248 248 248 | 15 23 42 | 248 248 248 |
| `--c-accent-ai` | 167 139 250 (紫) | 124 58 237 (紫) | 59 130 246 (蓝) |
| 沉浸效果 | 无 | 无 | 壁纸+遮罩+面板透明+磨砂+蛛网+光晕 |

### 1.3 当前存在的问题

| 编号 | 问题 | 严重程度 | 影响范围 |
|------|------|---------|---------|
| P1 | **主题数量硬编码**：Theme 类型只允许三个字面量，无法扩展 | 高 | 类型系统 + 所有 switch 分支 |
| P2 | **Spider-Man 专属逻辑溢出**：spiderman-theme.ts 的同步逻辑、App.css 的 30+ 条规则都绑死在 'spiderman' 一个主题名上 | 高 | CSS + JS 工具函数 |
| P3 | **CSS 选择器耦合**：`[data-theme="spiderman"]` 出现在 40+ 处，`data-spiderman-panel` 出现在 14 处 | 高 | CSS + 组件 |
| P4 | **配置存储分散**：theme 在 config 里，spidermanTheme 单独存，localStorage 有一份缓存 | 中 | 存储一致性 |
| P5 | **无自定义主题能力**：用户不能基于现有主题创建变体 | 中 | 用户需求 |
| P6 | **无导入导出**：无法分享或备份主题配置 | 中 | 用户需求 |
| P7 | **无可视化颜色编辑**：改颜色需要手写 CSS 变量 | 低 | 用户体验 |
| P8 | **Mermaid/终端主题硬编码**：`getMermaidConfig()` 用的是独立硬编码值，不跟随 CSS 变量 | 中 | 一致性 |

---

## 2. 用户需求分析

### 2.1 核心用户场景

| 场景 | 用户 | 描述 |
|------|------|------|
| S1 | 普通用户 | 现有的三个主题已经足够，但希望能微调颜色（如 accent 色） |
| S2 | 进阶用户 | 想要一个"暗红"主题，基于 dark 但把蓝色 accent 改成红色 |
| S3 | 自定义用户 | 想创建自己的完整主题，从壁纸到面板透明度到颜色全部自定义 |
| S4 | 分享者 | 想把自己调好的主题导出分享给社区/朋友 |
| S5 | 导入者 | 下载了别人分享的主题，想一键导入使用 |
| S6 | 管理用户 | 有多个主题，想快速切换，不需要的删掉 |

### 2.2 功能需求矩阵

| 功能 | S1 | S2 | S3 | S4 | S5 | S6 | 优先级 |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:------:|
| 三主题保留且可切换 | ✓ | ✓ | ✓ | | | ✓ | P0 |
| 基于现有主题复制新增 | | ✓ | ✓ | | | | P0 |
| 修改颜色值 | ✓ | ✓ | ✓ | | | | P0 |
| 修改沉浸效果 | | | ✓ | | | | P0 |
| 重命名/删除主题 | | | | | | ✓ | P1 |
| 导出主题 | | | ✓ | ✓ | | | P1 |
| 导入主题 | | | | | ✓ | | P1 |
| 可视化颜色编辑器（色轮） | ✓ | ✓ | ✓ | | | | P1 |
| 实时预览 | ✓ | ✓ | ✓ | | | | P1 |
| 社区主题市场 | | | | ✓ | ✓ | | P2 |
| 主题快捷键切换 | | | | | | ✓ | P2 |

### 2.3 行业参考对比

| 系统 | 核心设计 | 可借鉴点 |
|------|---------|---------|
| **VS Code** | JSON 定义 + 发布到市场 | 主题 = 颜色值集合，扁平化注入 |
| **Obsidian** | CSS 变量 + 主题商店 | 内置主题不可删，用户可叠加 CSS Snippets |
| **Material Design 3** | 动态颜色 + 主题 Builder | 从种子色自动生成完整调色板 |
| **shadcn/ui** | CSS 变量 + 可视化编辑器 | 简洁的变量命名，实时预览 |
| **JetBrains IDE** | .icls 文件 + 导入导出 | 基于 XML 的完整主题定义 + 分享 |
| **Discord** | 主题 + 透明度 + 自定义 CSS | 分层透明度控制 |

---

## 3. 设计目标与原则

### 3.1 核心设计哲学

> **三个内置主题（dark/light/spiderman）就是自定义主题系统的三个内置预设。**
> 用户不应被限制在预设中，而是可以像管理文件一样管理主题。

### 3.2 设计原则

1. **同构原则**：内置主题与用户主题在数据结构上完全一致。内置主题只是 `builtIn: true` 的标志位不同。
2. **渐进增强**：从"简单切换"到"微调颜色"到"完整编辑"，逐步开放能力。
3. **向后兼容**：现有 `config.theme` 字段在过渡期兼容，旧 `spidermanTheme` 数据自动迁移。
4. **零成本抽象**：用户不使用自定义主题时，不产生额外存储/计算开销。
5. **可分享**：主题定义 = JSON 文件，天然可分享、可版本控制。
6. **无侵入回退**：任何 CSS 变量缺失时，CSS `var()` fallback 保证显示不出错。

### 3.3 与现有规划文档的关系

现有 `docs/custom-theme-system-plan.md` 已经定义了：
- 数据模型 `ThemeDefinition`（v2 版本）
- 存储架构（DataRoot/themes/）
- 导入导出格式（`.polaris-theme`）
- 基本实施阶段

本分析在此基础上，补充：
- 完整的代码审计结果（精确到行号的文件影响清单）
- 行业参考对比
- 渲染引擎与 CSS 注入的详细设计
- 编辑器 UI 的功能分解
- 风险分析与迁移策略
- 更细化的任务拆解

---

## 4. 数据模型设计

### 4.1 ThemeDefinition（完整版）

```typescript
// src/types/theme.ts

/** 主题唯一标识 */
type ThemeId = string; // UUID v4，内置主题用固定 ID

/** 主题定义 — 内置与用户主题共用此结构 */
interface ThemeDefinition {
  // ============ 元数据 ============
  id: ThemeId;
  name: string;                    // 1-32 字符
  description?: string;            // 可选描述
  author?: string;                 // 作者（导出时填充）
  version: number;                 // 数据格式版本，当前 = 1
  builtIn: boolean;                // 内置主题（不可删除/改名/导出）
  createdAt: string;               // ISO 8601
  updatedAt: string;               // ISO 8601

  // ============ 颜色系统 ============
  // 所有值存储为 RGB 三元组字符串（如 "59 130 246"）
  // 与现有 --c-* 变量格式完全一致
  colors: {
    primary: {
      base: string;        // 主色
      hover: string;       // 悬停
      '50': string;        // 浅色阶
      '100': string;
      '200': string;
      '300': string;
      '400': string;
      '500': string;
      '600': string;
      '700': string;       // 深色阶
    };
    background: {
      base: string;        // 最底层
      elevated: string;    // 面板层
      surface: string;     // 内容层
      hover: string;       // 悬停态
      active: string;      // 激活态
      tertiary: string;    // 第三级
      secondary: string;   // 第二级
    };
    border: {
      base: string;        // 边框基础色
    };
    text: {
      primary: string;
      secondary: string;
      tertiary: string;
      muted: string;
    };
    status: {
      warning: string;
      success: string;
      danger: string;
      info: string;
      done: string;
      failed: string;
      neutral: string;
    };
    priority: {
      low: string;
      normal: string;
      high: string;
      urgent: string;
    };
    accent: {
      ai: string;
      prototype: string;
      workspace: string;
    };
    misc: {
      overlay: string;     // 模态遮罩色
      onPrimary: string;   // 主色按钮文字色
      canvas: string;      // 画布底色
      tagBg: string;       // 标签背景
      shadow: string;      // 阴影色
    };
  };

  // ============ 界面布局 ============
  layout: {
    chatDisplay: ChatDisplaySettings;  // 复用现有类型
    windowOpacity: {
      normal: number;       // 0-100
      compact: number;      // 0-100
    };
  };

  // ============ 沉浸效果（可选） ============
  // 非沉浸主题可省略此字段
  immersive?: {
    enabled: boolean;       // 是否启用沉浸效果

    wallpaper: {
      type: 'image' | 'gradient' | 'solid' | 'none';
      image?: string;       // URL 或 data URI（type=image 时必填）
      gradient?: string;    // CSS gradient 字符串（type=gradient 时必填）
      solidColor?: string;  // RGB 三元组（type=solid 时必填）
      opacity: number;      // 0-1，背景可见度
      positionX: number;    // 0-100
      positionY: number;    // 0-100
      size: 'cover' | 'contain' | string;
    };

    layerOpacity: {
      panel: number;        // 面板层透明度（原 panelOpacity）
      surface: number;      // 内容层透明度（原 surfaceOpacity）
      child: number;        // 子元素层透明度（原 chatToolOpacity）
    };

    effects: {
      panelBlur: number;    // 0-32 px
      webTexture: number;   // 0-1，蛛网纹理强度
      blueAccent: number;   // 0-1，蓝色强调强度
      hoverOpacity: number; // 0-1，悬停态背景透明度
    };

    avatar?: {
      url: string;          // 面具头像 URL 或 data URI
    };
  };
}
```

### 4.2 内置主题 ID 规划

| 主题 | ID | 说明 |
|------|----|------|
| Dark | `00000000-0000-0000-0000-000000000001` | 默认主题，不可删除 |
| Light | `00000000-0000-0000-0000-000000000002` | 浅色主题，不可删除 |
| Spider-Man | `00000000-0000-0000-0000-000000000003` | 沉浸主题，不可删除 |

### 4.3 导出格式（`.polaris-theme`）

```json
{
  "formatVersion": 1,
  "type": "polaris-theme",
  "exportedAt": "2026-08-04T12:00:00Z",
  "theme": {
    "name": "赛博朋克2077",
    "description": "受 Cyberpunk 2077 启发的霓虹主题",
    "author": "user123",
    "version": 1,
    "colors": { /* 完整 colors */ },
    "layout": { /* 完整 layout */ },
    "immersive": { /* 完整 immersive */ }
  }
}
```

导出时排除：`id`, `builtIn`, `createdAt`, `updatedAt`（导入时重新生成）
导入时自动处理：同名冲突加后缀、Schema 验证、版本兼容

### 4.4 Config 改造

```typescript
// Before
interface Config {
  theme?: 'dark' | 'light' | 'spiderman';
  spidermanTheme?: SpiderManThemeConfig;
  window?: WindowSettings;
  chatDisplay?: ChatDisplaySettings;
}

// After
interface Config {
  activeThemeId?: string;                // 改为 ID 引用，默认 'dark'
  // spidermanTheme 移除 — 数据已并入 ThemeDefinition
  // theme 字段保留兼容（读取时自动迁移到 activeThemeId）
  window?: WindowSettings;
  chatDisplay?: ChatDisplaySettings;
}
```

### 4.5 数据迁移逻辑

```typescript
function migrateLegacyConfig(config: LegacyConfig): Config {
  // 1. 如果 activeThemeId 已存在 → 无需迁移
  if (config.activeThemeId) return config;

  // 2. 旧 theme 字段 → activeThemeId
  const themeId = {
    'dark': '00000000-0000-0000-0000-000000000001',
    'light': '00000000-0000-0000-0000-000000000002',
    'spiderman': '00000000-0000-0000-0000-000000000003',
  }[config.theme ?? 'dark'];

  // 3. 旧 spidermanTheme → 合并到内置 spiderman 主题定义
  if (config.spidermanTheme) {
    mergeIntoSpidermanDefinition(config.spidermanTheme);
  }

  return { ...config, activeThemeId: themeId };
}
```

---

## 5. 存储架构

### 5.1 存储布局

```
localStorage（首屏快速读取）
├── activeThemeId: string          ← 当前激活的主题 ID
└── themeListCache: string[]       ← 主题 ID 列表缓存（用于快速列出）

DataRoot/themes/（主存储，持久化）
├── index.json                     ← 主题索引文件
│   {
│     "version": 1,
│     "themes": [
│       { "id": "00000000-...", "name": "Dark", "builtIn": true },
│       { "id": "00000000-...", "name": "Light", "builtIn": true },
│       { "id": "00000000-...", "name": "Spider-Man", "builtIn": true },
│       { "id": "a1b2c3d4-...", "name": "赛博朋克2077", "builtIn": false }
│     ]
│   }
│
├── a1b2c3d4-....json              ← 用户自定义主题
│   { "id": "a1b2c3d4-...", "name": "赛博朋克2077", ... }
└── ...

内置主题（代码内硬编码常量）
└── BUILT_IN_THEMES: ThemeDefinition[]  ← 不写入磁盘
```

### 5.2 读写流程

```
读取主题列表：
  1. 读取 DataRoot/themes/index.json → 主题索引
  2. 合并内置主题 BUILT_IN_THEMES
  3. 返回完整列表（内置 + 用户）

读取单个主题定义：
  1. 如果是内置主题 → 从 BUILT_IN_THEMES 常量获取
  2. 如果是用户主题 → 读取 DataRoot/themes/{id}.json
  3. 验证 Schema
  4. 返回 ThemeDefinition

保存/更新主题：
  1. 生成/更新 id（新建时生成 UUID）
  2. 写入 DataRoot/themes/{id}.json
  3. 更新 DataRoot/themes/index.json
  4. 更新 localStorage 缓存

删除主题：
  1. 检查非内置（禁止删除内置主题）
  2. 删除 DataRoot/themes/{id}.json
  3. 更新 index.json
  4. 如果当前激活的是被删除主题 → 回退到 dark

激活主题：
  1. 写入 localStorage('activeThemeId', id)
  2. 更新 config.activeThemeId（服务端持久化）
  3. 触发 themeEngine 加载/注入 CSS 变量
```

### 5.3 服务端持久化

```rust
// config.rs
pub struct Config {
    // 旧字段保留兼容（读取时自动迁移）
    pub theme: Option<String>,                    // @deprecated
    pub spiderman_theme: Option<SpiderManThemeConfig>,  // @deprecated

    // 新字段
    pub active_theme_id: Option<String>,           // UUID
}
```

**迁移策略：**
- 服务端读取时，检查 `active_theme_id` 是否存在
- 不存在则从 `theme` 字段迁移
- 自定义主题的持久化直接通过 themeService 文件操作，不经过 config

---

## 6. 主题引擎设计

### 6.1 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    themeEngine（核心引擎）                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  loadTheme(themeId) → ThemeDefinition                        │
│  ├─ 从 store 获取 ThemeDefinition                            │
│  └─ 返回完整主题定义                                          │
│                                                              │
│  flattenTheme(theme, baseTheme) → CSSVarMap                  │
│  ├─ 深合并到 baseTheme（默认 dark）                          │
│  ├─ 扁平化所有字段为 CSS 变量键值对                           │
│  └─ 返回 Record<string, string>                              │
│                                                              │
│  injectCSSVars(vars) → void                                  │
│  ├─ 写入 document.documentElement.style                      │
│  ├─ 设置 data-theme = activeThemeId                          │
│  ├─ 设置 data-theme-immersive = immersive.enabled            │
│  └─ 兼容旧名（--spiderman-* 同时注入）                      │
│                                                              │
│  applyTheme(themeId) → void                                  │
│  ├─ 加载 → 扁平化 → 注入 → 持久化                           │
│  └─ 支持亮度检测 + 自适应遮罩                                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 扁平化映射规则

```typescript
function flattenTheme(theme: ThemeDefinition): Record<string, string> {
  const vars: Record<string, string> = {};

  // 1. 颜色变量
  // colors.primary.base         → --c-primary: "59 130 246"
  // colors.primary.hover        → --c-primary-hover: "37 99 235"
  // colors.background.base      → --c-bg-base: "0 0 0"
  // colors.background.elevated  → --c-bg-elevated: "26 26 31"
  // colors.text.primary         → --c-text-primary: "248 248 248"
  // colors.status.warning       → --c-status-warning: "251 191 36"
  // colors.accent.ai            → --c-accent-ai: "167 139 250"
  // colors.misc.overlay         → --c-overlay: "0 0 0"
  for (const [category, shades] of Object.entries(theme.colors)) {
    for (const [shade, value] of Object.entries(shades)) {
      const key = `--c-${category}${shade === 'base' ? '' : `-${shade}`}`;
      vars[key] = value;
    }
  }

  // 2. 布局变量
  vars['--window-opacity'] = String(theme.layout.windowOpacity.normal / 100);

  // 3. 沉浸效果变量（仅当 immersive.enabled）
  if (theme.immersive?.enabled) {
    const im = theme.immersive;

    // 壁纸
    if (im.wallpaper.type === 'image' && im.wallpaper.image) {
      vars['--theme-bg-image'] = `url('${im.wallpaper.image}')`;
      vars['--theme-bg-overlay'] = String(1 - im.wallpaper.opacity);
      vars['--theme-bg-position'] = `${im.wallpaper.positionX}% ${im.wallpaper.positionY}%`;
      vars['--theme-bg-size'] = im.wallpaper.size;
    } else if (im.wallpaper.type === 'solid' && im.wallpaper.solidColor) {
      vars['--theme-bg-solid'] = im.wallpaper.solidColor;
    } else if (im.wallpaper.type === 'none') {
      // 无背景：纯色基底
    }

    // 透明度层级
    vars['--theme-panel-opacity'] = String(im.layerOpacity.panel);
    vars['--theme-surface-opacity'] = String(im.layerOpacity.surface);
    vars['--theme-child-opacity'] = String(im.layerOpacity.child);

    // 效果
    vars['--theme-panel-blur'] = im.effects.panelBlur > 0
      ? `blur(${im.effects.panelBlur}px)`
      : 'none';
    vars['--theme-web-opacity'] = String(im.effects.webTexture);
    vars['--theme-blue-accent'] = String(im.effects.blueAccent);
    vars['--theme-hover-opacity'] = String(im.effects.hoverOpacity);

    // 头像
    if (im.avatar?.url) {
      vars['--theme-avatar-url'] = `url('${im.avatar.url}')`;
    }
  }

  // 4. 兼容旧名（过渡期后移除）
  // --spiderman-* 同时注入，确保旧选择器生效
  if (theme.immersive?.enabled) {
    vars['--spiderman-bg-image'] = vars['--theme-bg-image'] ?? '';
    vars['--spiderman-bg-overlay'] = vars['--theme-bg-overlay'] ?? '0.8';
    vars['--spiderman-panel-opacity'] = vars['--theme-panel-opacity'] ?? '0.55';
    vars['--spiderman-panel-blur'] = vars['--theme-panel-blur'] ?? 'none';
    vars['--spiderman-surface-opacity'] = vars['--theme-surface-opacity'] ?? '0.27';
    // ... 其余兼容变量
  }

  return vars;
}
```

### 6.3 回退链

```
用户主题 → 合并到 Dark 主题 → CSS var() fallback

1. 用户主题提供值 → 使用用户值
2. 用户主题未提供 → 使用 Dark 主题对应值
3. Dark 主题也未提供 → 使用 CSS var(--x, initial) fallback

实现：主题加载时做深合并
  const merged = deepMerge(DARK_THEME, userTheme)
  const cssVars = flattenTheme(merged)
```

### 6.4 自适应遮罩逻辑（迁移保留）

从 `spiderman-theme.ts` 迁移到 `themeEngine.ts`：

```typescript
// 保留的核心逻辑
function computeAdaptiveOverlay(userOpacity: number, imageBrightness: number | null): number {
  const userOverlay = 1 - userOpacity;
  if (imageBrightness === null) return userOverlay;
  const minOverlay = 0.15 + (imageBrightness / 255) * 0.5;
  return Math.max(userOverlay, Math.min(minOverlay, 0.95));
}
```

### 6.5 加载流程

```
用户选择主题 / 应用启动：
  1. 从 localStorage 读取 activeThemeId
  2. 通过 themeService 加载对应 ThemeDefinition
  3. 深合并到 DARK_THEME（回退链）
  4. 扁平化为 CSS 变量映射表
  5. 注入到 document.documentElement.style
  6. 设置 data-theme = activeThemeId
  7. 设置 data-theme-immersive = immersive.enabled
  8. 如果是沉浸主题且含壁纸 → 异步检测亮度 → 更新遮罩
  9. 持久化 activeThemeId 到 localStorage
```

---

## 7. CSS 架构改造

### 7.1 index.css 改造

```css
/* Before: 三块独立 CSS 变量定义 */
:root { /* dark 颜色变量 */ }
:root[data-theme="light"] { /* light 颜色变量覆盖 */ }
:root[data-theme="spiderman"] { /* spiderman 颜色变量 + 沉浸效果变量 */ }

/* After: 保留 :root 作为回退默认，移除 light/spiderman 块 */
:root {
  color-scheme: dark;
  --window-opacity: 1.0;
  /* 只保留 dark 主题作为回退默认 */
  --c-primary: 59 130 246;
  /* ... 其余 dark 颜色变量 ... */
}

/* 沉浸效果变量默认值（仅占位，避免未定义） */
:root {
  --theme-bg-image: none;
  --theme-bg-overlay: 0.8;
  --theme-panel-opacity: 1;
  --theme-panel-blur: none;
  --theme-surface-opacity: 1;
  --theme-web-opacity: 0;
  --theme-hover-opacity: 1;
  --theme-blue-accent: 0.5;
}
```

### 7.2 App.css 改造

```css
/* Before: 所有沉浸样式绑定 [data-theme="spiderman"] */
[data-theme="spiderman"] .theme-root { ... }

/* After: 改为 [data-theme-immersive="true"] */
[data-theme-immersive="true"] .theme-root {
  isolation: isolate;
  background-color: transparent !important;
  backdrop-filter: var(--theme-panel-blur, none);
}

[data-theme-immersive="true"] .theme-web-texture {
  display: block;
  opacity: var(--theme-web-opacity, 0);
}

/* 面板透明：data-spiderman-panel → data-theme-panel */
[data-theme-immersive="true"] [data-theme-panel] {
  background-color: rgb(var(--c-bg-elevated) / var(--theme-panel-opacity, 1)) !important;
}
```

### 7.3 变量名迁移对照表

| 旧变量名 | 新变量名 | 用途 |
|---------|---------|------|
| `--spiderman-bg-image` | `--theme-bg-image` | 壁纸图片 |
| `--spiderman-bg-overlay` | `--theme-bg-overlay` | 壁纸遮罩 |
| `--spiderman-bg-position` | `--theme-bg-position` | 背景定位 |
| `--spiderman-bg-size` | `--theme-bg-size` | 背景缩放 |
| `--spiderman-panel-opacity` | `--theme-panel-opacity` | 面板透明度 |
| `--spiderman-panel-blur` | `--theme-panel-blur` | 面板磨砂 |
| `--spiderman-surface-opacity` | `--theme-surface-opacity` | 内容层透明度 |
| `--spiderman-child-opacity` | `--theme-child-opacity` | 子内容层透明度 |
| `--spiderman-web-opacity` | `--theme-web-opacity` | 蛛网纹理 |
| `--spiderman-hover-opacity` | `--theme-hover-opacity` | 悬停背景 |
| `--spiderman-blue-accent` | `--theme-blue-accent` | 蓝色强调 |
| `--spiderman-avatar-url` | `--theme-avatar-url` | 面具头像 |

### 7.4 属性名迁移

| 旧属性 | 新属性 | 用途 |
|-------|-------|------|
| `data-spiderman-panel` | `data-theme-panel` | 标记面板元素 |
| `data-spiderman-blur` | `data-theme-panel` 隐式继承 | 标记模糊父级 |
| `data-spiderman-bg-off` | `data-theme-bg-off` | 标记背景关闭 |

### 7.5 过渡期兼容方案

在 `flattenTheme()` 中，同时注入新变量名和旧变量名：

```typescript
// 过渡期：新名 + 旧名同时注入
if (theme.immersive?.enabled) {
  // 新名
  vars['--theme-bg-image'] = ...;
  vars['--theme-panel-opacity'] = ...;
  // 旧名（兼容）
  vars['--spiderman-bg-image'] = vars['--theme-bg-image'];
  vars['--spiderman-panel-opacity'] = vars['--theme-panel-opacity'];
}
```

过渡期后（所有 CSS 选择器迁移完成），移除旧名注入。

---

## 8. UI 组件设计

### 8.1 组件树

```
Settings
└── ThemeTab (重构)
    ├── ThemeManager (新建) ← 主题列表管理
    │   ├── 主题列表（卡片式）
    │   ├── 激活/删除/重命名
    │   ├── 复制新增
    │   ├── 导入按钮
    │   └── 导出按钮
    │
    ├── ThemeEditor (新建) ← 主题编辑
    │   ├── 基本信息（名称、描述）
    │   ├── ColorEditor (新建) ← 颜色编辑
    │   │   ├── 色组分类（Primary/Background/Text/Status/Accent）
    │   │   └── 颜色选择器（react-colorful 或原生 input:color）
    │   ├── LayoutEditor (新建) ← 布局编辑
    │   │   ├── ChatDisplay 设置（复用现有滑块）
    │   │   └── WindowOpacity 设置
    │   ├── ImmersiveEditor (新建) ← 沉浸效果编辑
    │   │   ├── WallpaperEditor（背景类型/图片/位置/缩放）
    │   │   ├── LayerOpacityEditor（面板/内容/子内容透明度）
    │   │   └── EffectsEditor（磨砂/蛛网/蓝色强调/悬停）
    │   └── ThemePreview (新建) ← 实时预览
    │
    ├── ChatDisplay 设置（保留现有）
    └── WindowOpacity 设置（保留现有）
```

### 8.2 ThemeManager 设计

```
┌─────────────────────────────────────────────────┐
│ 主题管理                                    [+] 导入 │
├─────────────────────────────────────────────────┤
│                                                 │
│ ┌─── 当前：Dark ───────────────────────────────┐ │
│ │ 🌙 Dark                         内置  ● 使用中 │ │
│ │ 默认暗色主题                                  │ │
│ │                              [复制] [导出]     │ │
│ └──────────────────────────────────────────────┘ │
│                                                 │
│ ┌─── Light ────────────────────────────────────┐ │
│ │ ☀️ Light                        内置          │ │
│ │ 浅色主题                                      │ │
│ │                              [复制] [使用]     │ │
│ └──────────────────────────────────────────────┘ │
│                                                 │
│ ┌─── Spider-Man ───────────────────────────────┐ │
│ │ 🕷️ Spider-Man                   内置          │ │
│ │ 沉浸式主题（壁纸/面板透明/磨砂）               │ │
│ │                              [复制] [使用]     │ │
│ └──────────────────────────────────────────────┘ │
│                                                 │
│ ┌─── 赛博朋克2077 ────────────────────────────┐ │
│ │ 🌆 赛博朋克2077                 自定义        │ │
│ │ 霓虹粉蓝配色                                  │ │
│ │          [编辑] [复制] [导出] [删除] [使用]     │ │
│ └──────────────────────────────────────────────┘ │
│                                                 │
│                                    [+ 新建主题]  │
└─────────────────────────────────────────────────┘
```

### 8.3 ThemeEditor 设计

```
┌─────────────────────────────────────────────────────┐
│ 编辑主题：赛博朋克2077                          [保存] │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ┌─ 基本信息 ──────────────────────────────────┐     │
│ │ 名称: [赛博朋克2077                     ]    │     │
│ │ 描述: [霓虹粉蓝配色                      ]    │     │
│ └──────────────────────────────────────────────┘     │
│                                                     │
│ ┌─ 颜色 ──────────────────────────────────────┐     │
│ │ Primary:  ● 主色 [███]  hover [███]         │     │
│ │ Background: base [███] elevated [███] ...   │     │
│ │ Text: primary [███] secondary [███] ...     │     │
│ │ Status: warning [███] success [███] ...     │     │
│ │ Accent: ai [███] prototype [███] ...        │     │
│ │                                   [展开全部] │     │
│ └──────────────────────────────────────────────┘     │
│                                                     │
│ ┌─ 沉浸效果 ──────────────────────────────────┐     │
│ │ [✓] 启用沉浸效果                              │     │
│ │ 背景类型: [● 图片 ○ 渐变 ○ 纯色 ○ 关闭]      │     │
│ │ 壁纸: [选择图片] [上传]                       │     │
│ │ 透明度: [═══════●═══════] 80%                │     │
│ │ 位置: 水平 [══════●════════] 70%              │     │
│ │       垂直 [══════●════════] 50%              │     │
│ │ 磨砂: [════●═══════════════] 8px             │     │
│ │ 蛛网: [════●═══════════════] 15%             │     │
│ │ 蓝色: [══════●═════════════] 50%             │     │
│ │ 面板: [══════════●═════════] 55%             │     │
│ │ 内容: [══════════●═════════] 50%             │     │
│ └──────────────────────────────────────────────┘     │
│                                                     │
│ ┌─ 实时预览 ──────────────────────────────────┐     │
│ │  ┌──────────────────────────────────────┐   │     │
│ │  │ [预览区域 - 微缩应用界面]              │   │     │
│ │  │                                      │   │     │
│ │  │ 你好，我是 Polaris                    │   │     │
│ │  │                                      │   │     │
│ │  │ 这是一条 AI 回复消息                    │   │     │
│ │  └──────────────────────────────────────┘   │     │
│ └──────────────────────────────────────────────┘     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 8.4 颜色选择器组件

```
ColorPicker 组件接口：
  ┌───────────────────────┐
  │ 当前: [████████████]  │
  │ RGB: [59] [130] [246] │
  │ HEX: [#3B82F6   ]    │
  │ ┌─── 色盘 ─────────┐  │
  │ │                  │  │
  │ │   ●              │  │
  │ │                  │  │
  │ └──────────────────┘  │
  │ 亮度: [══════●══════] │
  │ 预设: [██] [██] [██]  │
  │       [██] [██] [██]  │
  └───────────────────────┘
```

技术选型：`react-colorful`（2.9KB gzipped，支持受控模式，TypeScript 友好）

---

## 9. 完整文件影响清单

### 9.1 新建文件

| 文件 | 用途 | 预估行数 |
|------|------|---------|
| `src/types/theme.ts` | ThemeDefinition 类型定义 + Schema 验证 | ~150 |
| `src/data/builtInThemes.ts` | 三个内置主题的完整 ThemeDefinition 常量 | ~200 |
| `src/services/themeService.ts` | 主题持久化（读/写 DataRoot/themes/） | ~200 |
| `src/services/themeEngine.ts` | 主题加载器（扁平化 + CSS 变量注入 + 亮度检测） | ~250 |
| `src/services/themeMerger.ts` | 深合并 + 回退链 | ~80 |
| `src/components/Theme/ThemeManager.tsx` | 主题列表管理 | ~200 |
| `src/components/Theme/ThemeEditor.tsx` | 可视化主题编辑主框架 | ~300 |
| `src/components/Theme/ColorPicker.tsx` | 颜色选择器组件 | ~150 |
| `src/components/Theme/ColorEditor.tsx` | 颜色分组编辑 | ~200 |
| `src/components/Theme/ThemePreview.tsx` | 实时预览面板 | ~200 |
| `src/components/Theme/ImmersiveEditor.tsx` | 沉浸效果编辑器 | ~250 |
| `src/components/Theme/LayerOpacityEditor.tsx` | 透明度层级编辑器 | ~100 |
| `src/components/Theme/WallpaperEditor.tsx` | 壁纸/背景编辑器 | ~150 |

**新建合计：~2230 行**

### 9.2 重写文件

| 文件 | 改造内容 | 难度 |
|------|---------|------|
| `src/stores/themeStore.ts` | 从单主题切换 → 多主题 CRUD Store | ★★★ |
| `src/components/Settings/tabs/ThemeTab.tsx` | 拆分为 ThemeManager + ThemeEditor + 保留 ChatDisplay | ★★★ |

### 9.3 修改文件

| 文件 | 改造内容 | 数量 |
|------|---------|------|
| `src/main.tsx` | 首屏 inline script 改为调用 themeEngine | 1 处 |
| `src/index.css` | 移除 `:root[data-theme="light"]` 和 `:root[data-theme="spiderman"]` 块 | 2 块 |
| `src/App.css` | `[data-theme="spiderman"]` → `[data-theme-immersive="true"]`，`--spiderman-*` → `--theme-*` | ~40 处 |
| `src/types/config.ts` | 移除 `SpiderManThemeConfig` 接口，`Theme` 类型改为 `string`，Config 改为 `activeThemeId` | 3 处 |
| `src/stores/configStore.ts` | spidermanTheme 同步逻辑移除，theme 同步改为 activeThemeId | 3 处 |
| `src/utils/mermaid-config.ts` | `getMermaidConfig` 改为从 CSS 变量读取或主题映射 | 1 处 |
| `src/utils/spiderman-theme.ts` | **删除**，功能合并到 themeEngine | 删除 |
| `src-tauri/src/models/config.rs` | `SpiderManThemeConfig` 结构体标记 deprecated，添加 `active_theme_id` | 2 处 |

### 9.4 组件属性替换

| 文件 | 行数 | 替换内容 |
|------|------|---------|
| `src/components/Common/Layout.tsx` | 4 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Common/Layout.tsx` | 2 | `data-spiderman-blur` → 移除（由 .theme-root 统一处理） |
| `src/components/Layout/LeftPanel.tsx` | 2 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Layout/RightPanel.tsx` | 2 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Layout/ActivityBar.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/TopMenuBar/index.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Chat/ChatInput.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Settings/SettingsPage.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Settings/SettingsSidebar.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Browser/BrowserPanel.tsx` | 2 | `data-spiderman-panel` → `data-theme-panel` |
| `src/components/Browser/BrowserSidebarPanel.tsx` | 1 | `data-spiderman-panel` → `data-theme-panel` |

**组件替换合计：14 处**

### 9.5 翻译文件

| 文件 | 改造内容 |
|------|---------|
| `src/locales/zh-CN/settings.json` | 添加主题编辑器相关翻译键 |
| `src/locales/en-US/settings.json` | 添加主题编辑器相关翻译键 |

---

## 10. 实施路线图

### Phase 0：数据模型 + 存储（~2 天）

```
目标：建立完整的数据模型和持久化能力，但不影响现有功能

文件清单：
  [+] src/types/theme.ts              — ThemeDefinition 类型
  [+] src/data/builtInThemes.ts       — 三个内置主题常量
  [+] src/services/themeService.ts    — 主题持久化服务
  [R] src/stores/themeStore.ts        — 重写为多主题 CRUD Store
  [M] src/types/config.ts             — 添加 activeThemeId 字段（保留旧字段兼容）
  [M] src-tauri/src/models/config.rs  — 添加 active_theme_id 字段

测试验证：
  ✓ ThemeDefinition 类型定义完整
  ✓ 三个内置主题数据正确
  ✓ themeService 读写 DataRoot/themes/ 正常
  ✓ 多主题 CRUD 操作正常
  ✓ 旧 config 迁移逻辑正确
  ✓ cargo check --lib 通过
```

### Phase 1：加载引擎 + CSS 通用化（~3 天）

```
目标：主题从 CSS 硬编码切换为 JS 引擎注入，沉浸效果通用化

文件清单：
  [+] src/services/themeEngine.ts     — 主题加载引擎
  [+] src/services/themeMerger.ts     — 深合并 + 回退链
  [M] src/main.tsx                    — 首屏加载改为 themeEngine
  [M] src/index.css                   — 移除 light/spiderman 变量块
  [M] src/App.css                     — 沉浸选择器通用化 + 变量重命名
  [D] src/utils/spiderman-theme.ts    — 删除
  [M] 14 个组件                       — data-spiderman-panel → data-theme-panel

测试验证：
  ✓ 启动时正确加载 lastActiveTheme
  ✓ 切换主题时 CSS 变量正确注入
  ✓ 沉浸效果在任意主题生效（immersive.enabled）
  ✓ 旧 spiderman 主题兼容
  ✓ 自适应遮罩正常工作
  ✓ 首屏无 FOUC
  ✓ cargo check --lib 通过
  ✓ tsc 无错误
```

### Phase 2：基础管理 UI（~2 天）

```
目标：用户可管理主题列表，支持复制新增、导入导出

文件清单：
  [+] src/components/Theme/ThemeManager.tsx  — 主题列表管理
  [R] src/components/Settings/tabs/ThemeTab.tsx — 重构，集成 ThemeManager

功能：
  - 主题卡片列表（内置 + 自定义）
  - 激活主题
  - 复制新增（基于当前主题创建副本）
  - 删除自定义主题
  - 重命名
  - 导出为 .polaris-theme 文件
  - 导入 .polaris-theme 文件

测试验证：
  ✓ 主题列表正确显示内置 + 自定义
  ✓ 复制新增功能正常
  ✓ 导入/导出文件格式正确
  ✓ 删除后自动回退
  ✓ 错误处理（文件格式、权限、冲突）
```

### Phase 3：可视化编辑器（~3-5 天）

```
目标：提供完整的可视化主题编辑体验

文件清单：
  [+] src/components/Theme/ThemeEditor.tsx      — 编辑器主框架
  [+] src/components/Theme/ColorPicker.tsx      — 颜色选择器
  [+] src/components/Theme/ColorEditor.tsx      — 颜色分组编辑
  [+] src/components/Theme/ThemePreview.tsx     — 实时预览
  [+] src/components/Theme/ImmersiveEditor.tsx  — 沉浸效果编辑
  [+] src/components/Theme/LayerOpacityEditor.tsx — 透明度编辑
  [+] src/components/Theme/WallpaperEditor.tsx  — 壁纸编辑
  [M] src/locales/zh-CN/settings.json           — 翻译
  [M] src/locales/en-US/settings.json           — 翻译

功能：
  - 基本信息编辑（名称、描述）
  - 颜色选择器（色轮 + RGB + HEX + 预设）
  - 沉浸效果编辑（壁纸/渐变/纯色、透明度、磨砂、蛛网）
  - 实时预览（微缩界面 + 颜色变化即时反映）
  - 保存主题
  - 基于内置主题编辑（复制后编辑）

测试验证：
  ✓ 所有颜色可编辑
  ✓ 沉浸效果实时预览
  ✓ 保存后刷新不丢失
  ✓ 编辑不影响其他主题
  ✓ 预览与实际效果一致
  ✓ 响应式布局
```

### Phase 4：后期优化（远期，1-2 天）

```
目标：后续优化和补充功能

文件清单：
  [M] src/utils/mermaid-config.ts  — 改为从 CSS 变量读取
  [M] 终端主题 — 改为从 CSS 变量读取

功能：
  - Mermaid 图表跟随主题
  - 终端配色跟随主题
  - 性能优化（CSS 变量注入批处理）
  - 快捷键切换主题（可选）
  - 社区主题市场（远期）
```

### 工时估算

| 阶段 | 内容 | 前端 | 后端 | 总人日 |
|------|------|:----:|:----:|:------:|
| Phase 0 | 数据模型 + 存储 | 1.5 | 0.5 | 2 |
| Phase 1 | 加载引擎 + CSS 通用化 | 2.5 | 0.5 | 3 |
| Phase 2 | 基础管理 UI | 2 | 0 | 2 |
| Phase 3 | 可视化编辑器 | 3.5 | 0.5 | 4 |
| Phase 4 | 后期优化 | 1 | 0 | 1 |
| **合计** | | **10.5** | **1.5** | **~12** |

---

## 11. 风险与注意事项

### 11.1 风险清单

| 风险 | 等级 | 概率 | 影响 | 缓解措施 |
|------|------|:----:|:----:|---------|
| R1: 首屏 FOUC | 高 | 中 | 高 | localStorage 同步读取 + 内联 script 在 React render 前执行 |
| R2: CSS 变量注入性能 | 中 | 低 | 中 | 批处理写入，避免逐条 style.setProperty |
| R3: 旧配置兼容 | 中 | 高 | 中 | 保留旧字段读取，迁移逻辑在加载时自动执行 |
| R4: 用户主题冲突 | 低 | 中 | 低 | 导入时自动添加 "(2)" 后缀 |
| R5: 沉浸效果渲染开销 | 低 | 低 | 中 | backdrop-filter 仅在 immersive.enabled 时生效 |
| R6: localStorage 容量 | 低 | 低 | 低 | 大背景图用 data URI 时注意大小限制（~5MB） |

### 11.2 关键注意事项

1. **FOUC 保护**：`main.tsx` 的内联 IIFE 必须在 React render 之前执行，且不能依赖异步加载。建议保留内联 script 结构，只是内容从 `syncSpiderManCssVarsToDom()` 改为调用 `themeEngine.loadAndInject()` 的同步版本。

2. **向后兼容**：`config.theme` 和 `config.spidermanTheme` 保留至少一个版本周期。迁移逻辑在 configStore 加载时自动执行，不依赖用户操作。

3. **CSS 变量名称冲突**：`--c-*` 变量命名空间是全局的，自定义主题不应引入新变量名，只能修改现有变量的值。所有 CSS 变量名必须是 ThemeDefinition 中定义的。

4. **沉浸效果的条件渲染**：`data-theme-immersive` 属性仅在 `immersive.enabled === true` 时设置，确保非沉浸主题不产生额外的渲染开销。

5. **Mermaid/终端主题同步**：这两个组件的配色目前是独立硬编码的。Phase 1 暂不改造，Phase 4 中改为从 CSS 变量注入，但需要确保：
   - Mermaid 的 `themeVariables` 不能直接引用 CSS 变量（需要在 JS 中读取并转换）
   - 终端 xterm 的 `ITheme` 同样需要 JS 读取 CSS 变量值

6. **测试策略**：
   - Phase 0：TypeScript 类型检查 + 单元测试（themeService CRUD）
   - Phase 1：视觉回归测试（三个主题外观一致）+ 首屏加载性能
   - Phase 2：E2E 测试（导入/导出/复制/删除）
   - Phase 3：人工验收（编辑器功能完整性）

---

## 12. 附录：关键设计决策

### ADR 1：为什么用 DataRoot 文件系统而不是 IndexedDB？

**决策：** 使用 `DataRoot/themes/` 文件系统 + localStorage 缓存

**理由：**
- 主题文件是 JSON 文本，天然适合文件存储
- 每个主题独立文件，便于备份/同步/版本控制
- 与现有 `DataRoot` 统一（配置、工作区等已使用文件系统）
- localStorage 只做启动缓存，主存储由 themeService 管理

### ADR 2：为什么保留 `:root` 中的 dark 变量作为回退？

**决策：** `:root` 中的 CSS 变量作为回退默认值永久保留

**理由：**
- 确保 CSS `var()` fallback 链完整
- 即使 JS 引擎加载失败，页面仍可阅读
- 渐进增强：无 JS 环境也能显示 dark 主题

### ADR 3：沉浸效果为什么要通用化而不保留 spiderman 专属？

**决策：** 沉浸效果变为通用属性，由 `immersive.enabled` 控制

**理由：**
- 用户可能想要"沉浸式 dark 主题"（壁纸 + 面板透明）
- 当前 spiderman 的沉浸效果与蜘蛛侠主题无关（壁纸遮罩、面板透明、磨砂玻璃都是通用功能）
- 重用 CSS 选择器和 JS 逻辑，减少代码量

### ADR 4：为什么不直接使用 `input[type="color"]` 做颜色选择器？

**决策：** 使用 `react-colorful` 库

**理由：**
- 原生 `<input type="color">` 不支持 RGB 三元组输入（只输出 HEX）
- 不支持透明度通道
- 不支持预设色板
- 不同浏览器渲染不一致
- `react-colorful` 仅 2.9KB gzipped，支持受控模式

### ADR 5：Mermaid/终端主题如何处理？

**决策：** Phase 4 中改为 JS 读取 CSS 变量值，动态生成配置

**理由：**
- Mermaid 和 xterm 的配置对象不能直接引用 CSS 变量
- 需要在 JS 中读取 `getComputedStyle()` 获取当前 CSS 变量值
- 转换为 Mermaid/xterm 的配置格式
- 监听主题变化时重新生成

---

## 总结

本规划分析完成了以下工作：

1. **现状全面审计**：精确到行号的代码影响分析，覆盖所有 40+ 处 CSS 选择器、14 处 data 属性、3 个消费方
2. **用户需求明确**：6 个核心场景、7 项功能需求按优先级排列
3. **数据模型定型**：ThemeDefinition 完整定义，与现有类型系统兼容
4. **存储架构设计**：DataRoot 文件系统 + localStorage 缓存的双层架构
5. **引擎设计**：主题加载 → 深合并 → 扁平化 → 注入的完整流程
6. **CSS 改造方案**：变量名迁移、选择器通用化、过渡期兼容
7. **UI 设计**：ThemeManager + ThemeEditor 的完整组件树和交互原型
8. **实施路线图**：4 个阶段，~12 人日，每个阶段有明确的文件清单和验证标准
9. **风险评估**：6 项风险及缓解措施，5 项关键注意事项

当前 `docs/custom-theme-system-plan.md` 的 v2 规划已覆盖数据模型和架构设计，本分析在此基础上补充了代码级细节和可执行的任务拆解。两者可合并作为最终实施文档。