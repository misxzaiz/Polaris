# spec: cap.ui.render 图表节点扩展（chart）

> 日期：2026-10-25 · 状态：待实施
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
| 图表库 | Chart.js v4（CDN） | 成熟、轻量、支持多种图表类型 |
| 渲染位置 | 前端 React 组件内嵌 Canvas | 与既有 DSL 渲染器对齐，无需 iframes |
| 节点形态 | DSL 扩展 `chart` 节点 + 子节点 `datasets` | 保持声明式风格，参数化数据 |
| 模式 | 仅 `display`（fire-and-forget） | 图表为展示型，无需交互应答 |
| 持久化 | 不支持 | 图表数据临时性，不入 Storage |

---

## 4. DSL Schema（提案）

### 4.1 chart 节点定义

```typescript
type UiTemplateNode =
  | // ... 既有节点 ...
  | {
      type: 'chart'
      /** 图表类型：'line' | 'bar' | 'pie' */
      chartType: 'line' | 'bar' | 'pie'
      /** X 轴标签 */
      labels: string[]
      /** 数据集列表 */
      datasets: ChartDataset[]
      /** 图表标题（可选） */
      title?: string
      /** 是否显示图例（默认 true） */
      showLegend?: boolean
      /** 是否显示网格线（默认 true） */
      showGrid?: boolean
    }

/** 单个数据集 */
type ChartDataset = {
  /** 数据集标签（图例显示） */
  label: string
  /** 数据点值 */
  data: number[]
  /** 线条/柱子颜色（可选，默认自动分配） */
  color?: string
  /** 填充颜色（area 模式，可选） */
  fillColor?: string
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

## 5. 后端改动（Rust）

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

## 6. 前端改动（TypeScript/React）

### 6.1 类型扩展

**文件**：`src/plugin-system/uiFrameTypes.ts`

```typescript
export type UiTemplateNode =
  | { type: 'vstack'; gap?: UiGap; children: UiTemplateNode[] }
  | { type: 'hstack'; gap?: UiGap; align?: 'start' | 'center' | 'end'; children: UiTemplateNode[] }
  | { type: 'text'; content: string; tone?: UiTone; bold?: boolean }
  | { type: 'metric'; label?: string; value: string; hint?: string }
  | { type: 'badge'; label: string; tone?: UiTone }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'progress'; value: number; label?: string }
  | { type: 'divider'; label?: string }
  | { type: 'input'; field: string; label?: string; placeholder?: string; multiline?: boolean; default?: string }
  | { type: 'select'; field: string; options: string[]; label?: string; placeholder?: string; default?: string }
  | {
      /** 新增：图表节点 */
      type: 'chart'
      chartType: 'line' | 'bar' | 'pie'
      labels: string[]
      datasets: ChartDataset[]
      title?: string
      showLegend?: boolean
      showGrid?: boolean
    }

export type ChartDataset = {
  label: string
  data: number[]
  color?: string
  fillColor?: string
}
```

### 6.2 渲染器扩展

**文件**：`src/components/Chat/chatBlocks/uiTemplateNodes.tsx`

新增 `ChartNodeRenderer` 组件：

```tsx
import { useEffect, useRef } from 'react'
import Chart from 'chart.js/auto'

interface ChartNodeProps {
  node: {
    type: 'chart'
    chartType: 'line' | 'bar' | 'pie'
    labels: string[]
    datasets: ChartDataset[]
    title?: string
    showLegend?: boolean
    showGrid?: boolean
  }
}

const DEFAULT_COLORS = [
  '#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6'
]

export function ChartNodeRenderer({ node }: ChartNodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    
    // 销毁旧实例
    if (chartRef.current) {
      chartRef.current.destroy()
    }

    const ctx = canvasRef.current.getContext('2d')
    if (!ctx) return

    // 构建数据集
    const datasets = node.datasets.map((ds, i) => ({
      label: ds.label,
      data: ds.data,
      borderColor: ds.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      backgroundColor: ds.fillColor || (ds.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]) + '20',
      fill: node.chartType === 'area',
      tension: 0.3,
    }))

    // 创建图表
    chartRef.current = new Chart(ctx, {
      type: node.chartType === 'area' ? 'line' : node.chartType,
      data: { labels: node.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: node.showLegend !== false },
          title: { 
            display: !!node.title,
            text: node.title,
            color: '#e0e0e0',
            font: { size: 14 }
          },
          tooltip: {
            backgroundColor: '#16213e',
            titleColor: '#fff',
            bodyColor: '#ccc',
          }
        },
        scales: node.chartType !== 'pie' ? {
          x: { 
            grid: { color: '#2a2a4a' },
            ticks: { color: '#888' }
          },
          y: {
            grid: { color: '#2a2a4a' },
            ticks: { color: '#888' }
          }
        } : undefined
      }
    })

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy()
      }
    }
  }, [node])

  return (
    <div className="w-full p-3 rounded-lg bg-background-elevated">
      <canvas ref={canvasRef} className="max-h-80" />
    </div>
  )
}
```

### 6.3 注册到渲染器

**文件**：同上，在 `renderTemplateNodes` 函数中新增分支：

```tsx
case 'chart': {
  const chartNode = node as Extract<UiTemplateNode, { type: 'chart' }>
  return <ChartNodeRenderer key={i} node={chartNode} />
}
```

### 6.4 样式适配

图表容器使用主题 token：
- `bg-background-elevated` — 背景
- `border-border` — 边框（可选）
- `rounded-lg` — 圆角

---

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

## 10. 影响范围

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src-tauri/src/services/router/ui_render_capability.rs` | 修改 | 白名单 + 校验 |
| `src/plugin-system/uiFrameTypes.ts` | 修改 | 类型定义 |
| `src/components/Chat/chatBlocks/uiTemplateNodes.tsx` | 修改 | 渲染器 |
| `src/components/Chat/chatBlocks/UiFrameCard.tsx` | 小改 | 透传 chart 节点 |

---

## 11. 依赖

- Chart.js v4 CDN（`https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js`）
- 需在前端组件中 `import Chart from 'chart.js/auto'` 或动态加载

---

## 12. 测试计划

### 12.1 单元测试（前端）

```typescript
// src/plugin-system/uiFrameTypes.test.ts
describe('ChartDataset schema', () => {
  it('valid dataset', () => {
    expect(isChartDataset({ label: 'test', data: [1, 2, 3] })).toBe(true)
  })
  
  it('invalid data length', () => {
    expect(isChartDataset({ label: 'test', data: [1, 2] })).toBe(false) // labels 长度不匹配
  })
})
```

### 12.2 集成测试（Rust）

```rust
#[test]
fn test_validate_chart_node_valid() {
    let node = json!({
        "type": "chart",
        "chartType": "line",
        "labels": ["A", "B", "C"],
        "datasets": [{
            "label": "Series 1",
            "data": [1, 2, 3],
            "color": "#3b82f6"
        }]
    });
    assert!(validate_template_node(&node, 1, &mut 1).is_ok());
}

#[test]
fn test_validate_chart_node_invalid_type() {
    let node = json!({
        "type": "chart",
        "chartType": "3d", // 无效
        "labels": [],
        "datasets": []
    });
    assert!(validate_template_node(&node, 1, &mut 1).is_err());
}
```

---

**文档版本**：v1.0  
**最后更新**：2026-10-25  
**状态**：待实施
