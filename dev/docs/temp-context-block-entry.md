---
name: temp-context-block-entry
title: 输入框临时上下文块（TCB）接收入口与维护说明
type: dev-note
status: implemented
version: 1.0
date: 2026-08-26
author: assistant
related: docs/specs/S004-chat-draft-save-load-spec.md
---

# 输入框临时上下文块（TCB）接收入口与维护说明

## 0. 文档定位

本文档是 **开发/维护说明**（dev note），描述 AI 对话输入框「临时上下文块（Temporary Context Block, TCB）」机制的**统一接收入口、数据结构、生命周期与维护约定**。

- 面向对象：后续在此机制上新增能力（新来源 kind、编辑、块管理）的开发者。
- 与规格文档的关系：需求级规格归 `docs/specs/`，本文档偏实现/维护级说明。
- 编写原则：**改动必须同步更新本文档**，保持单一事实来源；新增来源 kind 不得绕过统一入口。

---

## 1. 背景与目标

### 1.1 问题

AI 输入框原本只能接受文本与附件（image/file，走后端 `process_attachments` 落盘）。内置浏览器「圈选」产生的上下文此前通过 `BrowserPanel` 直接整体替换 `inputDraft` 草稿写入，**与浏览器圈选强耦合、无通用入口**，其它来源（文本选中、截图、插件产物）无法复用。

### 1.2 目标

- 抽象出**通用、与来源解耦**的临时上下文接入入口，任何来源用同一入口挂载。
- 输入框上方可**展开核对**、可**加注释**，随消息发送转文本。
- 保持既有浏览器圈选能力**零回归**。

### 1.3 核心概念

**TCB = 来源方递过来的、可预览、随消息走的上下文碎片。** 与附件平行但**不进附件管线**，发送时按 kind 转为文本拼入用户消息，绑定会话草稿、不跨会话持久化。

---

## 2. 数据结构

统一类型 `ContextBlock`（定义在 `src/stores/conversationStore/types.ts`）：

```ts
export interface ContextBlock {
  id: string                 // 全局唯一（来源方生成，列表内唯一）
  kind: ContextBlockKind     // 类型：决定渲染与格式化分支
  title: string              // 折叠 chip 标题（可读）
  source?: string            // 来源标注（如 'browser-marquee'），用于去重与溯源
  dedupeKey?: string         // 同 source 下去重键（addContextBlock 覆盖旧块）
  userNote?: string          // 用户注释/意图（可编辑，发送时拼入）
  data?: Record<string, unknown>  // 来源方自定义负载（未知 kind 降级为 JSON 摘要）

  // ── marquee-context 顶层兼容字段（双字段兼容，见 §5）──
  url?: string
  regions?: BrowserRegion[]
  browserLabel?: string
}

export type ContextBlockKind =
  | 'marquee-context'  // 浏览器圈选（内置）
  | 'text-selection'   // 页面文本选中（预留）
  | 'screenshot'       // 页面截图（预留）
  | string             // 插件/来源自定义 kind（未注册时降级渲染）
```

`InputDraft.contextBlocks?: ContextBlock[]` 与附件 `attachments` 平行，可选向后兼容。

---

## 3. 统一接收入口

**核心原则：来源方不得直接 `updateInputDraft` 整体替换草稿**（会与防抖持久化、提示词优化版本栈冲突）。必须走以下统一动作（定义于 `ConversationActions`，经 `useActiveSessionActions()` 透传）：

| 动作 | 签名 | 语义 |
|------|------|------|
| `addContextBlock` | `(block: ContextBlock) => boolean` | 接收一块。按 `source+dedupeKey` 去重（重复覆盖旧块）；不修改 text/attachments；缺 id/kind/title 或无活跃会话返回 `false` |
| `removeContextBlock` | `(blockId: string) => void` | 移除一块，内部同步清理 `marqueeStore`（边栏展示） |
| `clearContextBlocks` | `() => void` | 清空全部（发送完成/全部清空） |
| `updateContextBlockNote` | `(blockId: string, note: string) => void` | 就地更新注释 `userNote`（按 id 定位，不整体替换草稿） |

### 来源方接入模板

```ts
const { addContextBlock } = useActiveSessionActions()
addContextBlock({
  id: `marquee-${label}-${Date.now()}`,
  kind: 'marquee-context',
  title: pageTitle || 'Browser',
  source: 'browser-marquee',
  dedupeKey: webviewLabel,                 // 同标签覆盖
  data: { url, regions, browserLabel },
  url, regions, browserLabel,              // 顶层兼容字段（见 §5）
})
```

---

## 4. 渲染与发送（按 kind 分发）

统一处理入口在 `src/components/Chat/input/contextBlockRegistry.ts`：

- `formatContextBlock(block): string` — 按 kind 转发送文本
- `formatContextBlocks(blocks): string` — 拼接多条（空行分隔，过滤空块）

内置 kind：
- `marquee-context` — 复用 `browserService.formatMarqueeContextBlock` 的圈选文案模板
- 未知 kind — **降级**为 `data` JSON 文本（不白屏、不阻塞发送）

输入框上方预览 `ContextBlockPreview.tsx`：折叠 chip（标题/来源/尺寸/备注徽标/删除）→ 展开按 kind 分发详情 → 备注按钮内联编辑。

---

## 5. 双字段兼容（重要）

`BrowserPanel` 圈选写入 `upsertBlock`（边栏 `marqueeStore`，类型仍为 `MarqueeContextBlock`）与 `addContextBlock`（统一输入框，类型为 `ContextBlock`）两处。为**不破坏左侧边栏 `MarqueeSection` 直接读 `block.regions`/`block.url` 的既有消费**：

- block 同时携带**顶层兼容字段**（`url`/`regions`/`browserLabel`）+ **`data` 统一字段**。
- `ContextBlock` 类型用交叉 `ContextBlock & { type: 'marquee-context' }` 满足两处消费。
- 读取时**顶层优先、data 兜底**（见 `contextBlockRegistry.formatContextBlock` 与 `ContextBlockPreview`）。

**新增 kind 时只写 `data`，无需再补顶层兼容字段。**

---

## 6. 生命周期

```
来源方产生 → addContextBlock → 输入框上方展示
   ├─ 用户点 ×  → removeContextBlock → 消失
   ├─ 用户发送  → formatContextBlocks 转文本拼入消息 → 清空（并同步 marqueeStore）
   ├─ 会话切换  → inputDraft.contextBlocks 随会话切换
   └─ 清空草稿  → clearInputDraft → 一并清空
```

约束：
- **绑定会话**，不跨会话持久化；不随导出续接（`sessionHandoff`）携带。
- 发送即清空，避免重复投喂。
- `removeContextBlock` 统一处理 `marqueeStore` 同步，避免边栏残留。

---

## 7. 已落地改动清单

| 文件 | 改动 |
|------|------|
| `src/stores/conversationStore/types.ts` | 定义 `ContextBlock`/`ContextBlockKind`/`ContextBlockKindSpec`；`InputDraft.contextBlocks` 泛化 |
| `src/stores/conversationStore/createConversationStore.ts` | 实现四个 TCB 动作（add/remove/clear/updateNote），去重合并 + marqueeStore 同步 |
| `src/stores/conversationStore/useActiveSession.ts` | 按 activeSessionId 透传四个动作 |
| `src/components/Browser/BrowserPanel.tsx` | 圈选改为 `addContextBlock`，消除自读 activeSessionId 竞态；block 交叉类型兼容 |
| `src/components/Browser/BrowserSidebarPanel.tsx` | 移除路径收敛到统一 `removeContextBlock` |
| `src/components/Chat/input/contextBlockRegistry.ts` | 新增：按 kind 统一格式化/拼接 |
| `src/components/Chat/input/ContextBlockPreview.tsx` | 按 kind 分发渲染 + 备注编辑入口 |
| `src/components/Chat/input/ChatInput.tsx` | 类型泛化 + 统一发送格式化 + 备注透传 |

---

## 8. 后续扩展（Roadmap）

以下能力**尚未实施**，扩展时保持统一入口不变：

1. **就地编辑面板**：按 `ContextBlockKindSpec.editor` schema 驱动（改标题/裁剪 regions/编辑 data）。
2. **块管理**：排序、合并（group）、拆分、数量软上限。
3. **新来源 kind**：`text-selection`、`screenshot`、插件产物——只需注册 renderer/formatter + editor schema，主链路零改动。
4. **`marqueeStore` 切换统一类型** + 编辑器 schema 注册。

---

## 9. 维护约定（如何不"乱来"）

为保持该机制长期可维护，遵守以下规则：

1. **单一入口**：任何来源挂载 TCB 一律走 `addContextBlock`，禁止直接 `updateInputDraft` 整体替换 `contextBlocks`。
2. **kind 注册制**：新增来源 kind 必须在 `contextBlockRegistry.ts` 注册格式化，必要时在 `ContextBlockPreview` 注册渲染；未知 kind 允许降级但不允许报错/白屏。
3. **类型分层**：顶层兼容字段仅 `marquee-context` 需要（历史消费）；新 kind 一律用 `data`。不得继续扩增顶层字段。
4. **改动同步文档**：任何接口/数据结构/生命周期变更，须同步更新本文档对应章节；新增文件先在 §7 登记。
5. **透传不丢失**：凡 `updateInputDraft` 整体替换草稿处（提示词优化回填等），必须保留 `contextBlocks` 透传（`createConversationStore` 内已如此）。
6. **校验**：本机 `node_modules` 损坏无法跑 tsc/vitest，改动后至少用 `npx esbuild <files> --loader:.ts=ts --format=esm --outdir=<tmp>` 做逐文件语法校验。
