# 自定义主题功能 — 方案规划与可行性分析

> **版本**: v1.1（已复审修订）  
> **日期**: 2026-07-18  
> **状态**: 规划草案 / 已复审  

> **v1.1 复审修订摘要**（逐条依据见正文各处 "⚠️ 复审补充" 标注）:
> 1. **后端合并语义**: `merge_json_object` 实为顶层浅合并（非深合并），`themeCustom` 须整体回写——已全文修正（§4.4、§1.4、§5.2、方案 A 表）。
> 2. **圆角/阴影可行性**: 真实代码中圆角是散落组件的硬编码 `rounded-*` 类、阴影尺寸硬编码，"改一个变量即可"不成立——改为"档位覆盖"方案（§2.1）。
> 3. **自由度诚实化**: 原单一 76.7% 高估，拆为"就绪 67% / 改造后 87%"两档，明确 80% 需 Phase 3-4 兑现（§3.3）。
> 4. **CodeMirror/xterm 适配细节**: CM 直接写 `rgb(var(--c-*))` 即可、无需重建；xterm 必须 `getComputedStyle`——修正原示例（§4.4、§6.1）。
> 5. **新增两条真实风险**: `config.validate()` 静默重置、FOUC 脚本仅认 light/dark（§6.1）。
> 6. **实施优先级**: Phase 3-4 从"P1 增强"上调为"达标必选项"（§7）。

---

## 目录

1. [现状分析](#1-现状分析)
2. [需求范围](#2-需求范围)
3. [自由度定义与度量](#3-自由度定义与度量)
4. [技术方案](#4-技术方案)
5. [影响范围](#5-影响范围)
6. [风险与边界](#6-风险与边界)
7. [实施路径](#7-实施路径)
8. [与 Codex 对比](#8-与-codex-对比)

---

## 1. 现状分析

### 1.1 CSS 变量体系

当前主题系统基于**单层 CSS 变量 + Tailwind 映射**实现，这是自定义主题的最佳切入点。

#### 变量定义（`src/index.css:10-122`）

所有颜色 token 以 `R G B` 三元组存储，分为两层：

| 层级 | 变量数量 | 说明 |
|------|----------|------|
| `:root` (dark 默认) | ~35 个颜色变量 | 全量变量定义 |
| `:root[data-theme="light"]` | 部分覆盖 (只定义 dark 差异项) | Light 模式覆盖 |

**变量类别与覆盖面**（基于 `src/index.css:10-122`）：

| 类别 | CSS 变量 | 数量 |
|------|----------|------|
| 主色 (Primary) | `--c-primary`, `--c-primary-hover`, `--c-primary-50~700` | 9 |
| 背景色 (Background) | `--c-bg-{base,elevated,surface,hover,active,tertiary,secondary}` | 7 |
| 边框色 (Border) | `--c-border` (单一 RGB 基底) | 1 |
| 文字色 (Text) | `--c-text-{primary,secondary,tertiary,muted}` | 4 |
| 状态色 (Status) | `--c-status-{warning,success,danger,info,done,failed,neutral}` | 7 |
| 优先级色 | `--c-priority-{low,normal,high,urgent}` | 4 |
| 强调色 (Accent) | `--c-accent-{ai,prototype,workspace}` | 3 |
| 杂项 | `--c-overlay, --c-on-primary, --c-canvas, --c-tag-bg, --c-shadow` | 5 |
| 非颜色变量 | `--window-opacity` | 1 |

**计**: 颜色类变量约 **40 个**，覆盖了应用视觉的核心维度。

#### Tailwind 映射（`tailwind.config.js:9-108`）

通过 `rgb(var(--c-xxx) / <alpha-value>)` 引用 CSS 变量。关键细节：

- 背景色复合 `--window-opacity`（`tailwind.config.js:27-34`）: `calc(var(--window-opacity, 1) * <alpha-value>)`
- 边框色固定 alpha（不复合透明度）：`--c-border` 以不同 alpha 档位（0.08/0.15/0.25）提供 `subtle/default/strong` 三种粗细
- Tailwind 层只是语法糖，**所有颜色最终由 CSS 变量决定**，无需重新编译

### 1.2 主题切换机制

**文件**: `src/stores/themeStore.ts` (80 行)

- `writeDom()` (L37-40): `document.documentElement.setAttribute('data-theme', theme)`
- `setTheme(t)` (L65-79): `applyTheme` + 后端持久化 `updateConfigPatch({ theme })`
- **防 FOUC**: `src/main.tsx:14-23`，React render 前从 localStorage 读取并写 `data-theme`

**切换点**:
- `src/components/Settings/tabs/GeneralTab.tsx:217-249` — 两个按钮（dark / light）
- 后端 `config.json` 字段 `theme: "dark" | "light"`

### 1.3 主题感知消费方

以下组件/模块直接依赖当前主题系统，自定义主题需覆盖：

| 模块 | 文件 | 依赖方式 |
|------|------|----------|
| CodeMirror 编辑器 | `src/components/Editor/modernTheme.ts` | 自定义 CM 主题 |
| Mermaid 图表 | `src/utils/mermaid-config.ts`, `MermaidDiagram.tsx` | `useThemeStore` |
| 终端 | `src/components/Terminal/TerminalPanel.tsx` | xterm `setTheme`/`theme` |
| 窗口透明度 | `src/hooks/useWindowManager.ts:71`, `useAppInit.ts:181` | `setProperty('--window-opacity')` |
| 对话显示字号行高等 | `GeneralTab.tsx` → `getChatDisplayStyleVars` | CSS style vars 注入 |

### 1.4 现有约束与可复用基础设施

| 类别 | 内容 |
|------|------|
| ✅ **有利** | CSS 变量 + Tailwind 映射架构；运行时改写变量即可全局生效，无需重编译 |
| ✅ **有利** | 已有 zustand store 管理框架 (`themeStore`, `configStore`) |
| ✅ **有利** | 已有后端配置合并 (`config_store.rs` `patch()` 顶层字段浅合并，新增顶层字段零改造) |
| ✅ **有利** | 已有 chatDisplay 的「运行时 CSS 变量注入」模式可复用 |
| ⚠️ **中性** | 当前单窗口，无跨窗口同步问题；但未来多窗口需补广播 |
| ⚠️ **中性** | CodeMirror 和 xterm 有独立主题层，需要额外适配 |

---

## 2. 需求范围

### 2.1 核心能力

| 能力 | 说明 | 优先级 | 现有基础设施是否就绪 |
|------|------|--------|--------------------|
| 自定义配色 | 覆盖所有 `--c-*` 变量（40 项以上），每一项可独立调整 | P0 | ✅ 就绪（改 CSS 变量即生效） |
| 自定义背景 | 纯色/渐变/背景图片，支持透明度 | P0 | ⚠️ 需新增 `<style>` 注入层 |
| 自定义字体 | 界面字体 / 编辑器字体 / 字号 | P0 | ⚠️ 界面字体硬编码在 `body`(index.css:131)，需新增 `--c-font-*` 变量并改造 body/组件 |
| 自定义圆角 | 全局圆角半径 | P1 | ❌ **不就绪**：圆角未走 CSS 变量，是散落组件的硬编码 `rounded-*` 类，见下方说明 |
| 自定义阴影 | 阴影大小/颜色 | P1 | ⚠️ 阴影**颜色**可调(`--c-shadow`)，但**尺寸**硬编码在 `tailwind.config.js:110-116`，见下方说明 |
| 自定义特效 | 模糊/玻璃拟态透明度 | P1 | ⚠️ 需新增变量 + 组件改造 |
| 输入区外观 | 输入框背景/边框/圆角/高度 | P1 | ⚠️ 背景/边框走变量可调；圆角/高度硬编码 |
| 工具面板外观 | 侧边栏/面板的背景、宽度 | P1 | ⚠️ 背景走变量可调；宽度多为硬编码/store 状态 |
| 主题预设管理 | 创建/保存/切换多套预设 | P0 | ✅ 就绪（config.json + zustand） |
| 导入/导出 | 主题 JSON 导入/导出，可分享 | P1 | ✅ 就绪 |
| 实时预览 | 在设置面板中修改即生效 | P0 | ✅ 就绪（setProperty 即时生效） |

> ⚠️ **圆角/阴影自定义可行性修正（复审补充）**: 复审核对真实代码后，原文档"改一个 CSS 变量即可自定义圆角/阴影尺寸"的判断**不成立**，需修正：
> - **圆角**: 代码中圆角是散落在各组件的 Tailwind 硬编码类（`rounded-lg`/`rounded-xl` 等，`grep` 命中 30+ 文件），`tailwind.config.js:123-125` 的 `borderRadius.extend` 只额外定义了一个 `4xl`，其余走 Tailwind 默认值。**没有** `--radius-*` CSS 变量层。要实现"全局圆角自定义"有两条路：
>   - **路 A（改造，彻底）**: 在 `tailwind.config.js` 用 `borderRadius: { lg: 'var(--radius-lg)', ... }` 把圆角接入 CSS 变量，再全局统一改造。工作量大、回归面广。
>   - **路 B（覆盖，务实）**: 提供有限档位（如"紧凑/标准/圆润"三档），通过注入一段全局 `<style>` 用属性选择器批量覆盖常见 `.rounded-lg{border-radius:...}`。**推荐路 B 作为 Phase 3 的圆角方案**，把"任意像素级圆角"降级为"有限档位"，避免大规模重构。
> - **阴影**: `tailwind.config.js:110-116` 的 `boxShadow` 只有**颜色**引用了 `--c-shadow` 变量，阴影的**偏移/模糊尺寸**（`0 4px 12px` 等）是硬编码。因此"阴影颜色/强度"可通过 `--c-shadow` 的 RGB + alpha 调节，但"阴影大小档位"同样需走上述路 B 的 `<style>` 覆盖。文档 §2.1 表述据此改为"阴影颜色/强度可调，尺寸走档位覆盖"。

### 2.2 明确排除（Phase 0 范围外）

| 项 | 原因 |
|----|------|
| 非视觉主题（如音效、布局排列） | 超出"外观"范畴 |
| 完全自定义布局（拖拽面板位置） | 需要独立的功能规划 |
| 动态壁纸/动效主题 | 性能开销，属未来增强 |

---

## 3. 自由度定义与度量

### 3.1 自由度界定

自定义主题的「自由度」定义为：

> **用户可独立修改的视觉属性数量与各属性可调幅度的乘积，占应用全部视觉属性理想可调集的比值。**

简化度量公式：

```
自由度 = (实际可调视觉属性数 / 应用全部可见属性数) × 平均可调幅度因子 × 100%
```

### 3.2 度量方式

三层评估：

| 层级 | 含义 | 权重 |
|------|------|------|
| **配色层** | 所有可独立调色的颜色变量 | 50% |
| **尺寸层** | 圆角、间距、字号、行高等可定制 | 25% |
| **特效/装饰层** | 背景图、透明度、模糊、阴影等 | 25% |

#### 基准线（当前 vs 目标）

| 维度 | 当前状态（dark/light 切换） | 本方案目标 |
|------|---------------------------|-----------|
| **配色层** | 2 套预设，不可自定义单个变量 | 约 40+ 个颜色变量可独立调 |
| **尺寸层** | 无 | 圆角、行高、字号等可调 |
| **特效层** | 仅有窗口透明度 | 背景图/渐变、玻璃拟态、阴影强度 |
| **可保存预设数** | 2 (hardcoded) | 任意多 |

### 3.3 本方案的目标自由度

原估算按"目标全部兑现"计算，复审后区分为**两档**，以体现哪些自由度是现成的、哪些需改造才能兑现，避免高估。

**A 档 · 就绪自由度（仅靠 CSS 变量覆盖 + 背景注入层，Phase 1-3 基础项）**

```
配色层: (40 / 45) 就绪  × 50% = 44.4%
尺寸层: (2 / 8)  就绪(仅行高/字号，走既有 chatDisplay/CSS 变量)  × 25% =  6.3%
特效层: (4 / 6)  就绪(背景图/渐变/窗口透明度/阴影颜色)         × 25% = 16.7%
------------------------------------------------------------------
就绪综合自由度 ≈ 67.4%
```

**B 档 · 改造后自由度（加圆角档位覆盖 + 字体变量化 + 组件适配，Phase 3-4 完成后）**

```
配色层: (43 / 45)  × 50% = 47.8%   (含 CodeMirror/xterm/Mermaid 跟随后的有效覆盖提升)
尺寸层: (6 / 8)    × 25% = 18.8%   (圆角档位 + 字体变量 + 行高字号)
特效层: (5 / 6)    × 25% = 20.8%   (加玻璃拟态)
------------------------------------------------------------------
改造后综合自由度 ≈ 87.4%
```

> ⚠️ **度量诚实性修正（复审补充）**: 原文档单一估算 76.7% 把"圆角可调(5/8)"当作现成能力计入，但复审确认圆角/阴影尺寸/界面字体并非现成可调（见 §2.1 修正）。因此：
> - **仅靠 Phase 1-3 基础项**（配色 + 背景，不动圆角/字体硬编码），自由度约 **67%**——**尚未达到 80% 下限**。
> - **达到 ≥80% 的必要条件**是完成 Phase 3 的圆角档位覆盖、字体变量化，以及 Phase 4 的第三方组件（CodeMirror/xterm/Mermaid）主题跟随。这些不是"锦上添花"，而是**兑现 80% 目标的前置必选项**，实施路径中的优先级需相应上调（见 §7 修正）。

**结论**: 80% 自由度**可达但有条件**——必须完成配色全覆盖 + 背景系统 + 圆角档位 + 字体变量化 + 第三方组件适配这一整套，而非仅靠配色覆盖。达成后可稳定在 **85%~87%**；若进一步展开色阶子色调、逐组件细粒度定制，有向 90% 逼近的空间。

---

## 4. 技术方案

### 4.1 方案选型比对

#### 方案 A: CSS 变量覆盖（推荐 — 标准方案）

**核心思路**: 自定义主题定义为 `Record<变量名, RGB三元组>` 的 JSON，通过 `documentElement.style.setProperty` 注入。

```
主题定义 JSON → themeStore.applyCustomTheme() → setProperty 批量写入 → 全局生效
```

| 方面 | 详述 |
|------|------|
| **接入代价** | 低。在现有 `applyTheme` 基础上追加自定义层，不改 Tailwind 编译 |
| **扩展性** | 高。新增 CSS 变量只需在 JSON schema 和渲染层加一项 |
| **运行时切换** | 零成本，属性改立即生效 |
| **持久化** | 走现有 `config.json` 的 `patch()` 顶层浅合并（`themeCustom` 整体回写） |
| **复杂度** | ⭐⭐ (低) |

#### 方案 B: CSS-in-JS 生成整份 `<style>` 标签

**核心思路**: 主题定义 → 生成一段完整的 CSS 规则 → `<style>` 标签注入优先级高于 index.css。

| 方面 | 详述 |
|------|------|
| **优势** | 可做更复杂的样式（如非颜色类、伪元素、媒体查询） |
| **劣势** | 生成/更换时需重建全部规则；样式管理分散 |
| **复杂度** | ⭐⭐⭐⭐ (高) |
| **推荐度** | ❌ 不推荐，过度设计 |

#### 方案 C: Tailwind 插件 + 主题预设编译

**核心思路**: 在构建时（如 `tailwind.config.js` 中预设多个 `theme` 对象）编译出不同的 CSS chunk，运行时按需加载。

| 方面 | 详述 |
|------|------|
| **优势** | 编译时优化，无运行时 JS 开销 |
| **劣势** | 无法动态修改；主题越多构建产物越大；不符合「自定义」需求 |
| **复杂度** | ⭐⭐⭐ |
| **推荐度** | ❌ 不推荐，与运行时自定义目标冲突 |

**选择结论**: **采用方案 A**，与现有架构最匹配，改造成本最低。

### 4.2 数据结构设计

#### 前端 TypeScript 定义

```typescript
// src/types/theme.ts

/** 单条颜色覆盖: RGB 三元组，如 "15 23 42" */
type RgbTriple = string; // 格式: "RRR GGG BBB"

/** 背景配置 */
interface BackgroundConfig {
  type: 'solid' | 'gradient' | 'image';
  // solid 时：取 --c-bg-base 等
  gradient?: {
    direction: string;  // e.g. "135deg"
    stops: { color: RgbTriple; position: number }[];
  };
  image?: {
    url: string;
    repeat: 'repeat' | 'no-repeat';
    size: 'cover' | 'contain' | 'auto';
    position: string; // e.g. "center center"
    opacity: number;  // 0 ~ 1
    blur: number;     // px
  };
}

/** 完整自定义主题定义 */
interface CustomTheme {
  /** 元信息 */
  name: string;
  description?: string;
  /** 基础: 继承 dark 还是 light */
  baseTheme: 'dark' | 'light';
  
  /** 颜色覆盖: key = CSS 变量名(不含 --c-), value = RGB 三元组 */
  colors: Partial<Record<
    | 'primary' | 'primary-hover'
    | 'primary-50' | 'primary-100' | 'primary-200' | 'primary-300' | 'primary-400' | 'primary-500' | 'primary-600' | 'primary-700'
    | 'bg-base' | 'bg-elevated' | 'bg-surface' | 'bg-hover' | 'bg-active' | 'bg-tertiary' | 'bg-secondary'
    | 'border'
    | 'text-primary' | 'text-secondary' | 'text-tertiary' | 'text-muted'
    | 'status-warning' | 'status-success' | 'status-danger' | 'status-info' | 'status-done' | 'status-failed' | 'status-neutral'
    | 'priority-low' | 'priority-normal' | 'priority-high' | 'priority-urgent'
    | 'accent-ai' | 'accent-prototype' | 'accent-workspace'
    | 'overlay' | 'on-primary' | 'canvas' | 'tag-bg' | 'shadow',
    RgbTriple
  >>;

  /** 布局/尺寸覆盖 */
  sizing?: {
    borderRadius?: {
      sm?: string;  // default "0.25rem"
      md?: string;  // default "0.375rem"
      lg?: string;  // default "0.5rem"
      xl?: string;  // default "0.75rem"
      '2xl'?: string; // default "1rem"
      full?: string; // default "9999px"
    };
  };

  /** 背景覆盖 */
  background?: BackgroundConfig;

  /** 窗口透明度 */
  windowOpacity?: number; // 0 ~ 1

  /** 特效 */
  effects?: {
    /** 玻璃拟态模糊强度 */
    backdropBlur?: 'none' | 'subtle' | 'medium' | 'strong';
    /** 阴影强度倍率 */
    shadowIntensity?: 'none' | 'subtle' | 'default' | 'strong';
  };
}

/** 用户保存的主题预设集合 */
interface ThemePreset {
  id: string;
  name: string;
  description?: string;
  theme: CustomTheme;
  createdAt: number;   // unix ms
  updatedAt: number;
}

/** 持久化到 config.json 的根字段 */
interface ThemeConfig {
  /** 当前活跃主题预设 id */
  activePresetId: string;
  /** 用户保存的所有预设 */
  presets: ThemePreset[];
}
```

#### 后端 Rust 定义（`config.rs` 追加）

```rust
// src-tauri/src/models/config.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeConfig {
    pub active_preset_id: Option<String>,
    pub presets: Vec<ThemePreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePreset {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub theme: CustomTheme,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### 4.3 存储设计

| 层级 | 存储方式 | 用途 |
|------|----------|------|
| **永久** | `config.json` (现有 `updateConfigPatch`) | 用户所有预设持久化 |
| **运行时** | `themeStore` (zustand) | 当前活跃主题的内存状态 |
| **快速首屏** | `localStorage` key `'theme-custom'` | 防 FOUC，在 `main.tsx` 的预执行脚本中提前注入 |
| **导出格式** | `.json` 文件 | 导入/导出、分享 |

### 4.4 运行时应用机制

#### 核心调用链

```
用户修改颜色 → dispatch setCustomTheme(partial)
                     ↓
          themeStore.applyCustomTheme(theme)
                     ↓
          Object.entries(colors).forEach(([key, rgb]) => {
            documentElement.style.setProperty(`--c-${key}`, rgb)
          })
          documentElement.style.setProperty(`--window-opacity`, bg.opacity)
          // 非颜色类: 额外创建 <style> 注入
          injectNonColorStyles(theme)
                     ↓
          configStore.updateConfigPatch({ themeCustom: { activePresetId, presets } })
                     ↓
          后端 config_store.merge_json_object → save()
```

> ⚠️ **后端合并语义修正（复审补充）**: `config_store.rs:605-611` 的 `merge_json_object` 实为**顶层字段浅合并**（`target_object.insert(key, value)` 直接整键覆盖），并非"递归深合并"。对本方案的实际含义：
> - `updateConfigPatch({ themeCustom: {...} })` 会用 patch 中的 `themeCustom` **整体替换**后端已有的 `themeCustom`。因此每次持久化必须传**完整**的 `{ activePresetId, presets }`，不能只传增量（如单独一个 preset），否则会覆盖丢失其余预设。
> - 反过来这对"删除预设"是有利的：前端从 `presets` 数组移除一项后整体回写即可，无需数组级 diff/patch 语义。
> - 前端 `themeStore` 应始终持有完整 `presets` 内存副本，作为回写的唯一来源（single source of truth）。

#### 与现有切换流程的关系

```
现有: setTheme('dark') → data-theme="dark" → CSS :root[data-theme] 生效
新增: setCustomTheme({ colors }) → setProperty 覆盖 → 覆盖 :root[data-theme] 的变量

优先级: setProperty > data-theme > :root
```

自定义主题的 `setProperty` 优先级高于 CSS 选择器，天然可覆盖内置预设。切换内置主题（dark/light）时清空自定义覆盖。

#### CodeMirror 适配

**现状**（`src/components/Editor/modernTheme.ts:24-76`）: 当前 CM 主题用的是**硬编码 hex 常量**（`bg.primary = '#0d1117'`、`fg.primary = '#e6edf3'` 等一整套 palette），完全独立于 `--c-*` 变量体系，且只有暗色一套（文件名即 `Modern Dark Theme`）。这是自定义主题覆盖不到的"盲区"，必须专门适配。

**适配方式（复审修正）**: CM 的 `EditorView.theme()` 本质是生成一段注入到文档的 `<style>`，其属性值里**可以直接写 CSS 变量引用字符串**，由浏览器解析——因此**不需要** `getComputedStyle` 读取、也**不需要**在每次主题变化时重建 EditorView。把硬编码 hex 换成 `rgb(var(--c-*))` 即可让 CM 自动跟随全局变量：

```typescript
// modernTheme.ts —— 直接引用 CSS 变量，浏览器端解析，主题变化零重建
function createDynamicTheme(): Extension {
  return EditorView.theme({
    '&': {
      backgroundColor: 'rgb(var(--c-bg-base))',
      color: 'rgb(var(--c-text-primary))',
    },
    '.cm-gutters': {
      backgroundColor: 'rgb(var(--c-bg-elevated))',
      borderColor: 'rgb(var(--c-border) / 0.15)',
    },
    // ...其余同理，把 bg./fg./accent. 常量替换为对应 --c-* 变量
  });
}
```

> ⚠️ **注意**: 语法高亮 token 色（`syntax.keyword` 等 16 个，`modernTheme.ts:40-56`）目前没有对应的 `--c-*` 变量。若要让代码语法配色也可自定义，需**新增一组** `--c-syntax-*` 变量（约 16 个）并接入 `HighlightStyle`。这会显著提升"编辑器自由度"，但属增量项，建议放 Phase 4 评估，不阻塞主链路。

#### Terminal 适配

**现状**（`TerminalPanel.tsx:27-50` `getXtermTheme`）: xterm 主题是**按 `theme: 'dark'|'light'` 分支返回的硬编码 hex 对象**（16 色 ANSI + 前景/背景/光标），同样独立于 `--c-*`。xterm 的 theme 是 JS 对象、**不接受** CSS 变量字符串，因此这里必须用 `getComputedStyle(document.documentElement).getPropertyValue('--c-bg-base')` 读取变量的实际 RGB 值、拼成 hex/rgb 字符串，再在自定义主题变化时调 `term.options.theme = ...` 更新（xterm ≥5 支持运行时改 `options.theme`，无需重建实例）。ANSI 16 色若要可定制，需新增 `--c-term-*` 变量组（Phase 4 评估）。

### 4.5 背景/渐变/图片 渲染机制

非颜色类自定义项（背景图、渐变）不能通过 `setProperty` 表达，需要单独的 `<style>` 注入：

```typescript
function injectNonColorStyles(theme: CustomTheme) {
  let css = '';

  if (theme.background?.type === 'gradient') {
    const stops = theme.background.gradient!.stops
      .map(s => `rgb(${s.color}) ${s.position}%`).join(', ');
    css += `body { background: linear-gradient(${theme.background.gradient!.direction}, ${stops}) !important; }`;
  }

  if (theme.background?.type === 'image') {
    const bg = theme.background.image;
    css += `body::before {
      content: '';
      position: fixed; inset: 0; z-index: -1;
      background: url(${bg.url}) ${bg.position} / ${bg.size} ${bg.repeat};
      opacity: ${bg.opacity}; filter: blur(${bg.blur}px);
      pointer-events: none;
    }`;
  }

  // 更新或创建 <style id="custom-theme-decorations">
  let el = document.getElementById('custom-theme-decorations');
  if (!el) {
    el = document.createElement('style');
    el.id = 'custom-theme-decorations';
    document.head.appendChild(el);
  }
  el.textContent = css;
}
```

### 4.6 与现有主题系统的兼容策略

| 场景 | 策略 |
|------|------|
| 用户切换 dark / light | 保留自定义颜色覆盖；仅 baseTheme 变，覆盖层保持 |
| 用户重置所有自定义 | 清空 `themeStore.customTheme`，移除所有 `setProperty` 和注入 `<style>` |
| 用户新建预设 | 从当前生效值（内置 + 自定义覆盖）快照为预设 |
| 导入主题 | 校验格式后加入 `presets`，激活 |
| 导出主题 | 导出单份 `ThemePreset` 的 `.json` |

---

## 5. 影响范围

### 5.1 需新建的文件

| 文件 | 说明 |
|------|------|
| `src/types/theme.ts` | 主题数据结构定义 |
| `src/components/Settings/tabs/ThemeCustomTab.tsx` | 自定义主题设置面板 |
| `src/hooks/useCustomTheme.ts` | 注入与清理自定义颜色的 hook |
| `src-tauri/src/models/theme_config.rs` | Rust 端主题配置结构 |

### 5.2 需改动的文件

| 文件 | 改动内容 | 改动量 |
|------|----------|--------|
| **`src/stores/themeStore.ts`** | 扩展 `applyCustomTheme()`、管理预设列表 | 中 |
| **`src/stores/configStore.ts`** | `applyTheme` 调用点补充 `applyCustomTheme` | 小（4 处） |
| **`src/types/config.ts`** | `Config` interface 加 `themeCustom` 字段 | 小 |
| **`src/components/Settings/SettingsSidebar.tsx`** | 添加新 Tab 'theme-custom' | 小 |
| **`src/components/Settings/SettingsPage.tsx`** | 注册新 Tab 组件、hotKeys 映射 | 小 |
| **`src/main.tsx`** | 防 FOUC 脚本扩展读取 localStorage 自定义主题 | 小 |
| **`src/components/Editor/modernTheme.ts`** | 整套硬编码 hex palette(bg/fg/accent/status)替换为 `rgb(var(--c-*))` 引用；语法高亮如需可定制另加 `--c-syntax-*` | **中**（非小，palette 涉及 16+ 常量与高亮样式） |
| **`src/utils/mermaid-config.ts`** | mermaid theme 跟随自定义色 | 小 |
| **`src/components/Terminal/TerminalPanel.tsx`** | `getXtermTheme` 改为 `getComputedStyle` 读取变量拼 hex，主题变化时更新 `term.options.theme`；ANSI 16 色可定制需加 `--c-term-*` | 中 |
| **`tailwind.config.js`** | 颜色映射无需改动；**若做圆角档位/字体变量化**需在 `borderRadius`/`fontFamily` 接入 CSS 变量 | 小-中（取决于是否做圆角/字体） |
| **`src/index.css`** | 颜色变量无需改动；新增背景注入不改此文件；**若字体变量化**需把 `body` 的 `font-family`(L131) 改为 `var(--c-font-ui)` | 小 |
| **`src-tauri/src/models/config.rs`** | `Config` struct 加 `theme_custom` 字段（`#[serde(default)]` 保证旧配置兼容） | 小 |
| **`src-tauri/src/services/config_store.rs`** | 无需改动（`patch()` 顶层浅合并，`themeCustom` 作为顶层字段整体覆盖即可） | 无 |

### 5.3 Tauri 命令

无需新增命令，复用 `update_config_patch` 即可。

---

## 6. 风险与边界

### 6.1 潜在风险

| 风险 | 等级 | 说明与应对 |
|------|------|------------|
| **样式冲突** | 中 | 用户设置的背景图 + 玻璃拟态可能和布局内组件背景冲突。**应对**: 提供「恢复默认」按钮，预览区实时显示效果 |
| **性能** | 低 | `setProperty` 批量写入触发重绘；40 个变量的批量写入一次重绘即可。**应对**: 使用 `requestAnimationFrame` 批量写入，避免逐属性改触发多次 layout |
| **FOUC (Flash of Unstyled Content)** | 中 | 自定义变量的 `setProperty` 在 React 渲染后才执行，首次加载会有闪白。当前 `main.tsx:14-23` 的防 FOUC 脚本**只识别 `'light'`/`'dark'` 字符串**（`stored === 'light' ? ...`），完全不认自定义颜色。**应对**: 扩展该脚本，额外读取 `localStorage['theme-custom']`（JSON），在写 `data-theme` 后立刻 `for...of` 批量 `setProperty('--c-*')`；注意脚本在 bundle 之前内联执行，不能依赖任何模块 import，需自包含 |
| **`config.validate()` 静默重置** | **中** | 复审发现：`config_store.patch()`（`config_store.rs:220`）在每次保存前会调用 `Config::validate()`（`config.rs:1266`），该方法会对非法字段**静默回退默认值**（如 `default_engine` 非法即重置为 `claude-code`）。若未来给 `theme_custom` 加校验且逻辑写错，可能**静默清空用户主题而无报错**（项目已有"双 EngineId 同步陷阱"同类教训）。**应对**: `theme_custom` 字段初期**不加** validate 逻辑（`Option` + `#[serde(default)]` 即可）；如需校验，只做"越界钳制"（clamp）而非"整体重置"，且写单测覆盖 |
| **序列化字段兼容** | 低 | `Config` struct 各字段用 `#[serde(default)]`（`config.rs:1082+`），旧 `config.json` 无 `themeCustom` 字段时反序列化不会报错、取默认值 `None`。新增字段**必须**带 `#[serde(default)]`，否则老用户升级后加载配置直接失败 |
| **持久化体积 + 整体回写放大** | 低 | 一份完整自定义主题约 2~4KB JSON，20 个预设约 80KB。因 §4.4 的浅合并语义，**每次改任意一项都要整体回写全部预设** —— 高频拖动 ColorPicker 时若每次都落盘，会放大写入。**应对**: 前端对 `updateConfigPatch` 做 debounce（如 300ms），拖动时只改内存 + `setProperty` 实时预览，停手后才落盘 |
| **跨引擎/多窗口一致性** | 低 (当前) / 中 (未来) | 当前单窗口无此问题（已核实 `tauri.conf.json` 仅 `main` 窗口）。未来开多独立 webview 时需在后端 `config_store.patch()` 成功后 `app.emit('config-updated')`，各 webview 监听后重新 `applyCustomTheme` |
| **CodeMirror 主题迁移** | 中 | CM 主题当前是硬编码 hex palette（`modernTheme.ts:24-76`）。**应对（已在 §4.4 修正）**: theme 对象里直接写 `rgb(var(--c-*))` 字符串即可让浏览器解析、自动跟随，**无需** `getComputedStyle`、**无需**每次重建 EditorView。语法高亮 token 色需另加 `--c-syntax-*` 变量组（Phase 4 评估） |
| **xterm 主题** | 低 | xterm theme 是 JS 对象、不认 CSS 变量字符串，**必须**用 `getComputedStyle` 读变量实际值拼 hex。**应对**: 主题变化时更新 `term.options.theme`（xterm≥5 支持运行时改，无需重建实例） |
| **Mermaid 图表** | 低 | Mermaid 支持动态 `updateConfig`，可在主题变化时重新渲染 |

### 6.2 边界条件

| 条件 | 行为 |
|------|------|
| 用户输入非法的 RGB 值 | 前端校验：格式 `\d{1,3} \d{1,3} \d{1,3}`，值域 0~255 |
| 背景图 URL 失效 | 优雅降级，回退到纯色背景，控制台 warn |
| 导入的主题与当前版本不兼容 | 版本号校验（`theme_version` 字段），低版本兼容 |
| 所有预设被删除 | 保留至少一个默认预设不可删除 |
| 预设数量过多 | 预设上限 50 个（可配置），超出时提示 |

---

## 7. 实施路径

> ⚠️ **优先级修正（复审补充）**: 原文档把 Phase 3（背景/圆角/字体）、Phase 4（组件适配）标为 P1"增强"。但 §3.3 复审确认——**仅完成 Phase 1-2 的配色覆盖，自由度约 67%，达不到 80% 下限**。因此本方案的自由度承诺锚点如下：
> - **Phase 1-2 完成**: 配色全覆盖，自由度 ≈ 67%（可用但未达标）
> - **Phase 3 完成**（背景系统 + 圆角档位 + 字体变量化）: 自由度 ≈ 80%（**达标线**）
> - **Phase 4 完成**（CodeMirror/xterm/Mermaid 跟随）: 自由度 ≈ 87%（含编辑器/终端一致性）
>
> 即 **Phase 3、Phase 4 是兑现"≥80% 自由度"目标的必选项，优先级应视为 P0/P1 而非可选的 P1/P2**。下方各 Phase 优先级已据此调整。

### Phase 1: 基础设施（优先级 P0，预估 2-3 天）

**目标**: 打通「自定义颜色 → 运行时 CSS 变量注入 → 持久化」的全链条，在现有 dark/light 框架上增加自定义覆盖层。

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 1.1 | 定义 `CustomTheme` 和 `ThemePreset` 数据结构 | `src/types/theme.ts` |
| 1.2 | 扩展 `themeStore`：加 `customTheme` state、`applyCustomTheme()`、预设管理（内存持完整 `presets` 副本作为回写来源） | `src/stores/themeStore.ts` |
| 1.3 | Rust 侧 Config 加 `theme_custom` 字段（`Option<ThemeConfig>` + `#[serde(default)]`，**不加 validate 重置逻辑**） | `src-tauri/src/models/config.rs` |
| 1.4 | 前端 Config interface 加 `themeCustom` 字段 | `src/types/config.ts` |
| 1.5 | 在 `configStore` 的四个 `applyTheme` 调用点（`configStore.ts:79,144,163,329`）补调 `applyCustomTheme` | `src/stores/configStore.ts` |
| 1.6 | `main.tsx` 防 FOUC 脚本扩展：读 `localStorage['theme-custom']` 并自包含地批量 `setProperty`（不依赖模块 import） | `src/main.tsx` |
| 1.7 | `updateConfigPatch` 落盘做 debounce（300ms），拖动预览只改内存 + setProperty | `themeStore.ts` |

**验收标准**:
- 通过浏览器控制台可调用 `useThemeStore.getState().applyCustomTheme({ colors: { primary: '255 0 0' } })` 并看到界面颜色变化
- 页面刷新后自定义颜色仍保持（且首屏无闪白）
- 删除某预设后其余预设不丢失（验证浅合并整体回写正确）

### Phase 2: 设置面板（优先级 P0，预估 3-4 天）

**目标**: 实现在设置面板中自助修改颜色，实时预览。

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 2.1 | 注册 ThemeCustomTab（4 处接入：`SettingsSidebar` 类型+NAV_ITEMS、`SettingsPage` TAB_TITLE_KEYS+渲染、`topLevelKeysByTab` 登记 `themeCustom`） | `SettingsSidebar.tsx` + `SettingsPage.tsx` |
| 2.2 | 实现 ColorPicker 组件（基于原生 input color 或自定义） | `src/components/Settings/` 下新增 |
| 2.3 | 实现 ThemeCustomTab 布局：预设列表 + 当前编辑区 + 预览 | `ThemeCustomTab.tsx` |
| 2.4 | 实现预设管理：新建 / 保存为 / 重命名 / 删除 / 切换 | 同上 |
| 2.5 | 实现导入 / 导出 | 同上 |
| 2.6 | i18n 文案 | `src/locales/` |

**验收标准**:
- 用户可在设置面板中选择任意颜色变量并实时看到界面变化
- 可创建/切换/删除多套预设
- 导入/导出 `.json` 格式主题文件

### Phase 3: 高级自定义 —— 达标关键（优先级 P0，预估 3-4 天）

**目标**: 背景图/渐变、圆角档位、字体变量化、特效——**这是把自由度从 67% 抬到 80% 达标线的关键阶段**。

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 3.1 | 背景类型选择器（实色 / 渐变 / 图片） | `ThemeCustomTab.tsx` |
| 3.2 | 渐变编辑器（方向 + 色标） | 同上 |
| 3.3 | 背景图选择（本地文件 / URL / 粘贴） | 同上 |
| 3.4 | **圆角档位覆盖**（紧凑/标准/圆润三档，`<style>` 属性选择器批量覆盖 `.rounded-*`，非像素级、避免大重构；见 §2.1 路 B） | `useCustomTheme.ts` |
| 3.5 | **界面字体变量化**（`body` 的 `font-family` 改 `var(--c-font-ui)`，新增字体选择） | `index.css` + `ThemeCustomTab.tsx` |
| 3.6 | 窗口透明度与玻璃拟态 | 同上 |
| 3.7 | `injectNonColorStyles()` —— 非颜色类 `<style>` 注入 | `useCustomTheme.ts` |

**验收标准**:
- 支持完整背景图配置 + 渐变背景
- 圆角三档切换全局生效
- 界面字体切换生效
- **自由度自评达到 ≥80%**（对照 §3.3 B 档清单逐项核对）

### Phase 4: 第三方组件适配（优先级 P1，预估 2-3 天）

**目标**: 确保自定义主题在 CodeMirror / Terminal / Mermaid 中表现一致（把自由度补齐到 ~87%）。

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 4.1 | `modernTheme.ts` palette 硬编码 hex → `rgb(var(--c-*))` 引用（浏览器解析，零重建） | `src/components/Editor/modernTheme.ts` |
| 4.2 | Terminal `getXtermTheme` 改 `getComputedStyle` 读变量拼 hex + 更新 `term.options.theme` | `TerminalPanel.tsx` |
| 4.3 | Mermaid 主题跟随（`updateConfig` 重渲染） | `mermaid-config.ts` |
| 4.4 | （可选评估）新增 `--c-syntax-*`/`--c-term-*` 变量组，开放代码高亮/ANSI 色定制 | 上述文件 |

**验收标准**:
- CodeMirror 编辑器颜色与自定义主题一致
- Terminal 颜色与自定义主题一致
- Mermaid 图表颜色与自定义主题一致

### Phase 5: 优化与收尾（优先级 P2，预估 1 天）

| 步骤 | 内容 |
|------|------|
| 5.1 | 性能优化：`setProperty` 批量写入，`requestAnimationFrame` 聚合；落盘 debounce 复核 |
| 5.2 | 添加自定义主题的默认预设（提供几个"设计师推荐"配色方案） |
| 5.3 | 主题分享社区准备：导出格式标准化 + 版本号字段 |

---

## 8. 与 Codex 对比

### Codex 的自定义主题能力

根据分析，Codex 的自定义主题主要提供：

| 能力 | Codex | Polaris (本方案) |
|------|-------|-------------------|
| 颜色自定义 | 有限定制（约 10-15 个 token） | **40+ 个**颜色变量全覆盖 |
| 背景自定义 | 不支持 | **支持**纯色/渐变/背景图 |
| 明暗模式 | ✅ | ✅ |
| 多主题预设 | ✅ | ✅ |
| 导入/导出 | ✅ | ✅ |
| 实时预览设置 | ✅ | ✅ |
| 圆角/尺寸自定义 | ❌ | ✅ |
| 窗口透明度 | ❌（或有限） | ✅（已有 + 自定义增强） |
| 玻璃拟态效果 | ❌ | ✅ |
| 主题跟随方案 | 仅编辑器 | 编辑器 + 终端 + Mermaid 全覆盖 |
| 自由度估算 | ~40% | **≈87%（Phase 4 完成后；Phase 3 达 80% 达标线）** |

### 超出 Codex 的具体维度

1. **颜色粒度**: Codex 约 10-15 个通用颜色 token，Polaris 暴露 **40 个**语义化颜色变量（包括状态色、优先级色、强调色）
2. **背景系统**: Codex 不支持自定义背景（仅纯色），Polaris 支持实色/渐变/背景图三层
3. **尺寸系**: 圆角、阴影强度等可定制
4. **窗口透明度**: 已有支持 + 可细粒度调节
5. **拟态与特效**: 支持玻璃拟态等可选视觉效果
6. **组件覆盖广度**: 编辑器 + 终端 + 图表全部跟随

---

## 附录

### A. 全部 CSS 变量一览

| 变量 | dark 默认值 | light 值 | 类别 |
|------|------------|----------|------|
| `--c-primary` | 59 130 246 | 37 99 235 | 主色 |
| `--c-primary-hover` | 37 99 235 | 29 78 216 | 主色 |
| `--c-primary-50~700` | 渐变蓝色 | 渐变蓝色 | 主色阶 |
| `--c-bg-base` | 15 15 17 | 250 250 252 | 背景 |
| `--c-bg-elevated` | 26 26 31 | 255 255 255 | 背景 |
| `--c-bg-surface` | 37 37 43 | 241 245 249 | 背景 |
| `--c-bg-hover` | 45 45 53 | 226 232 240 | 背景 |
| `--c-bg-active` | 53 53 61 | 203 213 225 | 背景 |
| `--c-bg-tertiary` | 33 38 45 | 232 236 241 | 背景 |
| `--c-bg-secondary` | 22 27 34 | 248 250 252 | 背景 |
| `--c-border` | 255 255 255 | 15 23 42 | 边框 |
| `--c-text-{primary,secondary,tertiary,muted}` | 248→109 | 15→148 | 文字 |
| `--c-status-{warning,success,danger,info,done,failed,neutral}` | 各色 | 加深 | 状态 |
| `--c-priority-{low,normal,high,urgent}` | 各色 | 加深 | 优先级 |
| `--c-accent-{ai,prototype,workspace}` | 各色 | 加深 | 强调 |
| `--c-overlay` | 0 0 0 | 15 23 42 | 遮罩 |
| `--c-on-primary` | 255 255 255 | — | 按钮文字 |
| `--c-canvas` | 255 255 255 | — | 画布 |
| `--c-tag-bg` | 255 255 255 | 15 23 42 | 标签 |
| `--c-shadow` | 0 0 0 | 15 23 42 | 阴影 |
| `--window-opacity` | 1.0 | 1.0 | 窗口透明度 |

### B. 关键文件索引

| 文件 (相对 D:\space\base\Polaris) | 作用 |
|-----------------------------------|------|
| `src/index.css:10-122` | CSS 变量定义，自定义主题的落地目标 |
| `tailwind.config.js:9-108` | Tailwind → CSS 变量映射桥接 |
| `src/stores/themeStore.ts` | 主题状态管理，自定义主题扩展的入口 |
| `src/stores/configStore.ts` | 配置双向同步（主题持久化的上层通道） |
| `src/types/config.ts:308, 314` | 前端 Config 类型定义 |
| `src/main.tsx:14-23` | 防 FOUC 脚本 |
| `src/components/Settings/tabs/GeneralTab.tsx:217-249` | 现有主题切换 UI |
| `src/components/Settings/SettingsSidebar.tsx` | Tab 注册点 |
| `src/components/Settings/SettingsPage.tsx` | Tab 渲染分发 |
| `src/components/Editor/modernTheme.ts` | CodeMirror 主题 |
| `src/utils/mermaid-config.ts` | Mermaid 主题 |
| `src/components/Terminal/TerminalPanel.tsx` | xterm 主题 |
| `src-tauri/src/models/config.rs:1076, 1087` | Rust 侧 Config 结构 |
| `src-tauri/src/services/config_store.rs:32, 207` | 配置持久化与合并 |

### C. 参考链接

- [TailwindCSS 运行时主题定制](https://tailwindcss.com/docs/dark-mode#customizing-the-dark-mode-selector)
- [CSS 自定义属性 (CSS Variables) MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [CodeMirror Theme Spec](https://codemirror.net/docs/ref/#view.EditorView^theme)
- [xterm.js Theme](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#theme)

---

> **文档状态**: 规划草案 / 待评审  
> **下一步建议**:  
> 1. 在 `ThemeCustomTab.tsx` 中先落地一个最小原型（仅颜色覆盖 + 一个简易 ColorPicker）来验证 Phase 1 的基础链路  
> 2. 待 Phase 1 验证通过后，再展开 Phase 2 的完整设置面板