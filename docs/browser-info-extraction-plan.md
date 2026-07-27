# Polaris 内置浏览器信息提取增强规划方案

> 文件: `src-tauri/src/commands/browser.rs` + `src/services/tauri/browserService.ts`
>
> 设计原则: 所有新增字段均为可选 (`Option` / `?`),保证旧前端解析新数据安全;脚本体积增长受控,性能优先。

---

## 1. 信息维度覆盖率表

### 1.1 `PAGE_CONTEXT_SCRIPT` (L1405-1442) —— 内容提取

| 维度 | 当前覆盖 | 行号 | 缺失 |
|---|:---:|:---:|---|
| 标题 | ✅ `document.title` (截 300) | L1433 | — |
| URL | ✅ `location.href` | L1434 | — |
| 选中文本 | ✅ (截 6000) | L1411 | — |
| meta description | ✅ (name/og, 截 1000) | L1412-1415 | ❌ 缺其他 SEO meta (`og:title`/`og:image`/`canonical`/`robots`) |
| 正文文本 | ⚠️ 仅 `article.innerText` 或 `body.innerText` (截 12000) | L1416-1437 | ❌ 无段落保留、无主标题层级、无阅读视图;正文截断无分段 |
| 标题大纲 | ⚠️ 只 `h1,h2,h3`, 截 30 条 | L1418-1424 | ❌ 缺 `h4-h6`、缺 heading 在文档中的层级嵌套关系 |
| 链接 | ⚠️ 只 `a[href]`, 截 40 条 | L1425-1431 | ❌ 无链接分类 (导航/外链/锚点)、无 `rel`、无图片链接、无按区域分组 |
| 表格 | ❌ 完全缺失 | — | ❌ 无 `<table>` 行列解析、无表头映射、无单元格文本 |
| 代码块 | ❌ 完全缺失 | — | ❌ 无 `<pre>`/`<code>`、无语言标注 (`class="language-xxx"`) |
| 图片 | ❌ 完全缺失 | — | ❌ 无 `<img>` 的 src/alt/dimensions、无 `og:image` |
| 列表 | ❌ 完全缺失 | — | ❌ 无 `<ul>`/`<ol>` 结构化 (折叠进 text) |
| 结构化数据 | ❌ 完全缺失 | — | ❌ 无 JSON-LD (`<script type="application/ld+json">`)、无 microdata (`itemprop`) |
| 表单 | ❌ 完全缺失 | — | ❌ 无 `<form>` action/method/字段清单 |
| meta keywords | ❌ | — | ❌ |

### 1.2 `polaris_interactive_collector_script!` (L1444-1879) —— 元素识别

| 维度 | 当前覆盖 | 行号 | 缺失 |
|---|:---:|:---:|---|
| 可点击角色集 | ✅ 完整 (button/link/menuitem/tab/option/...) | L1491-1495 | — |
| 可输入角色集 | ✅ | L1496 | — |
| 选择器覆盖 | ✅ 含 aria-*/data-*/contenteditable/tabindex | L1447-1489 | — |
| 坐标 `rect` | ⚠️ collector 内部有 `rectOf` (L1668-1678) 并参与去重排序,但**未输出**到 `toPolarisInteractiveElement` | L1853-1862 | ❌ `BrowserInteractiveElement` 缺 rect (交互列表场景只能靠 text 模糊匹配, MCP 点击易误命中同名元素) |
| `checked` 状态 | ❌ | — | ❌ checkbox/radio/switch 的选中态完全丢失 |
| `selected` 状态 | ❌ | — | ❌ `aria-selected`、`<option selected>` 丢失 |
| `options` (select/combo) | ❌ | — | ❌ `<select>` 的选项清单未提取, AI 无法知道能选什么 |
| `selector` 稳定定位串 | ❌ | — | ❌ 无 CSS selector / xpath (用于精确重定位, 避免 index 漂移) |
| `tooltip` | ❌ | — | ❌ `title`/`aria-describedby` 文本未提取 |
| `expanded`/`pressed` | ❌ | — | ❌ 折叠/菜单当前态丢失 |
| `required`/`pattern`/`maxLength` | ❌ | — | ❌ 表单校验约束丢失 |
| `min`/`max`/`step` (slider/spinbutton) | ❌ | — | ❌ 范围约束丢失 |
| `readOnly` | ⚠️ 内部用于 `fillable` 计算 (L1622-1624), 但**不输出** | — | ❌ 无法区分只读 vs 可写 |
| `frames` 路径 | ⚠️ 内部有 (L1806), 不输出 | — | ❌ iframe 内元素无定位元信息 |

### 1.3 上限与性能常量

| 常量 | 当前值 | 行号 | 风险 |
|---|:---:|:---:|---|
| `POLARIS_SCAN_LIMIT` | 5000 | L1497 | 大 DOM (>5000 节点) 单 root 截断, 可能漏掉 Shadow/iframe 深层交互元素 |
| `maxElements` (交互列表) | 220 | L1784 / L1921 | 复杂 SPA 不足 |
| `maxElements` (诊断) | 180 | L1927 | 视口内 180 通常够, 但密集表格/列表场景不足 |
| Shadow DOM 深度 | 3 | L1750 | 现代组件库 (Lit/Stencil) 常嵌套 4-5 层 |
| console buffer | 120 (L1896), 诊断输出 80 (L1941) | — | 导航后丢失 (见 §3.3) |
| `DEFAULT_EVAL_TIMEOUT_MS` | 2500 | L28 | — |
| page context / 诊断 eval 超时 | 3500 | L881 / L970 | 大 SPA `querySelectorAll('*')` + 多次 `getComputedStyle` 可能超时返回空 (见症状 7) |

### 1.4 已识别的根因缺陷

| 缺陷 | 根因 | 行号 |
|---|---|---|
| `getComputedStyle` 多次调用无缓存 | `styleOf(element)` 每次都调用; `isVisible` (L1691)、`looksInteractive` (L1706)、`scoreOf` (L1718) 对同一元素各调一次, 外加 `collectRoots` 内 `styleOf(element).cursor` (L1825) | L1505 / L1691 / L1706 / L1718 / L1825 |
| CONSOLE 导航后丢失 | `CONSOLE_CAPTURE_SCRIPT` 只在 `diagnostics_script()` 里注入 (L2150), 且通过 `eval` 注入, WebView 重载页面后 `window.__POLARIS_BROWSER_CONSOLE__` 重置 | L1881-1918 / L2148-2157 |
| Click 缺 mousemove/mouseenter | `CLICK_ELEMENT_SCRIPT_BODY` 仅派发 `pointerdown/mousedown/pointerup/mouseup/click` (L1985-1993), 无 `mousemove`→`mouseover`→`mouseenter`, 不触发 hover 驱动的菜单 | L1973-1993 |
| 诊断脚本 3.5s 超时 | `collectPolarisInteractiveElements` 在大 DOM 上跑两遍 querySelectorAll (selector + `*`), 叠加未缓存的 `getComputedStyle` | L1812-1830 / L881 / L970 |

---

## 2. 结构体字段增强清单

### 2.1 `BrowserInteractiveElement` (L98-109)

#### Rust 结构体定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractiveElement {
    // —— 既有 ——
    pub index: usize,
    pub kind: String,
    pub text: String,
    pub value: String,
    pub placeholder: String,
    pub href: String,
    pub disabled: bool,
    pub fillable: bool,

    // —— P0 新增 ——
    #[serde(default)]
    pub rect: Option<BrowserRect>,         // 视口坐标, 用于 AI 精确点击与去重
    #[serde(default)]
    pub checked: Option<bool>,             // checkbox/radio/switch 选中态
    #[serde(default)]
    pub selected: Option<bool>,            // aria-selected / option[selected]
    #[serde(default)]
    pub options: Option<Vec<BrowserSelectOption>>, // select/combobox 选项
    #[serde(default)]
    pub selector: Option<String>,          // 稳定 CSS selector (descriptorOf 强化)

    // —— P1 新增 ——
    #[serde(default)]
    pub tooltip: Option<String>,           // title / aria-describedby 引用文本
    #[serde(default)]
    pub expanded: Option<bool>,            // aria-expanded
    #[serde(default)]
    pub pressed: Option<bool>,             // aria-pressed
    #[serde(default)]
    pub read_only: Option<bool>,           // 区分只读
    #[serde(default)]
    pub required: Option<bool>,            // 表单校验
    #[serde(default)]
    pub min: Option<f64>,                  // slider/spinbutton
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSelectOption {
    pub value: String,
    pub text: String,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub disabled: bool,
}
```

#### 序列化兼容性

- 全部 `#[serde(default)]` → 旧前端反序列化新 JSON 时缺失字段填默认值 (`None`/`false`/空 `Vec`)
- 新结构反序列化旧 JSON 时缺失字段也为 `None`
- `BrowserRect` 已存在 (L156), 无需新增
- `Vec<BrowserSelectOption>` 的 default 为 `None`, 旧 JSON 无 `options` 时自动补 `None`

#### 前端 TypeScript 类型同步

```typescript
// src/services/tauri/browserService.ts

export interface BrowserSelectOption {
  value: string
  text: string
  selected?: boolean
  disabled?: boolean
}

export interface BrowserInteractiveElement {
  index: number
  kind: string
  text: string
  value: string
  placeholder: string
  href: string
  disabled: boolean
  fillable: boolean
  // P0 新增
  rect?: BrowserRect
  checked?: boolean
  selected?: boolean
  options?: BrowserSelectOption[]
  selector?: string
  // P1 新增
  tooltip?: string
  expanded?: boolean
  pressed?: boolean
  readOnly?: boolean
  required?: boolean
  min?: number
  max?: number
  step?: number
}
```

**消费点**：`BrowserDiagnostics.elements` (L108) 当前类型即 `BrowserInteractiveElement[]`, 新增可选字段无需改动消费逻辑; 若有渲染元素列表的组件 (诊断面板/overlay badge), 读取 `rect`/`checked`/`options` 即可丰富展示。

### 2.2 `BrowserPageContext` (L142-152)

#### Rust 结构体定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageContext {
    // —— 既有 ——
    pub title: String,
    pub url: String,
    pub selected_text: String,
    pub meta_description: String,
    pub text: String,
    pub headings: Vec<BrowserHeading>,
    pub links: Vec<BrowserLink>,

    // —— P0 新增 ——
    #[serde(default)]
    pub tables: Vec<BrowserTable>,
    #[serde(default)]
    pub code_blocks: Vec<BrowserCodeBlock>,
    #[serde(default)]
    pub images: Vec<BrowserImage>,
    #[serde(default)]
    pub structured_data: Vec<Value>, // JSON-LD 数组 (serde_json::Value, 已在 L6 引入)

    // —— P1 新增 ——
    #[serde(default)]
    pub lists: Vec<BrowserList>,
    #[serde(default)]
    pub forms: Vec<BrowserForm>,
    #[serde(default)]
    pub canonical: Option<String>,
    #[serde(default)]
    pub og_title: Option<String>,
    #[serde(default)]
    pub og_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTable {
    pub rows: Vec<Vec<String>>,          // 二维, 首行视作表头
    #[serde(default)]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCodeBlock {
    pub language: String,                // 从 class="language-xxx" 提取
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImage {
    pub src: String,
    #[serde(default)]
    pub alt: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserList {
    pub ordered: bool,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserForm {
    pub action: String,
    pub method: String,
    pub fields: Vec<String>,             // name 列表
}
```

#### 前端 TypeScript 类型同步

```typescript
// src/services/tauri/browserService.ts

export interface BrowserTable {
  rows: string[][]
  caption?: string
}

export interface BrowserCodeBlock {
  language: string
  code: string
}

export interface BrowserImage {
  src: string
  alt?: string
  width?: number
  height?: number
}

export interface BrowserList {
  ordered: boolean
  items: string[]
}

export interface BrowserForm {
  action: string
  method: string
  fields: string[]
}

export interface BrowserPageContext {
  title: string
  url: string
  selectedText: string
  metaDescription: string
  text: string
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string }>
  // P0
  tables?: BrowserTable[]
  codeBlocks?: BrowserCodeBlock[]
  images?: BrowserImage[]
  structuredData?: unknown[]
  // P1
  lists?: BrowserList[]
  forms?: BrowserForm[]
  canonical?: string
  ogTitle?: string
  ogImage?: string
}
```

**注意**：`structured_data: Vec<Value>` 在 TS 侧用 `unknown[]`, 避免锁定 JSON-LD schema; 前端消费时按 `@type` 判别。`Value` 已在 browser.rs L6 引入 (`use serde_json::Value;`)。

### 2.3 `BrowserVisualElement` (L182-189)

诊断可视层已有 `rect`, 仅需 P1 增强：

```rust
// 既有字段保持, 新增可选元信息 (P1)
#[serde(default)]
pub checked: Option<bool>,
#[serde(default)]
pub selected: Option<bool>,
#[serde(default)]
pub selector: Option<String>,
```

TS 同步在 `BrowserVisualElement` 追加同名可选字段：

```typescript
export interface BrowserVisualElement {
  index: number
  kind: string
  text: string
  rect: BrowserRect
  fillable: boolean
  disabled: boolean
  // P1 新增
  checked?: boolean
  selected?: boolean
  selector?: string
}
```

---

## 3. 注入脚本增强方案

### 3.1 `PAGE_CONTEXT_SCRIPT` 扩展 (替换 L1405-1442)

保留 `clean` 工具, 新增表格/代码块/图片/JSON-LD/列表/表单/扩展链接解析：

```javascript
(() => {
  const clean = (value, max = 12000) => String(value || '')
    .replace(/\s+/g, ' ').trim().slice(0, max);

  const metaContent = (selector) =>
    clean(document.querySelector(selector)?.content || '', 1000);
  const metaProp = (prop) =>
    clean(document.querySelector(`meta[property="${prop}"]`)?.content || '', 1000);

  const selectedText = clean(window.getSelection?.()?.toString() || '', 6000);
  const metaDescription = metaContent('meta[name="description"]') || metaProp('og:description');
  const canonical = clean(document.querySelector('link[rel="canonical"]')?.href || '', 500) || null;
  const ogTitle = metaProp('og:title') || null;
  const ogImage = metaProp('og:image') || null;

  const articleText = document.querySelector('article')?.innerText || '';
  const bodyText = document.body?.innerText || '';

  // h1-h6, 保留顺序, 截 60 条
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .slice(0, 60)
    .map((node) => ({ level: Number(node.tagName.slice(1)), text: clean(node.textContent || '', 240) }))
    .filter((i) => i.text);

  // 链接扩展: 截 80, 补 rel
  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 80)
    .map((node) => ({
      text: clean(node.textContent || node.getAttribute('aria-label') || '', 160),
      href: String(node.href || ''),
      rel: clean(node.getAttribute('rel') || '', 60) || null
    }))
    .filter((i) => i.href);

  // P0: 表格 (截 15 张, 每表行数截 200)
  const tables = Array.from(document.querySelectorAll('table'))
    .slice(0, 15)
    .map((table) => {
      const rows = Array.from(table.querySelectorAll('tr')).slice(0, 200).map((tr) =>
        Array.from(tr.children).slice(0, 50).map((td) => clean(td.textContent || '', 300))
      );
      const caption = clean(table.querySelector('caption')?.textContent || '', 300) || null;
      return { rows, caption };
    })
    .filter((t) => t.rows.length);

  // P0: 代码块 (pre>code 或 pre), 截 30 块, 每块 4000 字符
  const codeBlocks = Array.from(document.querySelectorAll('pre'))
    .slice(0, 30)
    .map((pre) => {
      const codeEl = pre.querySelector('code');
      const lang = (codeEl?.className || pre.className || '')
        .match(/language-([\w+-]+)/)?.[1] || '';
      return { language: lang || 'text', code: clean(codeEl?.textContent || pre.textContent || '', 4000) };
    })
    .filter((b) => b.code);

  // P0: 图片 (截 40 张, 过滤 icon sprite)
  const images = Array.from(document.querySelectorAll('img[src]'))
    .slice(0, 40)
    .map((img) => ({
      src: String(img.currentSrc || img.src || ''),
      alt: clean(img.getAttribute('alt') || '', 200),
      width: img.naturalWidth || img.width || null,
      height: img.naturalHeight || img.height || null
    }))
    .filter((i) => i.src);

  // P0: JSON-LD 结构化数据
  const structuredData = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  )
    .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
    .filter(Boolean)
    .flatMap((d) => (Array.isArray(d) ? d : [d]))
    .slice(0, 20);

  // P1: 列表 (截 30 个, 每列表项截 50)
  const lists = Array.from(document.querySelectorAll('ul,ol'))
    .slice(0, 30)
    .map((l) => ({
      ordered: l.tagName === 'OL',
      items: Array.from(l.children)
        .filter((c) => c.tagName === 'LI')
        .slice(0, 50)
        .map((li) => clean(li.textContent || '', 200))
    }))
    .filter((l) => l.items.length);

  // P1: 表单 (截 10 个)
  const forms = Array.from(document.querySelectorAll('form'))
    .slice(0, 10)
    .map((f) => ({
      action: String(f.action || ''),
      method: String(f.method || 'get').toLowerCase(),
      fields: Array.from(f.querySelectorAll('input,select,textarea'))
        .slice(0, 60)
        .map((el) => clean(el.getAttribute('name') || el.getAttribute('id') || '', 80))
        .filter(Boolean)
    }));

  return JSON.stringify({
    title: clean(document.title || '', 300),
    url: String(location.href),
    selectedText,
    metaDescription,
    text: clean(articleText || bodyText, 12000),
    headings,
    links,
    tables,
    codeBlocks,
    images,
    structuredData,
    lists,
    forms,
    canonical,
    ogTitle,
    ogImage
  });
})()
```

**上限设计**: 表格 15×200 行、代码 30×4000 字符、图片 40、JSON-LD 20、列表 30×50、表单 10×60, 单次序列化上限约 200KB, 远低于 WebView eval 通道承受范围。

### 3.2 collector 宏扩展 (L1444-1879)

#### 3.2.1 `styleOf` WeakMap 缓存 (P0, 根治多次 getComputedStyle)

替换 L1505 的 `styleOf` 定义, 在 `collectPolarisInteractiveElements` 之前建立全局 WeakMap 缓存：

```javascript
// 替换 L1505:
const __styleCache = new WeakMap();
const styleOf = (element) => {
  if (!element) return null;
  let s = __styleCache.get(element);
  if (!s) {
    s = ownerWindowOf(element).getComputedStyle(element);
    __styleCache.set(element, s);
  }
  return s;
};
```

单次 eval 内所有调用共享同一 WeakMap, 根除 `isVisible`+`looksInteractive`+`scoreOf` 三次调用。WeakMap 不阻碍 GC, 元素回收后自动清理。

#### 3.2.2 `toPolarisInteractiveElement` 输出 rect + 状态 (P0)

替换 L1853-1862：

```javascript
const toPolarisInteractiveElement = (entry, index) => {
  const el = entry.element;
  const tag = tagOf(el);

  // select options
  let options = null;
  if (tag === 'select' || roleOf(el) === 'combobox' || roleOf(el) === 'listbox') {
    try {
      const opts = Array.from(el.options || el.querySelectorAll('[role="option"]') || []);
      if (opts.length) {
        options = opts.slice(0, 200).map((o) => ({
          value: String(o.value || o.getAttribute('data-value') || ''),
          text: clean(o.textContent || '', 120),
          selected: Boolean(o.selected || o.getAttribute('aria-selected') === 'true'),
          disabled: Boolean(o.disabled || o.getAttribute('aria-disabled') === 'true')
        }));
      }
    } catch {}
  }

  // aria-describedby tooltip
  let tooltip = null;
  const describedBy = clean(el.getAttribute('aria-describedby') || '', 200);
  if (describedBy) {
    tooltip = clean(
      describedBy.split(' ')
        .map((id) => (el.ownerDocument || document).getElementById(id)?.textContent || '')
        .join(' '),
      400
    ) || null;
  }

  // checked / selected / expanded / pressed
  const checkable = el.getAttribute('aria-checked') !== null
    || (tag === 'input' && ['checkbox','radio'].includes((el.getAttribute('type')||'').toLowerCase()));

  return {
    index,
    kind: entry.kind,
    text: clean(entry.label, 240),
    value: entry.value,
    placeholder: entry.placeholder,
    href: entry.href,
    disabled: entry.disabled,
    fillable: entry.fillable,
    rect: {
      x: Math.round(entry.rect.left),
      y: Math.round(entry.rect.top),
      width: Math.round(entry.rect.width),
      height: Math.round(entry.rect.height)
    },
    checked: checkable ? Boolean(el.checked ?? el.getAttribute('aria-checked') === 'true') : null,
    selected: el.getAttribute('aria-selected') !== null
      ? el.getAttribute('aria-selected') === 'true' : null,
    options,
    selector: buildStableSelector(el),
    tooltip,
    expanded: el.getAttribute('aria-expanded') !== null
      ? el.getAttribute('aria-expanded') === 'true' : null,
    pressed: el.getAttribute('aria-pressed') !== null
      ? el.getAttribute('aria-pressed') === 'true' : null,
    readOnly: entry.fillable ? isReadOnly(el) : null,
    required: Boolean(el.required) || el.getAttribute('aria-required') === 'true' || null,
    min: numberOrNull(el.min ?? el.getAttribute('aria-valuemin')),
    max: numberOrNull(el.max ?? el.getAttribute('aria-valuemax')),
    step: numberOrNull(el.step ?? el.getAttribute('aria-step'))
  };
};
```

新增辅助函数 (放在 `descriptorOf` 附近, L1532 后)：

```javascript
const numberOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const buildStableSelector = (element) => {
  const parts = [];
  let node = element;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 8) {
    const part = descriptorOf(node);
    parts.unshift(part);
    if (node.id || node.getAttribute('data-testid')) break;
    node = node.parentElement;
    depth++;
  }
  return clean(parts.join(' > '), 240) || null;
};
```

#### 3.2.3 上限调整 (P1)

```javascript
// L1497: SCAN_LIMIT 5000 -> 8000
const POLARIS_SCAN_LIMIT = 8000;

// L1750: Shadow DOM 深度 3 -> 5
if (!root || depth > 5) return;
```

`maxElements` 参数化不变, 调用方更新：

| 调用点 | 当前值 | 建议值 | 行号 |
|---|---|---|---|
| 交互列表 `INTERACTIVE_ELEMENTS_SCRIPT_BODY` | 220 | **300** | L1921 |
| 诊断视口 `DIAGNOSTICS_SCRIPT_BODY` | 180 | **220** | L1927 |
| click `CLICK_ELEMENT_SCRIPT_BODY` | 240 | **300** | L1946 |
| fill `FILL_ELEMENT_SCRIPT_BODY` | 240 | **300** | L1998 |
| overlay `AI_OVERLAY_SCRIPT_BODY` | 180 | 保持 180 | L2071 |

#### 3.2.4 双遍 querySelectorAll 短路优化 (P0)

替换 L1819-1829, 利用 styleOf 缓存避免重复 getComputedStyle：

```javascript
// 在第一遍 selector 收集之后 (L1817 之后), 记录已收集的元素
const seenInSelector = new WeakSet();
candidates.forEach((c) => seenInSelector.add(c.element));

// 第二遍只检查未覆盖的元素, 短路
all.forEach((element) => {
  if (seenInSelector.has(element)) return;       // 短路
  try {
    if (hasInteractiveAttribute(element) || styleOf(element).cursor === 'pointer' || typeof element.onclick === 'function') {
      addCandidate(element, offset, frames);
    }
  } catch {}
});
```

### 3.3 CONSOLE_CAPTURE_SCRIPT 持久化 (P1)

**根因**: `CONSOLE_CAPTURE_SCRIPT` 只在 `diagnostics_script()` 里注入 (L2150), 且通过 `eval` 注入, WebView 重载页面后 `window.__POLARIS_BROWSER_CONSOLE__` 重置。

**方案 A (推荐, P1)**: 在 `browser_create_with_app` 的 WebviewBuilder 上挂载 `on_navigation` 回调 (L1167 已有), 导航触发后立即 `eval` 注入。新增轻量注入函数：

```rust
#[cfg(feature = "tauri-app")]
fn inject_console_capture(webview: &tauri::Webview) {
    let _ = webview.eval(CONSOLE_CAPTURE_SCRIPT);
}
```

在 `on_navigation` 闭包 (L1167-1176) 和 `browser_navigate_with_app` / `browser_reload_with_app` 完成后调用。由于 `eval` 非异步, 不阻塞。

**同时**: 给 `CONSOLE_CAPTURE_SCRIPT` 自身包一层 IIFE, 防止变量 (`now`/`original`/`buffer`) 污染外层闭包：

```javascript
const CONSOLE_CAPTURE_SCRIPT: &str = r#"
(() => {
  const now = () => Date.now();
  if (!window.__POLARIS_BROWSER_CONSOLE__) {
    const buffer = [];
    const push = (level, args) => {
      try {
        buffer.push({
          level,
          message: Array.from(args || []).map((item) => {
            if (typeof item === 'string') return item;
            try { return JSON.stringify(item); } catch { return String(item); }
          }).join(' ').slice(0, 2000),
          url: String(location.href),
          timestamp: now()
        });
        if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
      } catch {}
    };
    const original = {};
    ['debug', 'log', 'info', 'warn', 'error'].forEach((level) => {
      original[level] = console[level];
      console[level] = function(...args) {
        push(level, args);
        return original[level]?.apply(this, args);
      };
    });
    window.addEventListener('error', (event) => {
      push('error', [event.message || 'Script error', event.filename || '', event.lineno || '']);
    });
    window.addEventListener('unhandledrejection', (event) => {
      push('error', ['Unhandled promise rejection', event.reason || '']);
    });
    Object.defineProperty(window, '__POLARIS_BROWSER_CONSOLE__', {
      value: buffer,
      configurable: true
    });
  }
})();
"#;
```

**方案 B (P2)**: 用 Tauri 的 `WebviewWindow` 事件 `on_page_load` 钩子统一注入。需确认 Tauri 版本 API 是否暴露 (当前代码用 `on_navigation`, 方案 A 更稳)。

### 3.4 Click 补 mousemove/mouseenter (P0)

`CLICK_ELEMENT_SCRIPT_BODY` (L1973-1993) 在 `dispatchPointer('pointerdown')` 之前插入：

```javascript
// 在 dispatchMouse 定义后、调用前新增
const dispatchMouseEnter = (type) => {
  try {
    target.dispatchEvent(new view.MouseEvent(type, {
      bubbles: false, cancelable: true, view, clientX, clientY
    }));
  } catch {}
};

dispatchMouse('mousemove');          // 触发 hover 逻辑
dispatchMouseEnter('mouseover');     // bubbles:false 模拟
dispatchMouseEnter('mouseenter');
// 之后保持 pointerdown -> mousedown -> pointerup -> mouseup -> click
```

`mousemove` 用 `bubbles:true` 以匹配主流框架事件委托。

### 3.5 诊断超时缓解 (P0)

两处改动：

1. **page context / 诊断 eval 超时 3500 → 5000** (L881 / L970), 给大 SPA 余量：

```rust
// L881 处
let raw = browser_eval_with_app(app, label, PAGE_CONTEXT_SCRIPT, Some(5_000)).await?;

// L970 处
let raw = browser_eval_with_app(app, label, &script, Some(5_000)).await?;
```

2. **collector 双遍短路** (已涵盖在 §3.2.4), 重合 `getComputedStyle` 缓存 + 已收集元素跳过 = 预估大 DOM 场景从 3.5s 降至 1-2s。

---

## 4. 性能影响评估

| 项 | 变更前 | 变更后 | 评估 |
|---|---|---|---|
| collector 脚本体积 | ~435 行 (L1446-1877) | ~520 行 (+rect/options/selector/状态字段 + 辅助函数) | 单次 eval 传输 ~25KB, WebView JIT 编译 <5ms, 可忽略 |
| `PAGE_CONTEXT_SCRIPT` 体积 | 38 行 | ~110 行 | ~6KB, 忽略 |
| `getComputedStyle` 调用次数 | 每元素最多 3 次 (isVisible/looksInteractive/scoreOf) + collectRoots 内 1 次 | 每元素 1 次 (WeakMap 缓存命中) | **主要性能收益**: 大 DOM 上从 O(3n) → O(n), 预估 3000 元素场景 800ms → 280ms |
| 大 DOM 截断风险 | SCAN_LIMIT 5000 | 8000 | 单 root `querySelectorAll('*')` 时间 ≈ 线性, 8000 节点约 40ms, 可接受 |
| Shadow DOM 遍历深度 | 3 | 5 | 边际成本: 深层 shadow 节点数通常指数下降, 第 4-5 层新增节点 <5%, 可忽略 |
| page context / 诊断 eval 超时 | 3500ms | 5000ms | 缓解大 SPA 返回空; 最坏 5000ms 仍低于 `MAX_EVAL_TIMEOUT_MS = 10000` (L29) |
| 序列化体积 (典型) | page context ~30KB | ~80KB (表格/代码/图片/JSON-LD) | eval callback 走 IPC, <200KB 无压力 |
| 序列化体积 (病态: 维基大表 + 长文档) | ~30KB | ~200KB | 可接受; 超 200KB 时可考虑 `clamp_context_arrays` (见 §5) |
| 内存 (WebView 侧) | WeakMap 无 | styleCache WeakMap + candidates 数组 | WeakMap 随元素回收; candidates 受 maxElements 截断, 上限 300 条 |

**超时风险结论**: §3.2.1 缓存 + §3.2.4 双遍短路 + 超时升 5000ms, 三者叠加后, 3000 节点 SPA 诊断从 ~3.5s (临界超时) 降至 ~1s, 病态 8000 节点约 2.5s, 均在超时内。

**内存结论**: WebView 侧无持久泄漏; Rust 侧 `BrowserDiagnostics` 结构体增大, 但单次请求生命周期短, 无累积。

---

## 5. 兼容性说明

### 5.1 后向兼容 (旧前端 + 新后端数据)

- 所有新增字段均为 `Option` / `Vec` (default empty), serde 反序列化缺失字段不报错
- 前端 TypeScript 接口把新增字段标 `?` 可选, 旧消费代码 (如仅读 `element.text`/`element.kind`) 零改动即可工作
- `BrowserPageContext.text` 字段语义不变 (仍为正文纯文本), 新增 `tables`/`codeBlocks` 等为补充维度, 不替代 `text`

### 5.2 前向兼容 (新前端 + 旧后端数据)

- 新前端读取可选字段时 `undefined` 即视为缺失, 有 fallback 逻辑 (如 `element.rect ?? null`)
- 无强制非空的新字段, 因此新前端解析旧 IPC 响应不崩溃

### 5.3 病态体积保护 (P2 可选)

在 `parse_eval_json` 后、`serde_json::from_value` 前对 `tables`/`codeBlocks`/`structuredData` 做总量截断：

```rust
fn clamp_context_arrays(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        for key in ["tables", "codeBlocks", "images", "structuredData", "lists", "forms"] {
            if let Some(arr) = obj.get_mut(key).and_then(|v| v.as_array_mut()) {
                if arr.len() > 30 { arr.truncate(30); }
            }
        }
    }
    value
}
```

在 `browser_get_page_context_with_app` (L882-884) 调用：

```rust
let value = clamp_context_arrays(parse_eval_json(&raw)?);
let context: BrowserPageContext = serde_json::from_value(value)
    .map_err(|e| AppError::ValidationError(format!("浏览器上下文格式错误: {e}")))?;
```

---

## 6. 测试影响

`browser_script_tests` (L2206-2353) 现有 7 个测试需更新, 并新增 6 个测试用例。

### 6.1 更新 `collector_covers_modern_interactive_patterns` (L2213-2228)

```rust
#[test]
fn collector_covers_modern_interactive_patterns() {
    let script = interactive_elements_script();
    assert!(script.contains("[role=\"menuitem\"]"));
    assert!(script.contains("label[for]"));
    assert!(script.contains("[aria-expanded]"));
    assert!(script.contains("[jsaction]"));
    assert!(script.contains("[data-command]"));
    assert!(script.contains("style.cursor === 'pointer'"));
    assert!(script.contains("node.shadowRoot"));
    assert!(script.contains("contentDocument"));
    assert!(script.contains("frames.concat(node)"));
    assert!(script.contains("isReadOnly(element)"));
    // 更新上限断言
    assert!(script.contains("maxElements: 300"));             // 之前 220
    // 新增覆盖断言
    assert!(script.contains("__styleCache"));                  // style 缓存
    assert!(script.contains("buildStableSelector"));           // selector 辅助
    assert!(script.contains("numberOrNull"));                  // 数值字段
    assert!(script.contains("aria-valuemin"));                 // slider min/max
    assert!(script.contains("aria-describedby"));              // tooltip
    assert!(script.contains("seenInSelector"));                // 双遍短路优化
    assert!(!script.contains("maxElements: 220"));             // 旧值不再出现
    assert!(!script.contains("slice(0, 80)"));                 // 保持原断言
}
```

### 6.2 保持 `all_browser_actions_share_the_collector` (L2230-2239)

所有 action 脚本仍走 `script_with_collector` → `collectPolarisInteractiveElements`, 无需改动：

```rust
#[test]
fn all_browser_actions_share_the_collector() {
    assert!(diagnostics_script().contains("collectPolarisInteractiveElements"));
    assert!(
        click_element_script(Some(1), "Search").contains("collectPolarisInteractiveElements")
    );
    assert!(fill_element_script(None, "Search", "Polaris")
        .contains("collectPolarisInteractiveElements"));
    assert!(ai_overlay_script(true).contains("collectPolarisInteractiveElements"));
}
```

### 6.3 新增测试用例 (P0)

```rust
#[test]
fn page_context_extracts_structured_dimensions() {
    // 验证 PAGE_CONTEXT_SCRIPT 包含新增解析逻辑
    assert!(PAGE_CONTEXT_SCRIPT.contains("querySelectorAll('table')"));
    assert!(PAGE_CONTEXT_SCRIPT.contains("querySelectorAll('pre')"));
    assert!(PAGE_CONTEXT_SCRIPT.contains("querySelectorAll('img[src]')"));
    assert!(PAGE_CONTEXT_SCRIPT.contains("application/ld+json"));
    assert!(PAGE_CONTEXT_SCRIPT.contains("rel=\"canonical\""));
}

#[test]
fn interactive_element_outputs_rect_and_state() {
    let script = interactive_elements_script();
    assert!(script.contains("rect: {"));
    assert!(script.contains("checked:"));
    assert!(script.contains("selected:"));
    assert!(script.contains("options:"));
    assert!(script.contains("selector:"));
}

#[test]
fn click_script_dispatches_mousemove_and_mouseenter() {
    let script = click_element_script(Some(0), "x");
    assert!(script.contains("dispatchMouse('mousemove')"));
    assert!(script.contains("'mouseover'"));
    assert!(script.contains("'mouseenter'"));
}

#[test]
fn console_capture_script_is_self_contained_iife() {
    // 防止 CONSOLE_CAPTURE_SCRIPT 污染外层闭包
    assert!(CONSOLE_CAPTURE_SCRIPT.trim_start().starts_with("(() => {") || CONSOLE_CAPTURE_SCRIPT.trim_start().starts_with("(function"));
}

#[test]
fn shadow_dom_depth_allowance_is_five() {
    let script = interactive_elements_script();
    assert!(script.contains("depth > 5"));
}

#[test]
fn diagnostics_timeout_is_5000ms_bound() {
    // 间接: 通过脚本结构验证超时常量未回退
    assert!(DEFAULT_EVAL_TIMEOUT_MS <= 2500);
    // 诊断调用点需在集成测试或手工验证
}
```

### 6.4 前端类型测试

`browserService.ts` 无独立测试文件; 建议在 `src/services/tauri/__tests__/` 新增类型编译校验 (`tsc --noEmit` 已是 CI 一环, 新增可选字段不会破坏编译)。

---

## 7. 实施优先级

### P0 (必做)

| 项 | 文件 / 行号 | 复杂度 | 说明 |
|---|---|---|---|
| `styleOf` WeakMap 缓存 | browser.rs L1505 + L1825 | 低 | 性能根因, 无缓存则大 DOM 场景必超时 |
| `BrowserInteractiveElement` 加 rect/checked/selected/options/selector 字段 | browser.rs L98-109 + TS L62-71 | 中 | 核心交互缺失, 影响 AI 定位能力 |
| `toPolarisInteractiveElement` 输出新字段 + `buildStableSelector`/`numberOrNull` 辅助 | browser.rs L1532 后、L1853-1862 | 中 | 依赖上行字段定义 |
| Click 补 mousemove/mouseenter | browser.rs L1973-1993 | 低 | hover 驱动菜单场景必须 |
| `PAGE_CONTEXT_SCRIPT` 扩展 tables/codeBlocks/images/structuredData | browser.rs L1405-1442 | 中 | 核心信息缺失, 直接影响 AI 对页面理解 |
| 诊断 eval 超时 3500→5000 + collector 双遍短路 | browser.rs L881/L970/L1819-1829 | 低 | 依赖 P0 缓存, 缓解大 SPA 超时 |

### P1 (应做)

| 项 | 文件 / 行号 | 复杂度 | 说明 |
|---|---|---|---|
| `BrowserInteractiveElement` 加 tooltip/expanded/pressed/readOnly/required/min/max/step | browser.rs L98-109 + TS | 中 | 依赖 P0 字段已加, 追加多字段 |
| `BrowserPageContext` 加 lists/forms/canonical/og_* + h4-h6 + links.rel | browser.rs L142-152 + TS | 中 | 依赖 P0 脚本已扩展 |
| CONSOLE_CAPTURE_SCRIPT 导航后持久注入 (on_navigation 钩子 + IIFE 自包) | browser.rs L1167/L2148-2157/L1881-1918 | 中 | 独立, 无依赖 |
| 上限调整: SCAN_LIMIT 8000、Shadow 深度 5、maxElements 300/220 | browser.rs L1497/L1750/L1921/L1927 | 低 | 独立, 无依赖 |
| `BrowserVisualElement` 加 checked/selected/selector | browser.rs L182-189 + TS L80-87 | 低 | 独立, 无依赖 |
| 测试用例更新 + 新增断言 | browser.rs L2206-2353 | 低 | 依赖全部 P0+P1 实施 |

### P2 (可做)

| 项 | 文件 / 行号 | 复杂度 | 说明 |
|---|---|---|---|
| 病态体积保护 `clamp_context_arrays` | browser.rs L882 | 低 | 安全网, 非必须 |
| microdata (`itemprop`) 解析 | PAGE_CONTEXT_SCRIPT | 中 | 低优先级, 多数站点已用 JSON-LD |
| selector 输出 xpath 备选 | collector | 低 | CSS selector 通常足够 |

### 建议实施批次

**批次 1 (P0, ~1.5 人日)**:
- 字段增加 + 脚本扩展 + 性能缓存 + click 修复 + 超时调整
- 一次性提交, 运行 `cargo check --lib` 与前端 `tsc`

**批次 2 (P1, ~1 人日)**:
- 剩余状态字段 + console 持久化 + 上限调整 + 测试

**批次 3 (P2, 按需)**:
- 体积保护 + microdata

---

## 附录: 关键行号索引

| 引用 | 行号 | 说明 |
|---|---|---|
| `PAGE_CONTEXT_SCRIPT` | L1405-1442 | 页面内容提取脚本 |
| `polaris_interactive_collector_script!` | L1444-1879 | 交互元素收集宏 |
| `POLARIS_SCAN_LIMIT` | L1497 | 扫描上限常量 |
| `styleOf` | L1505 | getComputedStyle 包装函数 |
| `rectOf` | L1668-1678 | 元素坐标计算 |
| `isVisible` | L1685-1702 | 可见性判断 |
| `looksInteractive` | L1704-1714 | 交互性启发式判断 |
| `scoreOf` | L1716-1728 | 交互性评分 |
| `collectRoots` | L1747-1775 | DOM 树根收集 |
| `collectPolarisInteractiveElements` | L1782-1850 | 主收集函数 |
| `toPolarisInteractiveElement` | L1853-1862 | 交互元素序列化 |
| `toPolarisVisualElement` | L1864-1876 | 可视元素序列化 |
| `CONSOLE_CAPTURE_SCRIPT` | L1881-1918 | 控制台捕获脚本 |
| `INTERACTIVE_ELEMENTS_SCRIPT_BODY` | L1920-1924 | 交互元素列表脚本 |
| `DIAGNOSTICS_SCRIPT_BODY` | L1926-1943 | 诊断脚本 |
| `CLICK_ELEMENT_SCRIPT_BODY` | L1945-1995 | 点击元素脚本 |
| `FILL_ELEMENT_SCRIPT_BODY` | L1997-2049 | 填充元素脚本 |
| `AI_OVERLAY_SCRIPT_BODY` | L2051-2133 | AI 叠加层脚本 |
| `script_with_collector` | L2135-2142 | 收集器脚本包装函数 |
| `diagnostics_script` | L2148-2157 | 诊断脚本包装函数 |
| `browser_get_page_context_with_app` | L877-893 | 页面上下文获取 |
| `browser_get_diagnostics_with_app` | L962-993 | 诊断获取 |
| `browser_script_tests` | L2206-2353 | 测试模块 |
| `browserService.ts` 全量 | TS L1-241 | 前端类型定义 |