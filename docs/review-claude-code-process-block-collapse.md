# 审查：Claude Code 引擎过程块折叠方案

> 审查日期：2026-08-07
> 审查对象：`blockGrouping.tsx` 新增 `ProcessBlockSummary` + `AssistantBubble.tsx` 透传 `engineId`
> 方案版本：v5（审查后修正版，含保序 + 配置化）

---

## 一、方案概述

在 `renderBlocksWithGrouping` 中新增 `engineId` 和 `processBlockCollapse` 参数，对 `engineId === 'claude-code'` 且 `!isStreaming` 且 `processBlockCollapse === 'auto'` 的消息启用折叠汇总：

- 过程块（`thinking`/`tool_call`/`plan_mode`/`agent_run`/`permission_request`/`question`/`context_compact`/`tool_group`）折叠为分段汇总条
- 结果块（`text`/`artifact_preview`/`plugin_card（非 pending 交互态）`）始终保留
- 展开容器 `max-height: 50vh; overflow-y: auto`，子卡片 `flex-shrink: 0`
- 其他引擎（Codex/SimpleAI/Pi）和流式期间逻辑不变
- 可通过配置切换回旧版（`CollapsibleBlockGroupRenderer`）行为

改动范围：`blockGrouping.tsx` ~120 行 + `AssistantBubble.tsx` 1 行 + `config.ts` 1 字段。

---

## 二、代码审查

### 2.1 调用链路分析

```
AssistantBubble.tsx:139
  → renderBlocksWithGrouping(message.blocks, message.isStreaming)
```

**唯一调用点**，改动集中、风险可控。

### 2.2 EngineId 类型安全

`AssistantChatMessage.engineId` 的类型为 `EngineId = 'claude-code' | 'codex' | 'simple-ai' | 'pi'`（`src/types/session.ts:12`，`src/types/config.ts:11`），`engineId === 'claude-code'` 比较成立。

**注意**：`engineId` 是可选字段（`engineId?: EngineId`），在 `undefined` 时不会触发折叠——安全。

### 2.3 块类型归属完整性

方案中 `categorizeBlock` 覆盖了 `ContentBlock` 联合类型的所有 11 种变体，不存在遗漏。

| 块类型 | 是否在 `ContentBlock` 中 | 归类 |
|--------|-------------------------|------|
| `text` | ✅ | 结果块（空文本块 `skip`） |
| `thinking` | ✅ | 过程块 |
| `tool_call` | ✅ | 过程块 |
| `artifact_preview` | ✅ | 结果块 |
| `plugin_card` | ✅ | 结果块（pending 交互态例外） |
| `question` | ✅ | 过程块 |
| `plan_mode` | ✅ | 过程块 |
| `agent_run` | ✅ | 过程块 |
| `tool_group` | ✅ | 过程块（极少使用） |
| `permission_request` | ✅ | 过程块 |
| `context_compact` | ✅ | 过程块 |

### 2.4 特例路由兼容性

`dispatch_task` 和 `workflow`（AssaultResultCard）在 `renderContentBlock`（`chatBlocks/index.tsx:52-67`）中通过 `block.name` 匹配做专属卡片渲染，但它们的**块类型仍然是 `tool_call`**。方案将其归为过程块折叠入分段汇总，符合设计决策。

### 2.5 现有折叠逻辑冲突

`CollapsibleBlockGroupRenderer` 的 `collapseThreshold: 5` / `maxVisibleBlocks: 4` 阈值逻辑（`constants.ts:8-13`）在 Claude Code 引擎 `auto` 模式下被完整旁路。`legacy` 模式下保持原有逻辑。其他引擎路径不受影响。

---

## 三、需求一：折叠展开后保持原始顺序

### 3.1 原方案缺陷

原方案用 `filter` 将块拆为 `processBlocks` 和 `resultBlocks` 两组，渲染时汇总条在前、结果块在后，**强制重排了顺序**。

例如原始顺序：`text → thinking → tool_call → text → text`，折叠后变为：
```
[汇总条: 思考1 工具1] ← 本应在第2位
text ← 本应在第1位
text ← 本应聚合在第3位
```

### 3.2 修正方案：分段保序渲染

**不拆组**，而是**遍历原始 `blocks` 数组**，识别出**连续的过程块段**，每个段渲染为一个 `ProcessBlockSummary`，结果块在原位渲染。

```
原始顺序：text(0) → thinking(1) → tool_call(2) → text(3) → thinking(4) → tool_call(5) → text(6)

过程段识别：
  Segment 1: [thinking(1), tool_call(2)] —— 连续过程块
  Segment 2: [thinking(4), tool_call(5)] —— 连续过程块

折叠后渲染（保序）：
  text(0)                             ← 结果块，原位
  [汇总条: Segment 1]                ← 在原位取代过程段
  text(3)                             ← 结果块，原位
  [汇总条: Segment 2]                ← 在原位取代过程段
  text(6)                             ← 结果块，原位
```

### 3.3 核心伪代码

```tsx
export function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined,
  collapseMode: 'auto' | 'legacy' = 'auto',
): React.ReactNode[] {
  // 非流式 + auto 模式 → 分段保序折叠
  if (!isStreaming && collapseMode === 'auto') {
    const result: React.ReactNode[] = []
    let processSegment: ContentBlock[] = []

    for (let i = 0; i < blocks.length; i++) {
      const cat = categorizeBlock(blocks[i])
      if (cat === 'process') {
        processSegment.push(blocks[i])       // 累积过程段
      } else {
        // 遇到结果块 → 先刷出累积的过程段（如果有）
        if (processSegment.length > 0) {
          result.push(
            <ProcessBlockSummary
              key={`ps-${i - processSegment.length}`}
              blocks={processSegment}
            />
          )
          processSegment = []
        }
        // 结果块原位渲染
        if (cat === 'result') {
          result.push(
            <div key={`block-${i}`}>{renderContentBlock(blocks[i], false)}</div>
          )
        }
        // cat === 'skip' → 不渲染（空文本）
      }
    }

    // 尾部过程段
    if (processSegment.length > 0) {
      result.push(
        <ProcessBlockSummary
          key={`ps-tail`}
          blocks={processSegment}
        />
      )
    }

    return result
  }

  // ===== 旧逻辑（legacy 模式 / 流式期间 / 其他引擎）=====
  // ... 保持不变 ...
}
```

### 3.4 展开态也保序

`ProcessBlockSummary` 展开后，渲染其内部所有过程块，这些块**自然保持原始顺序**（就是按它们在 `blocks` 数组中出现的顺序累积的），无需额外处理。

---

## 四、需求二：可配置化，支持旧版显示

### 4.1 配置字段设计

在 `ChatDisplaySettings`（`src/types/config.ts:26`）中新增字段：

```ts
export interface ChatDisplaySettings {
  // ... 现有字段 ...

  /** 过程块折叠模式
   * - 'auto'：过程块折叠为分段汇总条（默认，新行为）
   * - 'legacy'：保留旧版 CollapsibleBlockGroupRenderer 行为（阈值≥5，显示前4个）
   */
  processBlockCollapse?: 'auto' | 'legacy'
}
```

添加默认值和归一化函数：

```ts
export const DEFAULT_CHAT_DISPLAY_SETTINGS: ChatDisplaySettings = {
  // ... 现有默认值 ...
  processBlockCollapse: 'auto',
}
```

`normalizeChatDisplaySettings` 无需额外处理——`processBlockCollapse` 作为可选字段，缺省即 `undefined`，在 `renderBlocksWithGrouping` 中回退为 `'auto'`。

### 4.2 配置传导链路

```
Config.chatDisplay.processBlockCollapse
  → useConfigStore(s => s.config?.chatDisplay?.processBlockCollapse)
  → AssistantBubble 读取并传入 renderBlocksWithGrouping
  → blockGrouping.tsx 内部判断
```

`AssistantBubble.tsx` 改动：

```tsx
// 改前
{renderBlocksWithGrouping(message.blocks, message.isStreaming)}

// 改后
const collapseMode = useConfigStore(s =>
  s.config?.chatDisplay?.processBlockCollapse ?? 'auto')

{renderBlocksWithGrouping(message.blocks, message.isStreaming, collapseMode)}
```

### 4.3 设置页面接入

在 `ThemeTab.tsx` 的「对话显示」区域（`line 210` 附近）新增开关：

```
[对话显示设置]
字号 / 行高 / 段落间距 / 字体族 / 密度 / ...

[过程块折叠]         ← 新增
○ 自动折叠（新）     ← radio 组
○ 旧版展开           ← radio 组
```

### 4.4 向后兼容

- **已有用户**：`processBlockCollapse` 为 `undefined`，`renderBlocksWithGrouping` 回退为 `'auto'`（新行为）。如需旧版，用户需手动在设置页切换。
- 或者：对于**升级用户**，默认保留 `'legacy'`，**新用户**默认 `'auto'`。但考虑到配置模型中没有版本号，建议统一默认 `'auto'`，降低分支复杂度。

---

## 五、完整设计方案

### 5.1 `categorizeBlock` 单一分类函数

```ts
type BlockCategory = 'process' | 'result' | 'skip'

function categorizeBlock(block: ContentBlock): BlockCategory {
  switch (block.type) {
    case 'text':
      // 空文本块（"..."）跳过，不渲染
      return isEmptyTextBlock(block) ? 'skip' : 'result'
    case 'artifact_preview':
      return 'result'
    case 'plugin_card':
      // interaction pending 态按过程块处理（用户仍需交互）
      return (block as PluginCardBlock).mode === 'interaction'
          && (block as PluginCardBlock).status === 'pending'
        ? 'process' : 'result'
    case 'thinking':
    case 'tool_call':
    case 'plan_mode':
    case 'agent_run':
    case 'permission_request':
    case 'question':
    case 'context_compact':
    case 'tool_group':
      return 'process'
    default:
      // 未知块类型兜底渲染
      return 'result'
  }
}
```

### 5.2 `ProcessBlockSummary` 组件

```tsx
interface ProcessBlockSummaryProps {
  blocks: ContentBlock[]   // 该段的所有过程块
}

function ProcessBlockSummary({ blocks }: ProcessBlockSummaryProps) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)

  // 按类型统计
  const counts = useMemo(() => {
    let thinking = 0, tool = 0, plan = 0, perm = 0, agent = 0, question = 0, compact = 0
    for (const b of blocks) {
      switch (b.type) {
        case 'thinking': thinking++; break
        case 'tool_call': tool++; break
        case 'plan_mode': plan++; break
        case 'permission_request': perm++; break
        case 'agent_run': agent++; break
        case 'question': question++; break
        case 'context_compact': compact++; break
      }
    }
    return { thinking, tool, plan, perm, agent, question, compact }
  }, [blocks])

  // 非零类型 → chips 数组
  // 注意：文案应通过 i18n 提取，以下为示意
  const chips = useMemo(() => {
    const items: { label: string }[] = []
    if (counts.thinking) items.push({ label: `🤔 ${t('processSummary.thinking', '思考')} ${counts.thinking}` })
    if (counts.tool)     items.push({ label: `🛠 ${t('processSummary.tool', '工具')} ${counts.tool}` })
    if (counts.plan)     items.push({ label: `📋 ${t('processSummary.plan', '计划')} ${counts.plan}` })
    if (counts.perm)     items.push({ label: `⚠️ ${t('processSummary.permission', '权限')} ${counts.perm}` })
    if (counts.agent)    items.push({ label: `🤖 ${t('processSummary.agent', '代理')} ${counts.agent}` })
    if (counts.question) items.push({ label: `❓ ${t('processSummary.question', '提问')} ${counts.question}` })
    if (counts.compact)  items.push({ label: `🗜 ${t('processSummary.compact', '压缩')} ${counts.compact}` })
    return items
  }, [counts, t])

  return (
    <>
      {/* 汇总条 */}
      <div
        className="flex items-center gap-2 px-3 py-2 my-1 cursor-pointer
          bg-background-surface border border-dashed border-border rounded-md
          text-xs text-text-secondary
          hover:border-primary hover:text-primary hover:bg-background-hover
          transition-all duration-150"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded) } }}
        aria-expanded={expanded}
      >
        <span>🔧</span>
        <span className="flex-1 flex items-center gap-2 flex-wrap">
          {t('processSummary.title', '运行过程已折叠')}
          {chips.map((chip, i) => (
            <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-background-elevated text-text-muted">
              {chip.label}
            </span>
          ))}
        </span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </div>

      {/* 展开态 */}
      {expanded && (
        <div
          className="flex flex-col gap-2 p-2 border border-border rounded-md bg-background-base"
          style={{ maxHeight: '50vh', overflowY: 'auto' }}
        >
          {blocks.map((block, idx) => (
            <div key={`p-${idx}`} style={{ flexShrink: 0 }}>
              {renderContentBlock(block, false)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
```

### 5.3 `renderBlocksWithGrouping` 完整实现

```tsx
type CollapseMode = 'auto' | 'legacy'

export function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined,
  collapseMode?: CollapseMode,
): React.ReactNode[] {
  const mode = collapseMode ?? 'auto'

  // ===== 新行为：auto 模式 + 非流式 =====
  if (!isStreaming && mode === 'auto') {
    const result: React.ReactNode[] = []
    let processSegment: ContentBlock[] = []

    for (let i = 0; i < blocks.length; i++) {
      const cat = categorizeBlock(blocks[i])
      if (cat === 'process') {
        processSegment.push(blocks[i])
      } else {
        // 刷出累积的过程段
        if (processSegment.length > 0) {
          result.push(
            <ProcessBlockSummary
              key={`ps-${i - processSegment.length}`}
              blocks={processSegment}
            />
          )
          processSegment = []
        }
        // 结果块原位渲染
        if (cat === 'result') {
          result.push(
            <div key={`block-${i}`}>{renderContentBlock(blocks[i], false)}</div>
          )
        }
        // skip → 不渲染
      }
    }

    // 尾部过程段
    if (processSegment.length > 0) {
      result.push(
        <ProcessBlockSummary key="ps-tail" blocks={processSegment} />
      )
    }

    return result
  }

  // ===== 旧行为（legacy / 流式期间 / 其他引擎）=====
  const groups = identifyCollapsibleBlockGroups(blocks)
  // ... 以下保持现有逻辑，不变 ...
}
```

### 5.4 `AssistantBubble.tsx` 改动

```tsx
// 新增：读取配置
const collapseMode = useConfigStore(s =>
  s.config?.chatDisplay?.processBlockCollapse ?? 'auto')

// 改前
{renderBlocksWithGrouping(message.blocks, message.isStreaming)}

// 改后
{renderBlocksWithGrouping(message.blocks, message.isStreaming, collapseMode)}
```

### 5.5 设置页改动

`ThemeTab.tsx`（line 210 附近）新增 radio 组：

```tsx
// 新增
const collapseMode = chatDisplay.processBlockCollapse ?? 'auto'

<RadioGroup
  label={t('chatDisplay.processBlockCollapse')}
  hint={t('chatDisplay.processBlockCollapseHint')}
  value={collapseMode}
  options={[
    { value: 'auto', label: t('chatDisplay.collapseAuto') },
    { value: 'legacy', label: t('chatDisplay.collapseLegacy') },
  ]}
  onChange={(v) => updateChatDisplay({ processBlockCollapse: v as 'auto' | 'legacy' })}
/>
```

---

## 六、用户痛点分析（行业背景）

### 6.1 行业竞品对比

| 产品 | 过程块展示方式 | 用户反馈 |
|------|---------------|---------|
| **Cursor** (Agent Mode) | 工具调用折叠为紧凑摘要行，可展开 | 正面：减少视觉噪音 |
| **GitHub Copilot** (Agent Mode) | 工具调用在可折叠面板中 | 正面：面板级折叠干净 |
| **Claude Code** (官方 CLI) | 纯终端，无 UI 折叠问题 | N/A（终端用户） |
| **Windsurf** | 类似 Cursor 的折叠摘要 | 正面 |
| **Polaris 现状** | `thinking`+`tool_call` ≥5 才折叠，显示前 4 个 | 痛点：消息膨胀 |

### 6.2 核心痛点（行业共识）

1. **消息膨胀**：一条 AI 回复可能包含 10+ 工具调用 + 思考块，占满整个可见区域，结果文本被推到不可见位置
2. **历史回顾困难**：回看会话时，每一条消息都展开大量过程块，用户需要手动滚动查找结果
3. **信号噪声比低**：过程（工具调用、思考）占 80%+ 空间，结果（最终回答）只占 20% 不到
4. **长会话不可维护**：50+ 轮对话后，消息列表因过程块展开而变得极长，虚拟滚动也难缓解
5. **缺少引擎差异化**：Claude Code 引擎的工具调用密度远高于 SimpleAI/Pi，但展示策略相同

### 6.3 Polaris 用户的特殊场景

- **Claude Code 引擎** 是 Polaris 的核心引擎之一，工具调用频繁（bash/edit/write/read/glob 等）
- 用户在 Polaris 中可能同时使用多个引擎，跨引擎对比时需要快速定位结果
- 历史消息折叠后，用户能更快地滚动浏览对话脉络

---

## 七、改进建议清单

### 7.1 必须修复（实施前）

| # | 问题 | 说明 | 文件 |
|---|------|------|------|
| 1 | 原方案拆组渲染破坏顺序 | 改为分段保序遍历（见 §3） | `blockGrouping.tsx` |
| 2 | `plugin_card` pending 态未处理 | `categorizeBlock` 增加 `mode === 'interaction' && status === 'pending'` 判断（见 §5.1） | `blockGrouping.tsx` |
| 3 | `isProcessBlock`/`isResultBlock` 非互补 | 合为单一 `categorizeBlock` 返回枚举 | `blockGrouping.tsx` |

### 7.2 建议修复（实施中）

| # | 建议 | 说明 | 文件 |
|---|------|------|------|
| 4 | `text` 类型复用 `isEmptyTextBlock` | 避免 `"..."` 空文本块残留（见 `categorizeBlock`） | `blockGrouping.tsx` |
| 5 | i18n 提取 | 汇总条 chips 文案不应硬编码中文 | `blockGrouping.tsx` + `locales/` |
| 6 | 设置页接入 | 新增 radio 组件（见 §5.5） | `ThemeTab.tsx` + `locales/` |

### 7.3 低优先级

| # | 建议 | 说明 |
|---|------|------|
| 7 | 展开动画 | `transition: max-height 0.2s ease` 避免突兀展开 |
| 8 | 未知块类型兜底 | `categorizeBlock` default 返回 `'result'` 确保不丢失 |

### 7.4 测试建议

| 测试场景 | 说明 | 优先级 |
|----------|------|--------|
| auto 模式：折叠后保序 | 结果块在分段汇总条之间原位 | 高 |
| auto 模式：展开后保序 | 所有块按原始顺序恢复 | 高 |
| legacy 模式：旧行为不变 | CollapsibleBlockGroupRenderer 阈值逻辑 | 高 |
| 非 Claude Code 引擎不受影响 | 回归 | 高 |
| `plugin_card` pending 交互态保留 | 边界 | 高 |
| 无过程块不渲染汇总条 | 边界 | 中 |
| 无结果块只渲染分段汇总条 | 边界 | 中 |
| 汇总条展开/折叠交互 | 可用性 | 中 |
| 历史消息加载后折叠 | 兼容性 | 中 |
| 超出 50vh 滚动 | 样式 | 低 |
| 设置页切换生效 | 配置持久化 | 中 |

---

## 八、改动量估算

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `src/types/config.ts` | +3 行 | 新增 `processBlockCollapse` 字段 + 默认值 |
| `src/components/Chat/blockGrouping.tsx` | ~120 行新增 | `categorizeBlock` + `ProcessBlockSummary` + 修改 `renderBlocksWithGrouping` |
| `src/components/Chat/chatBubbles/AssistantBubble.tsx` | +3 行 | 读取配置 + 透传 |
| `src/components/Settings/tabs/ThemeTab.tsx` | ~20 行 | 新增 radio 组 |
| `src/locales/zh-CN/chat.json` | +8 行 | 汇总条 i18n 文案 |
| `src/locales/en-US/chat.json` | +8 行 | 同上英文版 |
| 总计 | ~160 行 | 纯前端，无后端/状态管理变更 |

---

## 九、总结

### 方案评价

方案整体**设计合理、改动集中、风险可控**。核心思路（`collapseMode` 门控 + `isStreaming` 信号 + 分段保序折叠）正确。

### 两个关键需求的落地

**保序（§3）**：采用分段遍历替代过滤拆组，过程段在原始位置渲染为 `ProcessBlockSummary`，结果块原位渲染，展开时恢复全部块。自然解决了顺序问题，同时也避免了单条大汇总条可能跨度太长的体验问题。

**配置化（§4）**：`ChatDisplaySettings.processBlockCollapse` 字段，`'auto'`（新行为）和 `'legacy'`（旧版行为）两个选项，通过 `ThemeTab.tsx` 设置页 radio 组件切换，即时生效。向后兼容，用户可自由选择。

### 实施前必须修复的三个问题

1. **分段保序**（§3）—— 原方案 `filter` 拆组会破坏块顺序
2. **`plugin_card` pending 态**（§5.1）—— 代码骨架未体现方案意图
3. **单一分类函数**（§5.1）—— `isProcessBlock`/`isResultBlock` 改为 `categorizeBlock` 枚举，维护性更好