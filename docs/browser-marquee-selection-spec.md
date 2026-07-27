# Spec: 内置浏览器圈选功能 (Browser Marquee Selection)

> 状态:**草案 v1**
> 日期:2026-07-27
> 范围:`src/components/Browser/BrowserPanel.tsx` · `src/services/tauri/browserService.ts` · `src-tauri/src/commands/browser.rs` · `src-tauri/src/ai/engine/simple_ai/tools/browser.rs`
> 关联记忆:`browser-info-extraction-plan` / `browser-automation-plan` / `browser-ui-refactor-plan`
> 预估工作量:MVP(单圈选) 2.5 人日;增强(多圈选) +1 人日;合计 3.5 人日

---

## 1. 背景与问题

### 1.1 现状

Polaris 内置浏览器当前支持 AI 获取**全页上下文**（`browser_get_page_context`）并通过"讲解/修改"按钮（`formatContextForChat`）将完整页面内容作为对话上下文发送给 AI。

**问题**：
- **粒度不可控**：当前只能发送全页内容，当页面很长（如 5000px 滚动文档）时，AI 接收大量无关内容，上下文效率低。
- **意图不明确**：用户只能描述"把页面中某个区域改成..."，AI 需要从全页定位，准确率依赖 prompt 质量。
- **缺少视觉锚点**：AI 只能看到文本化的 DOM 结构，没有圈选区域截图作为视觉参考。
- **没有意图注释**：用户无法在发送前补充"我想让这个区域变成..."的意图说明。

### 1.2 用户诉求

> 用户在浏览器中圈选一个或多个区域，圈选区域的内容作为对话上下文，并支持在圈选时写注释说明意图，一起发送给 AI。

### 1.3 业界对标

| 产品 | 感知方式 | 区域定位 | 意图注释 | 备注 |
|------|---------|---------|---------|------|
| Anthropic Computer Use | 全屏截图 → 视觉模型 | AI 自主 `zoom` 区域（`enable_zoom`） | 无用户注释 | 全自动，无需用户操作 |
| Playwright MCP | 无障碍树（snapshot） | `boxes: true` 输出视口坐标 | 无 | 刻意避免视觉路线 |
| Codex Agent | 终端输出 + 截图 | CDP 元素选择器 | 无 | 代码/自动化场景 |
| **Polaris** | **结构化 DOM + 截图** | **用户圈选（差异化）** | **支持** | **半交互、用户主导** |

**差异化定位**：Anthropic 走"AI 自主决策"，Playwright 走"纯结构化"，Polaris 圈选是**"用户明确指定 + 结构化 + 视觉 + 意图"**的混合路线。

---

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 | 验收标准 |
|------|------|---------|
| G1 | 用户可在内置浏览器页面上拖拽画矩形圈选区域 | 圈选完成后矩形正确显示，元素高亮 |
| G2 | 圈选区域内容作为对话上下文发送给 AI | 区域 DOM 片段 + 元素列表 + 区域截图投喂给 AI |
| G3 | 支持在圈选时写注释（用户意图） | 注释文本拼接到上下文，随 sendMessage 发送 |
| G4 | 支持单圈选（MVP） | 拖拽 1 个矩形即结束 |
| G5 | 支持多圈选（增强） | 拖拽多个矩形，双击/ESC 结束，去重合并 |
| G6 | 圈选期间正确处理滚动/缩放 | 滚动锁定；DPR 坐标换算正确 |

### 2.2 非目标

| 编号 | 非目标 | 理由 |
|------|--------|------|
| NG1 | 自由形状圈选（lasso） | 矩形覆盖 90% 场景，lasso 复杂度增加 3 倍 |
| NG2 | 逐区域独立注释 | MVP 用全局注释，逐区域注释留 P2 |
| NG3 | 视觉模型投喂（base64 图片直投） | 当前 AI 引擎通过文本上下文工作，视觉投喂需模型支持 |
| NG4 | 圈选历史/回退/撤销（多圈选） | 双击/ESC 终止即重置，不保留历史 |

---

## 3. 坐标系定义

圈选涉及 4 个坐标系统，必须严格定义以避免坐标漂移。

### 3.1 四坐标系

| 编号 | 名称 | 定义 | 单位 | 变体 |
|------|------|------|------|------|
| C1 | **视口坐标** (Viewport) | `getBoundingClientRect()` 返回值 | CSS 像素（逻辑像素） | 随页面滚动变化；不随系统 DPI 缩放 |
| C2 | **文档坐标** (Document) | `offsetTop + scrollY` | CSS 像素 | 不随滚动变化 |
| C3 | **WebView 边界** (Bounds) | `BrowserBounds`，主窗口内的逻辑像素 | CSS 像素 | 不随滚动/系统 DPI 变化 |
| C4 | **屏幕物理坐标** (Screen) | `bounds × scale_factor + window.outer_position` | 物理像素 | 随系统 DPI 变化 |

### 3.2 坐标系关系

```
┌─────────────────────────────────────────────────────────────────┐
│  屏幕物理坐标 (C4)                                               │
│  = window_x + (bounds.x × scale_factor) + (viewX × scale_factor)│
│                                                                 │
│  ┌───────────────────────────────────────────┐  ┌─────────┐    │
│  │  WebView 边界 (C3)                          │  │ Desktop │    │
│  │  ┌─────────────────────────────────────┐    │  └─────────┘   │
│  │  │ 视口 (C1)                            │    │               │
│  │  │  ┌──────────┐                         │    │               │
│  │  │  │ 圈选矩形  │                         │    │               │
│  │  │  │  [viewX] │                         │    │               │
│  │  │  └──────────┘                         │    │               │
│  │  │  [viewY]                              │    │               │
│  │  │                                       │    │               │
│  │  └─────────────────────────────────────┘    │               │
│  │                                              │               │
│  └──────────────────────────────────────────────┘               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 坐标转换公式

| 方向 | 公式 |
|------|------|
| 圈选矩形 → 截图裁剪（C1→C4） | `screenX = window_x + (bounds.x + viewX) × scale_factor` |
| 圈选矩形 → 截图裁剪 | `screenY = window_y + (bounds.y + viewY) × scale_factor` |
| 圈选矩形 → 截图裁剪 | `screenW = viewW × scale_factor` |
| 圈选矩形 → 截图裁剪 | `screenH = viewH × scale_factor` |
| 元素坐标匹配（C1） | 直接比较，无需转换（overlay rect 与 element rect 同坐标系） |

**关键约束**：overlay 注入的 JS 运行在 WebView 视口内，其 `mousedown/mousemove` 的 `clientX/clientY` 与 `collectPolarisInteractiveElements` 收集的 `element.getBoundingClientRect().left/top` **在同一坐标系（C1）**，可以直接做矩形相交判断。

---

## 4. 坐标系统问题分析

### 4.1 页面滚动

| 场景 | 影响 | 解决方案 |
|------|------|---------|
| 单圈选时用户滚动 | 圈选矩形随视口变化，释放时坐标锁定 | 无问题：释放时坐标已定 |
| **多圈选时画完矩形1后滚动** | 矩形1的视口坐标不再对应原页面区域 | **圈选期间 `document.body.style.overflow = 'hidden'` 锁定滚动** |
| 页面自动滚动（动画/iframe） | overlay 坐标与元素坐标漂移 | 圈选结束立即截图；`on_navigation` 事件自动清理圈选 overlay |

**方案**：进入圈选模式时注入 JS 锁定滚动，结束圈选时恢复。

```javascript
const savedOverflow = document.body.style.overflow;
const savedScrollY = window.scrollY;
document.body.style.overflow = 'hidden';  // 锁定

// ... 圈选过程

document.body.style.overflow = savedOverflow;  // 恢复
// 不恢复 scrollY，保持用户在圈选前的位置
```

### 4.2 系统缩放（DPR）

| 场景 | 影响 | 解决方案 |
|------|------|---------|
| Windows 125%/150% 显示缩放 | `scale_factor > 1`，视口逻辑像素 ≠ 屏幕物理像素 | 截图裁剪时乘以 `scale_factor`（复用已有 `capture_browser_screenshot` 公式） |
| 截图裁剪边界精度 | `float × scale_factor` 取整可能偏移 1-2px | 截图时加 2-4px padding |

**现有代码基础**：`capture_browser_screenshot`（browser.rs:1166-1215）已实现 `bounds × scale_factor + window.outer_position` 的完整换算，圈选区域截图只需把圈选矩形作为 bounds 内的 offset 传入。

### 4.3 页面缩放（Ctrl+）

页面缩放（`Ctrl+`/`Ctrl-`）改变视口大小和 BCR 返回值，但 overlay 和元素收集器**共享同一个被缩放的视口**，坐标自然匹配。无需特殊处理。

### 4.4 截图尺寸约束（业界共识）

参照 [Anthropic Computer Use 官方文档](https://docs.anthropic.com/en/docs/agents-and-tools/computer-use)：
> 截图过大时 API 自动降采样，**你收不到缩放比例**。必须在客户端控制截图尺寸，并在执行 AI 返回的坐标时做反向缩放。

模型支持的截图尺寸上限：

| 模型 | 长边限制 | 像素总数 |
|------|---------|---------|
| Claude Opus 5 / Sonnet 5 / Opus 4.7-4.8 | 2576 px | — |
| 旧模型（Sonnet 4.5 等） | 1568 px | ~1.15 MP |
| 推荐基线 | 1280 × 720 | — |

**Polaris 策略**：圈选区域截图通常远小于全屏，不会触及模型限制。但应记录截图的实际像素尺寸，以备后续视觉模型投喂时的缩放补偿。

### 4.5 overlay 事件冲突

圈选 overlay 是 `position: fixed` 的透明层，会拦截页面鼠标事件。

**解决方案**：

| 状态 | `pointer-events` | 行为 |
|------|-----------------|------|
| 进入圈选模式，未开始拖拽 | `auto` | 接收 mousedown |
| 拖拽中 | `auto` | 接收 mousemove/mouseup |
| 圈选完成，显示结果 | `none` | 不拦截，页面可点击 |
| 多圈选中（已完成 N 个矩形） | `auto` | 接收下一个 mousedown |

---

## 5. 交互设计

### 5.1 单圈选（MVP）

```
┌───────────────────────────────────────────────────────────────┐
│  [← → ↻]  www.example.com  [讲解] [修改] [🖱️圈选] [⋮]      │  ← 工具栏
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  页面内容...                                                   │
│                                                               │
│  ┌──────────┐  ← 用户拖拽画矩形（虚线 + 半透明蓝色）          │
│  │ 圈选区域  │  释放后：                                       │
│  └──────────┘  · 矩形变为实线边框（绿色）                     │
│                  · 区域内元素高亮（蓝色边框）                 │
│                  · AI 面板弹出圈选预览                        │
│                                                               │
│  页面内容...                                                   │
├───────────────────────────────────────────────────────────────┤
│  📌 已圈选区域                                                   │
│  · 坐标: (120, 340) 尺寸: 280×160                           │
│  · 包含 8 个元素：按钮 ×2, 链接 ×3, 输入框 ×1, 图片 ×2     │
│  · 区域截图（内联预览）                                        │
│                                                               │
│  💬 补充说明：                                              │
│  [_______________________________]  (输入框)                   │
│                                                               │
│  [发送给 AI]                                                  │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 多圈选（增强）

```
进入圈选模式后：

  画矩形 1 → 释放 → 矩形1 显示（蓝色边框 + 编号 ①）
  画矩形 2 → 释放 → 矩形2 显示（蓝色边框 + 编号 ②）
  ...
  双击空白 / 按 ESC → 结束

视觉设计：
  ┌──────────┐
  │ ① ┌──────┤  ← 已完成矩形：蓝色边框 + 编号 badge
  │   │      │
  │   └──────┘
  └──────────┘
       ┌──────────┐
       │ ② ┌──────┤  ← 已完成矩形：蓝色边框 + 编号 badge
       │   │      │
       └───└──────┘

终止方式：
  · 双击页面空白处（非元素上）
  · 按 ESC 键
  · 点击工具栏"完成圈选"按钮（备选）
```

### 5.3 多圈选上下文合并

```
┌──────────────────────────────────────────────────────────┐
│  📌 已圈选 2 个区域                                        │
│                                                          │
│  【区域 ①】(120,340) 280×160 — 包含 8 个元素              │
│  · 按钮 "提交"、链接 "查看详情"...                        │
│  · DOM 片段（可展开）                                      │
│  · 区域截图                                               │
│                                                          │
│  【区域 ②】(450,520) 320×200 — 包含 6 个元素              │
│  · 输入框 "搜索"...                                       │
│  · DOM 片段（可展开）                                      │
│  · 区域截图                                               │
│                                                          │
│  💬 全局说明：                                          │
│  [_______________________________]                        │
│                                                          │
│  [发送给 AI]                                             │
└──────────────────────────────────────────────────────────┘
```

**去重规则**：相交区域的同一元素只出现一次，标注"同时属于区域 ① 和 ②"。

---

## 6. 圈选 overlay 设计

### 6.1 状态机

**单圈选**：
```
IDLE → (mousedown) → DRAWING → (mouseup) → RESULT → RESET
```

**多圈选**：
```
IDLE → (mousedown) → DRAWING → (mouseup) → REGION_DONE(矩形1)
   → (mousedown) → DRAWING → (mouseup) → REGION_DONE(矩形2)
   → ...
   → (双击空白/ESC) → FINAL → RESET
```

### 6.2 视觉样式

| 元素 | 样式 |
|------|------|
| 拖拽中矩形 | 虚线 2px `border-dashed` + 半透明蓝色背景 `rgba(59,130,246,0.15)` |
| 已完成矩形 | 实线 2px `border-solid` 蓝色 `#3B82F6` |
| 多圈选编号 badge | 矩形左上角，24×24 圆形，蓝色背景白色数字 |
| 区域内元素高亮 | 2px 绿色边框 `rgba(34,197,94,0.95)`（与 AI Overlay fillable 颜色区分） |
| 圈选中鼠标 | `cursor: crosshair` |
| overlay z-index | `2147483645`（低于 AI Overlay 的 2147483646） |

### 6.3 overlay 注入方式

通过 `browser_eval_with_app` 注入，与现有 AI Overlay 同构：

```rust
// 后端新增命令
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_set_marquee(
    app: AppHandle,
    label: String,
    enabled: bool,
    rects: Option<Vec<BrowserRect>>,  // 多圈选：传入已完成矩形列表
) -> Result<BrowserOverlayResult>
```

- `enabled: true` → 注入 overlay JS，进入圈选模式
- `enabled: false` → 清理 overlay（与 `browser_set_ai_overlay` 同模式）
- `rects` 可选，用于多圈选时同步已完成矩形（用于重绘/高亮）

---

## 7. 后端设计

### 7.1 新增 Tauri 命令

| 命令 | 描述 |
|------|------|
| `browser_set_marquee(label, enabled, rects?)` | 开关圈选 overlay |
| `browser_select_region(label, rect, screenshot?)` | 按矩形筛选元素 + 提取 DOM + 可选区域截图 |

### 7.2 `browser_select_region` 返回结构

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRegionResult {
    pub url: String,
    pub count: usize,                        // 区域内元素数量
    pub elements: Vec<BrowserRegionElement>, // 区域内元素
    pub html_snippet: String,                 // 区域内 DOM 片段
    pub screenshot: Option<BrowserScreenshot>, // 区域截图（可选）
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRegionElement {
    pub index: usize,
    pub kind: String,
    pub text: String,
    pub rect: BrowserRect,                   // 视口坐标
    pub fillable: boolean,
    pub disabled: boolean,
    pub selector: Option<String>,            // 稳定 CSS selector
}
```

### 7.3 JS 注入脚本

```javascript
// REGION_SELECT_SCRIPT_BODY
(() => {
  const targetRect = { x: targetX, y: targetY, w: targetW, h: targetH };
  
  // 1. 元素筛选：复用 collectPolarisInteractiveElements
  const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
  const inRegion = entries.filter(e => rectsIntersect(e.rect, targetRect));
  
  // 2. 提取 DOM 片段：圈定区域的 HTML outerHTML
  const regionElements = inRegion.map(e => e.element);
  const regionHtml = extractRegionHtml(regionElements, targetRect);
  
  // 3. 返回
  return JSON.stringify({
    count: inRegion.length,
    elements: inRegion.map((e, i) => ({
      index: i, kind: e.kind, text: e.label,
      rect: e.rect, fillable: e.fillable, disabled: e.disabled,
      selector: e.selector
    })),
    htmlSnippet: regionHtml,
    url: String(location.href)
  });
})()
```

### 7.4 区域截图

复用 `capture_browser_screenshot`（browser.rs:1166-1215），传入的 bounds 为：

```rust
let screenshot_bounds = BrowserBounds {
    x: browser_bounds.x + (region.x / scale_factor),  // 圈选 rect 已在视口坐标系
    y: browser_bounds.y + (region.y / scale_factor),
    width: region.width / scale_factor,
    height: region.height / scale_factor,
};
// 注意：region 的 x,y,w,h 由前端传入时已是视口坐标，
// 但 capture_browser_screenshot 期望的是 WebView 边界内的 offset，
// 需要在 bounds.x + region.x（两者同为逻辑像素，直接相加）
// 实际调用时：bounds.x + region.x → 这是视口左上角到圈选区域左上角的逻辑像素距离
```

---

## 8. 上下文格式化

### 8.1 单圈选模板

```
我在用 Polaris 内置浏览器查看一个页面，圈选了页面中一个区域，请根据圈选区域的内容协助我修改项目。

标题: {title}
URL: {url}
圈选区域: 坐标({x},{y})，尺寸{width}×{height}，包含 {count} 个元素

用户意图：{userNote}

圈选区域内元素：
{elements_summary}

圈选区域 DOM 片段：
```html
{htmlSnippet}
```

请先判断这可能对应项目中的哪些文件或组件，再给出修改方案。
```

### 8.2 多圈选模板

```
我在用 Polaris 内置浏览器查看一个页面，圈选了 {N} 个区域，请根据圈选区域的内容协助我修改项目。

标题: {title}
URL: {url}

用户意图：{userNote}

{每个区域重复以下结构}

【区域 {idx}】坐标({x},{y})，尺寸{width}×{height}，包含 {count} 个元素
{elements_summary}

```html
{htmlSnippet}
```

请按区域分别定位到项目中对应的组件/文件，再给出修改方案。
```

### 8.3 前端格式化函数

```typescript
// src/services/tauri/browserService.ts

export interface BrowserRegionContext {
  title: string
  url: string
  regions: BrowserRegion[]
  userNote?: string
}

export interface BrowserRegion {
  id: number
  rect: BrowserRect
  count: number
  elements: BrowserRegionElement[]
  htmlSnippet: string
  screenshot?: BrowserScreenshot
}

export function formatRegionContext(context: BrowserRegionContext): string {
  // 单区域 → 单圈选模板
  // 多区域 → 多圈选模板
}
```

---

## 9. 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| 圈选区域过小（<20×20px） | 提示"区域太小，请重新圈选" |
| 圈选区域超出视口 | 自动裁剪到视口边界 |
| 圈选区域无元素 | 返回"该区域无可交互元素"，但仍返回 DOM 片段 |
| WebView 不可用（降级模式） | 圈选按钮 disabled |
| 圈选期间 URL 变化（SPA 导航） | `on_navigation` 自动清理圈选，提示"页面已导航，圈选已取消" |
| 截图失败（非 Windows） | 返回 DOM 片段但不包含截图，不影响上下文发送 |
| 圈选区域过大（接近全屏） | 自动降采样到模型支持的尺寸上限 |
| 多圈选相交元素 | 去重，标注"同时属于区域 A 和区域 B" |

---

## 10. 实施计划

### Phase 1：MVP（单圈选，2.5 人日）

| 任务 | 文件 | 工作量 |
|------|------|--------|
| 后端 `browser_set_marquee` Tauri command | `commands/browser.rs` | 0.3 人日 |
| JS overlay 脚本（单矩形 + 拖动 + 结果回传） | `commands/browser.rs` | 0.5 人日 |
| 后端 `browser_select_region` Tauri command | `commands/browser.rs` | 0.5 人日 |
| JS 区域元素筛选 + DOM 提取脚本 | `commands/browser.rs` | 0.5 人日 |
| 前端圈选按钮 + overlay 交互逻辑 | `BrowserPanel.tsx` | 0.5 人日 |
| 前端 AI 面板圈选预览 + 注释输入框 | `BrowserPanel.tsx` | 0.3 人日 |
| 上下文格式化 `formatRegionContext` | `browserService.ts` | 0.2 人日 |
| i18n 新增 key | `zh-CN/en-US/common.json` | 0.2 人日 |

### Phase 2：多圈选（+1 人日）

| 任务 | 文件 | 工作量 |
|------|------|--------|
| overlay 支持多矩形（双击/ESC 终止 + 编号 badge） | `commands/browser.rs` JS | 0.4 人日 |
| 相交去重逻辑 | `commands/browser.rs` JS | 0.2 人日 |
| 包围矩形截图 | `commands/browser.rs` | 0.2 人日 |
| 多区域分组上下文格式化 | `browserService.ts` | 0.1 人日 |
| AI 面板 N 个区域卡片 | `BrowserPanel.tsx` | 0.3 人日 |
| 测试 + 边界情况 | — | 0.3 人日 |

---

## 11. 依赖项

| 依赖 | 状态 | 说明 |
|------|------|------|
| `collectPolarisInteractiveElements` + `rect` 字段输出 | ✅ 已实施（P0） | 元素坐标已可用 |
| `browser_eval_with_app` | ✅ 已实施 | JS 注入通道已存在 |
| `capture_browser_screenshot`（Windows） | ✅ 已实施 | 截图能力已存在 |
| `BrowserActionDispatcher` | ✅ 已实施 | 动作分派通道已存在 |
| `BrowserBounds` 存储 | ✅ 已实施 | bounds 已维护 |
| AI Overlay JS 注入模式 | ✅ 已实施 | `browser_set_ai_overlay` 可复用 |

**无外部依赖阻塞**，所有需要的底层能力均已就绪。

---

## 12. 附录：业界关键决策参考

### 12.1 Anthropic Computer Use 的坐标教训

[官方文档](https://docs.anthropic.com/en/docs/agents-and-tools/computer-use)明确指出：

1. **不要依赖服务端自动降采样**——API 缩放后不返回 scale factor，导致坐标反算失败
2. **Retina 屏幕 DPI=2**——截图是逻辑坐标 2 倍，需手动补偿
3. **推荐基线分辨率 1280×720**
4. **`enable_zoom` 是 AI 自主区域放大**——Polaris 用户圈选是更主动的版本
5. **点击偏移根因**——`display_width/height` 与实际截图尺寸不一致

### 12.2 Playwright MCP 的结构化优先

[README](https://github.com/microsoft/playwright-mcp) 明确表示：
> "Uses Playwright's accessibility tree, not pixel-based input. Deterministic tool application. Avoids ambiguity common with screenshot-based approaches."

Playwright 用 `scale: "css"`（CSS 像素）而非 `"device"`（物理像素），与 Polaris 方案一致。

### 12.3 截图裁剪公式验证

Anthropic 官方推荐的缩放补偿公式：

```python
def get_scale_factor(width, height):
    long_edge_scale = 1568 / max(width, height)
    total_pixels_scale = sqrt(1_150_000 / (width * height))
    return min(1.0, long_edge_scale, total_pixels_scale)
```

Polaris 当前方案（`bounds × scale_factor + window.outer_position`）与 Anthropic 的"客户端控制缩放"策略一致。
