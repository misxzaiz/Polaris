# spec: cap.ui.render 图表节点扩展（chart）

> 日期：2026-10-25 · 状态：**已实施（2026-10-25，v1.1 修订选型为自绘 SVG）**
> 背景：`cap.ui.render` DSL 当前不支持图表节点，导致折线图/柱状图等可视化需求需绕道 HTML 预览或表格。本方案扩展 DSL 白名单，增加声明式图表节点。

---

## 1. 目标

在 `cap.ui.render` 的 DSL 模板系统中新增 `chart` 节点类型，支持：
- 折线图（line）
- 柱状图（bar）
- 饼图（pie）
- 面积图（area，可选）

使 AI 可通过 `cap.ui.render request` 直接渲染数据可视化卡片，无需跳转 HTML 预览。

---

## 2. 现状分析

### 2.1 DSL 节点白名单（当前）

```rust
// src-tauri/src/services/router/ui_render_capability.rs:90-101
const TEMPLATE_NODE_TYPES: &[&str] = &[
    "vstack", "hstack", "text", "metric", "badge",
    "table", "progress", "divider", "input", "select",
];
```

**缺口**：无 `chart` 类型，图表能力为零。

### 2.2 前端渲染器

- `src/components/Chat/chatBlocks/UiFrameCard.tsx` — 主渲染入口
- `src/components/Chat/chatBlocks/uiTemplateNodes.tsx` — DSL 节点渲染（需扩展）
- `src/plugin-system/uiFrameTypes.ts` — 类型定义（需扩展）

### 2.3 安全边界

- DSL 不做任意 HTML/JS 注入（v1 取向延续）
- 图表数据由后端校验 + 前端渲染，无执行面
- 可选支持 Chart.js CDN（静态资源，无脚本注入风险）

---

## 3. 设计决定

| 决策点 | 选择 | 理由 |
|---|---|---|
| 图表实现 | **自绘 SVG（v1.1 修订，实施采用）** | 零新依赖；SVG 经 style 注入 `rgb(var(--c-*))` 完全主题化，无硬编码颜色；DSL 数据规模（labels ≤100 / datasets ≤10）手绘完全可控；hover 用原生 `<title>` |
| ~~图表库~~ | ~~Chart.js v4（v1.0 原案，已否决）~~ | 原示例代码有三处 `area` 字面量比较（类型联合不含 area，TS2367）、硬编码颜色违反主题纪律、CDN 方案在桌面离线场景不可靠 |
| 渲染位置 | 前端 React 组件内嵌 SVG | 与既有 DSL 渲染器对齐，无需 iframes/canvas |
| 节点形态 | DSL 扩展 `chart` 节点 + `datasets` 数组 | 保持声明式风格，参数化数据；无 `fillColor`（bar 填充用 fill-opacity 表达） |
| 模式 | 仅 `display`（fire-and-forget） | 图表为展示型，无需交互应答 |
| 持久化 | 不支持 | 图表数据临时性，不入 Storage |

---

## 4. DSL Schema（提案）

### 4.1 chart 节点定义（v1.1 实施版）

```typescript
type UiTemplateNode =
  | // ... 既有节点 ...
  | {
      type: 'chart'
      /** 图表类型：'line' | 'bar' | 'pie'（area 不在 v1 契约内） */
      chartType: 'line' | 'bar' | 'pie'
      /** X 轴标签（pie 下与 data 一一对应） */
      labels: string[]
      datasets: UiChartDataset[]
      /** 图表标题（可选） */
      title?: string
      /** 是否显示图例（默认 true） */
      showLegend?: boolean
      /** 是否显示网格线（默认 true，pie 忽略） */
      showGrid?: boolean
    }

/** 单个数据集（无 fillColor：bar 填充用 fill-opacity 表达） */
type UiChartDataset = {
  /** 数据集标签（图例显示） */
  label: string
  /** 数据点值（与 labels 等长，后端校验） */
  data: number[]
  /** 数据语义色（可选 #RRGGBB，缺省走主题 CSS 变量色序列） */
  color?: string
}
```

### 4.2 示例：基金净值折线图

```json
{
  "type": "chart",
  "chartType": "line",
  "title": "自选基金净值走势",
  "labels": ["4月", "5月", "6月", "7月", "8月", "9月", "10月"],
  "showLegend": true,
  "datasets": [
    {
      "label": "008919 华夏能源",
      "data": [2.81, 3.15, 3.94, 2.93, 3.05, 2.89, 2.31],
      "color": "#f59e0b"
    },
    {
      "label": "005827 易方达中小",
      "data": [1.74, 1.65, 1.52, 1.51, 1.52, 1.49, 1.38],
      "color": "#3b82f6"
    }
  ]
}
```

---

## 5. 后端改动（Rust）——已实施

落点 `src-tauri/src/services/router/ui_render_capability.rs`：`TEMPLATE_NODE_TYPES` 白名单加 `"chart"`；`validate_template_node` 新增 `"chart"` 分支（chartType ∈ line/bar/pie、labels 1–100、datasets 1–10、data 与 labels 等长且为有限数字、color 须 #RRGGBB、title ≤120、showLegend/showGrid 布尔）。以下为设计草案（实现以代码为准，错误消息风格对齐既有中文前缀格式）：

### 5.1 扩展白名单

**文件**：`src-tauri/src/services/router/ui_render_capability.rs`

```rust
const TEMPLATE_NODE_TYPES: &[&str] = &[
    "vstack", "hstack", "text", "metric", "badge",
    "table", "progress", "divider", "input", "select",
    "chart",  // ← 新增
];
```

### 5.2 校验逻辑

**文件**：同上，在 `validate_template_node` 方法中新增分支：

```rust
"chart" => {
    let obj = node.as_object().ok_or("chart 节点必须是对象")?;
    
    // 校验 chartType
    let chart_type = obj.get("chartType")
        .and_then(|v| v.as_str())
        .ok_or("chart 缺少 chartType")?;
    match chart_type {
        "line" | "bar" | "pie" => {},
        _ => return Err(format!("未知 chartType: {}", chart_type)),
    }
    
    // 校验 labels
    let labels = obj.get("labels")
        .and_then(|v| v.as_array())
        .ok_or("chart 缺少 labels 数组")?;
    if labels.is_empty() || labels.len() > 100 {
        return Err("chart labels 数量必须 1-100".to_string());
    }
    
    // 校验 datasets
    let datasets = obj.get("datasets")
        .and_then(|v| v.as_array())
        .ok_or("chart 缺少 datasets 数组")?;
    if datasets.is_empty() || datasets.len() > 10 {
        return Err("chart datasets 数量必须 1-10".to_string());
    }
    
    for (i, ds) in datasets.iter().enumerate() {
        let ds_obj = ds.as_object().ok_or(format!("dataset[{}] 必须是对象", i))?;
        
        // label 必填
        ds_obj.get("label")
            .and_then(|v| v.as_str())
            .ok_or(format!("dataset[{}] 缺少 label", i))?;
        
        // data 必填且与 labels 等长
        let data = ds_obj.get("data")
            .and_then(|v| v.as_array())
            .ok_or(format!("dataset[{}] 缺少 data", i))?;
        if data.len() != labels.len() {
            return Err(format!("dataset[{}] data 长度 {} 与 labels 长度 {} 不一致", 
                i, data.len(), labels.len()));
        }
        
        // 可选字段校验
        if let Some(color) = ds_obj.get("color").and_then(|v| v.as_str()) {
            if !color.starts_with('#') || color.len() != 7 {
                return Err(format!("dataset[{}] color 格式错误: {}", i, color));
            }
        }
    }
    
    // 统计节点数
    *count += 1;
}
```

### 5.3 序列化不变

`chart` 节点透传，不做特殊序列化（保持 JSON 结构）。

---

## 6. 前端改动（TypeScript/React）——已实施

实现落点（v1.1 自绘 SVG 版）：

- `src/plugin-system/uiFrameTypes.ts`：`UiTemplateNode` 新增 `chart` 变体 + `UiChartDataset` 接口（见 §4.1）。
- `src/components/Chat/chatBlocks/chartNodeView.tsx`（新增）：`ChartNodeView` 渲染器。line/bar 走 `AxisChart`（viewBox 600×280，y 轴 nice 刻度 + 网格线，bar 用 fill-opacity，line 用 polyline + 数据点圆点）；pie 走 `PieChart`（扇区 path，单扇区 100% 退化为 circle，图例附百分比）。hover 提示用 SVG `<title>`；图例是 HTML div（便于换行）。
- `src/components/Chat/chatBlocks/uiTemplateNodes.tsx`：`renderNode` 加 `case 'chart'` 分发到 `ChartNodeView`。
- 主题纪律：默认系列色序列 = 主题 CSS 变量（`rgb(var(--c-primary))` / `--c-accent-ai` / `--c-status-*` 循环），**只能经 style 注入**（SVG presentation attribute 不解析 var()）；网格线用 `var(--c-border)`；文字 `fill="currentColor"` + Tailwind `text-text-*`。调用方显式 `color`（hex）是数据语义色，直接使用。
- x 轴标签 >16 个时隔位抽样显示（`labelStride`），避免重叠。
- NaN/Infinity 数据点渲染时钳制为 0（后端已校验拒绝，前端轻防御）。

## 7. 调用示例

### 7.1 注册模板（包含 chart 节点）

```bash
curl -X POST http://localhost:9829/api/router_dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "target": "cap.ui.render",
    "payload": {
      "action": "register",
      "templateId": "fund-nav-chart",
      "title": "基金净值走势",
      "dsl": [{
        "type": "chart",
        "chartType": "line",
        "title": "自选基金净值走势（近7个月）",
        "labels": ["4月", "5月", "6月", "7月", "8月", "9月", "10月"],
        "datasets": [
          {"label": "008919 华夏能源", "data": [2.81, 3.15, 3.94, 2.93, 3.05, 2.89, 2.31], "color": "#f59e0b"},
          {"label": "005827 易方达中小", "data": [1.74, 1.65, 1.52, 1.51, 1.52, 1.49, 1.38], "color": "#3b82f6"},
          {"label": "162411 华宝资源", "data": [0.90, 0.95, 0.82, 0.97, 1.02, 0.96, 1.02], "color": "#10b981"}
        ]
      }]
    }
  }'
```

### 7.2 渲染模板

```bash
curl -X POST http://localhost:9829/api/router_dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "target": "cap.ui.render",
    "payload": {
      "action": "request",
      "cardId": "frame-renderer",
      "frame": {
        "type": "template",
        "templateId": "fund-nav-chart",
        "params": {}
      },
      "mode": "display",
      "pluginId": "polaris.ui",
      "sessionId": "current-session"
    }
  }'
```

---

## 8. 验收标准

- [ ] `cargo check` 通过
- [ ] `pnpm exec tsc --noEmit` 通过
- [ ] `pnpm lint` 通过
- [ ] 注册含 `chart` 节点的模板成功
- [ ] `request` 渲染 `chart` 模板 → 对话页展示折线图
- [ ] 折线图支持悬停显示数值
- [ ] 多数据集正确显示不同颜色
- [ ] 图表响应式缩放
- [ ] 图表类型切换（line/bar/pie）正常工作

---

## 9. 边界与后续

### 9.1 明确不做

- **不实现 area 类型**（可后续扩展，当前仅 line/bar/pie）
- **不做实时数据更新**（图表静态，模板注册即固定）
- **不暴露 Canvas API 给 AI**（保持安全边界）
- **不做 3D 图表**（超出 DSL 设计哲学）

### 9.2 后续可扩展

- `gauge` 节点（仪表盘）
- `scatter` 节点（散点图）
- `heatmap` 节点（热力图）
- 图表交互（缩放、平移）

---

## 10. 影响范围（实施结果）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src-tauri/src/services/router/ui_render_capability.rs` | 修改 | 白名单 + chart 校验分支 + 5 个单测（本机 cargo test 受限，CI 兜底）+ describe 文案 |
| `src/plugin-system/uiFrameTypes.ts` | 修改 | `chart` 变体 + `UiChartDataset` |
| `src/components/Chat/chatBlocks/chartNodeView.tsx` | **新增** | 自绘 SVG 渲染器（AxisChart / PieChart / niceMax） |
| `src/components/Chat/chatBlocks/chartNodeView.test.tsx` | **新增** | 8 个 vitest 用例（全过） |
| `src/components/Chat/chatBlocks/uiTemplateNodes.tsx` | 修改 | `case 'chart'` 分发 |
| `src/components/Chat/chatBlocks/UiFrameCard.tsx` | 不改 | template 帧自动经 renderTemplateNodes 走到新 case |

---

## 11. 依赖

**无新增依赖**（v1.1 自绘 SVG；v1.0 原案的 Chart.js v4 CDN 方案已否决——桌面离线场景 CDN 不可靠，且引库需新增 npm 依赖）。

---

## 12. 测试计划——已落地

### 12.1 前端（`src/components/Chat/chatBlocks/chartNodeView.test.tsx`，8 用例全过）

- `niceMax` 刻度取整（1/2/5×10^k）
- line：折线数、每点 hover title、图例文本
- bar：柱矩形数量
- pie：扇区 path + 图例百分比；单扇区 100% 退化为 circle
- showLegend=false 图例消失；自定义 color 生效
- 默认系列色走主题 CSS 变量（style 注入断言）
- NaN 数据点钳制为 0，坐标不含 NaN
- vstack 嵌套 chart 经 renderTemplateNodes 统一入口渲染

### 12.2 Rust（`ui_render_capability.rs` tests 模块，5 用例）

valid 节点 / 非法 chartType（含 area）/ data 长度不匹配 / 坏 color（#12345、#GGGGGG、无 # 前缀）/ 空 labels 或空 datasets。本机 `cargo test --lib` 受 Tauri DLL 限制不可跑（AGENTS.md §九），由 CI 执行，本地以 `cargo check` 验证编译。

---

**文档版本**：v1.1（实施版：选型改自绘 SVG、删除 area/fillColor、标注已实施）  
**最后更新**：2026-10-25  
**状态**：已实施
