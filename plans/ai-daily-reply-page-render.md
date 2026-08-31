# AI 日常回复页面化 — 实施规划

> 创建: 2026-08-31 | 状态: 规划定稿
> 目标: 让 AI 的日常回复（讲解方案 / 对比 / 路线图 / 分析）默认产出页面级 HTML 渲染，而非纯 Markdown 文字堆叠
> 前序分析: 见对话中"AI HTML 页面级渲染"方案对比（A/B/C 矩阵 + DSL 否决）

---

## 0. 问题定义

**现状**：AI 回复走 `TextBlockRenderer` → `ProgressiveStreamingMarkdown`，纯 Markdown 文字堆叠，内容一多难读。
**诉求**：AI 日常回复达到 PRD 原型页面的渲染效果（设计感布局、深色主题、栅格/卡片/对比矩阵）。
**差距定位**：渲染层已具备（`ArtifactPreviewRenderer` 沙箱 iframe + `preview_html` MCP 工具）。缺口在**触发层**——AI 默认走 Markdown，只有显式调 `preview_html` 才出页面，且调用成本高、引擎兼容参差。

**核心判断**：让"默认页面化"落地 = 降低触发成本 + 重塑默认行为。不发明 DSL，走"约束式 HTML + 沙箱隔离"。

---

## 1. 三阶段路线图

### P0 · 系统提示重塑（零代码，ROI 最高）

让 AI 在合适场景主动产出页面，而非长文。提示词要克制——纯问答/闲聊仍走文字，避免每句套页面壳反噬体验。

**触发场景约定**（命中即产出页面）：
- 方案对比 / 选型分析（多维度矩阵）
- 路线图 / 阶段规划 / 时间线
- 原型界面 / 看板 / 仪表盘
- 多步骤教程 / 操作指南（卡片栅格）
- 结构化报告 / 验收总结

**反例**（仍走 Markdown 文字）：
- 纯问答、闲聊、确认
- 单段解释、单一代码片段
- 简短列表、单层 bullet

**产出约束**（约束式 HTML 壳）：
1. 自包含完整 HTML 文档（`<!doctype html>` 起）
2. 内联 CSS，**禁外部 CDN / 外部资源**（离线/内网可用）
3. 深色优先，色板与 Polaris 主题对齐（cyan/violet/amber/green/red 语义色）
4. 响应式，`max-width` 限宽，移动端可读
5. 无 `<script>` 或仅限纯展示逻辑，无外发请求

**落点**：
- `append_system_prompt` 注入（`src-tauri/src/commands/chat.rs:1221` / `:1752`）
- 由 `with_append_system_prompt`（`src-tauri/src/ai/traits.rs:530`）组装到 SessionOptions
- 多引擎通用：append 段对所有引擎生效

**产出通道（P0 阶段）**：调 `preview_html` MCP 工具（现有，零改造）
- 引擎会用 MCP 工具即可走通（pi / SimpleAI / codex 等）
- 产出落盘 `.polaris/previews/<uuid>/`，带版本 + 元数据

**P0 验收**：
- [ ] 给 AI "对比 X 与 Y" 类问题，AI 主动调 `preview_html` 产出对比矩阵页面
- [ ] 给 AI "路线图" 类问题，AI 主动产出阶段卡片页面
- [ ] 给 AI 简单问答，AI 仍走 Markdown（不误触发）
- [ ] 产出页面深色主题与 Polaris 一致，无外链依赖

---

### P1 · fenced html-preview 块（降触发成本 + 多引擎兜底）

P0 依赖引擎会调 MCP 工具，有惰性。P1 让 AI 直接在 Markdown 流里写 HTML，闭合即渲染，触发成本接近零，且引擎无关。

**核心改造**：`splitByCodeBlocks`（`src/utils/lightweightMarkdown.tsx:358`）增加 `html-block` 类型。

**info string 区分**（关键设计，避免误触发）：
- ` ```html ` → 讲解用代码块（现状，不高亮直接展示源码）
- ` ```html-preview ` → 展示用页面块（新增，闭合后渲染为 iframe）

**流式行为**（复用现有分派骨架，DOM 无跳变）：
- 未闭合：复用 `StreamingCodeBlock` 展示代码进度（用户可看生成过程）
- 闭合瞬间：替换为 `ArtifactPreviewRenderer` iframe 卡片

**改造点清单**：
1. `splitByCodeBlocks`（`lightweightMarkdown.tsx:358`）
   - 类型联合加 `'html-block'`
   - 正则匹配 ` ```html-preview ` 闭合块
   - 与 mermaid/code-block 互斥（已 有 overlaps 去重逻辑可复用）
2. `ProgressiveStreamingMarkdown`（`lightweightMarkdown.tsx:573`）
   - parts.map 分派加 `html-block` 分支
   - 闭合 → `<ArtifactPreviewRenderer>`；未闭合 → `<StreamingCodeBlock>`
3. `renderContentBlock`（`chatBlocks/index.tsx:84`）
   - 无需改（fenced 块在 text block 内部分派，不进 ContentBlock 路由）

**落盘复用**（补齐 B 方案唯一短板）：
- 闭合 html-preview 块异步落盘到 `.polaris/previews/`
- 复用 `PreviewRepository`（`prd_preview_mcp_server.rs:378`）
- 历史恢复 / 版本化 / 下载 / 全屏全部免费获得
- 渲染出口统一到 `ArtifactPreviewRenderer`

**缓存规避**（性能保护）：
- html 内容已被 `splitByCodeBlocks` 从 marked 路径剥离
- 天然不进 `MarkdownRenderCache`（50 条 LRU）
- 仅需确认不要把大 HTML 文本塞进任何 LRU

**P1 验收**：
- [ ] AI 输出 ` ```html-preview ` 闭合块，流式过程可见代码进度
- [ ] 闭合后自动替换为 iframe 卡片，无 DOM 结构跳变
- [ ] ` ```html ` 仍为讲解用代码块，不误触发
- [ ] 闭合块异步落盘，重开会话可从磁盘重建
- [ ] 不支持 MCP 的引擎（如纯 CLI 引擎）也能走 fenced 块产出页面

---

### P2 · 主题壳注入（深浅色一致性，锦上添花）

iframe 拿不到 Polaris CSS 变量，AI 页面与宿主主题割裂。P2 在 srcDoc 外层包壳注入主题 token。

**改造点**：
1. `ArtifactPreviewRenderer`（`chatBlocks/ArtifactPreviewRenderer.tsx:176`）
   - 构建 srcDoc 时注入 `.polaris-theme` 当前 token
   - 序列化 CSS 变量到 `:root`
2. 主题切换桥接
   - 深浅色切换时通知 iframe 重渲染（postMessage 或 srcDoc 重建）
3. 与主题系统衔接
   - 对齐 7 层 88 维度主题定稿（见 memory `theme-system-10round-research`）

**P2 验收**：
- [ ] AI 产出页面深浅色跟随宿主切换
- [ ] CSS 变量与 Polaris 主题 token 一致
- [ ] 切换主题时 iframe 内页面同步更新

---

## 2. 分派基础设施复用清单（全部现成）

| 基础设施 | 位置 | 复用方式 |
|---|---|---|
| 块级分派 | `splitByCodeBlocks` (`lightweightMarkdown.tsx:358`) | 加 `html-block` 类型，复用 overlaps 去重 |
| 块级路由 | `renderContentBlock` (`chatBlocks/index.tsx:84`) | fenced 块在 text 内部分派，无需改 |
| 压缩旁路 | `messageCompactor.ts:285` | artifact_preview 不压缩，新块走 default 透传 |
| 落盘复用 | `PreviewRepository` (`prd_preview_mcp_server.rs:378`) | 版本递增 + metadata |
| UI 复用 | `ArtifactPreviewRenderer` | 全屏 / 下载 / 源码 / 浏览器打开 |
| 双端可读 | Web + Tauri | 均可从磁盘重建 |

---

## 3. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| AI 滥用页面化（每句套壳） | 体验反噬，加载慢 | P0 提示词明确反例；场景白名单 |
| 大 HTML 进缓存 | LRU 崩命中率 | P1 已从 marked 路径剥离，天然规避 |
| 半截 HTML 流式抖动 | 视觉不稳定 | 未闭合走 StreamingCodeBlock，闭合才替换 |
| 多引擎行为不一 | 部分引擎不触发 | P1 fenced 块引擎无关，兜底 |
| iframe 主题割裂 | 视觉不一致 | P2 主题壳注入 |

---

## 4. 实施顺序与依赖

```
P0（零代码，提示词）─┐
                     ├─→ 可独立见效，不依赖 P1
P1（fenced 块分派）─┘
                     │
                     └─→ P2（主题壳注入）依赖 P1 渲染出口稳定
```

- **P0 可立即落地**，不改任何代码，仅系统提示词
- **P1 是核心**，让"默认页面化"真正低成本生效
- **P2 锦上添花**，P1 稳定后再做

---

## 5. 关键文件索引

| 文件 | 角色 |
|---|---|
| `src/utils/lightweightMarkdown.tsx:358` | `splitByCodeBlocks` 分派（P1 改造点） |
| `src/utils/lightweightMarkdown.tsx:573` | `ProgressiveStreamingMarkdown` 渲染（P1 改造点） |
| `src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx:176` | iframe 沙箱渲染（P2 主题壳注入点） |
| `src/components/Chat/chatBlocks/index.tsx:84` | `renderContentBlock` 路由（无需改） |
| `src-tauri/src/services/prd_preview_mcp_server.rs:238` | `preview_html` MCP 工具（P0 通道） |
| `src-tauri/src/commands/chat.rs:1221`/`1752` | `append_system_prompt` 注入（P0 落点） |
| `src-tauri/src/ai/traits.rs:530` | `with_append_system_prompt` 组装（P0 落点） |
