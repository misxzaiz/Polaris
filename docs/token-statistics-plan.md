# Token 统计功能 · 实施方案

> 目标：在状态栏现有的 ContextMeter 基础上，提供跨会话的 Token 统计查询能力，
> 支持按模型、按时间等维度，并在设置面板提供可视化查看。

## 1. 现状

### 1.1 已存在的能力

| 模块 | 功能 | 文件 |
|------|------|------|
| `UsageEvent` / `UsageStats` | 双口径 token 用量事件（turn 快照 + cumulative 累计） | `src/ai-runtime/event.ts` `src/stores/conversationStore/types.ts` |
| `ContextMeter` | 状态栏上下文水位条 + 悬浮详情卡（含 sessionTotals / modelUsage） | `src/components/Chat/ContextMeter.tsx` |
| 会话级累计 | `sessionTotals` 跨消息累加 `runContribution` 幂等机制 | `src/stores/conversationStore/eventHandler.ts` |
| DialogStorage | JSONL 文件存储，`DialogMeta` 含会话摘要 | `src/services/dialogStorage/` |

### 1.2 缺失环节

1. **DialogMeta 不持 token 用量** — 无法跨会话聚合
2. **无历史聚合服务** — 无法按时间/模型查询
3. **设置面板无 Token 统计 Tab**
4. **状态栏无"查看统计"入口**

## 2. 实施方案

### Phase 1: Token 用量持久化到 DialogMeta

**目标：** 每次保存会话时，将 token 用量写入 DialogMeta，使得后续可跨会话查询。

**变更：**

1. **`src/services/dialogStorage/types.ts`** — `DialogMeta` 新增 `tokenUsage` 字段：
   ```typescript
   export interface DialogMeta {
     // ... 现有字段
     /** 会话级 token 用量汇总（轮末保存时写入） */
     tokenUsage?: {
       input: number
       output: number
       cacheCreation: number
       cacheRead: number
       costUsd: number
       /** 按模型维度的用量（key=模型名，value=该模型用量） */
       modelBreakdown?: Record<string, {
         input: number
         output: number
         cacheCreation: number
         cacheRead: number
         costUsd: number
       }>
     }
   }
   ```

2. **`src/stores/conversationStore/types.ts`** — `DialogMeta` 格式版本升至 v3

3. **`src/stores/conversationStore/eventHandler.ts`** — `session_end` 分支，在 `saveDialog()` 调用前将 `usageStats.sessionTotals` 写入 `saveDialogInput` 的扩展字段

4. **`src/services/dialogStorage/service.ts`** — `saveDialog()` 接收 tokenUsage 并写入 meta

### Phase 2: Token Analytics Store

**目标：** 提供跨会话的 token 用量的聚合查询能力。

**新建：**

1. **`src/stores/tokenAnalyticsStore.ts`** — Zustand Store
   - `loadData()` — 从 DialogStorage 读取所有会话的 meta，提取 tokenUsage
   - `getByModel()` — 按模型聚合
   - `getByTimeRange(range: 'day' | 'week' | 'month' | 'all')` — 按时间范围聚合
   - `getTopSessions(limit: number)` — 消耗最多的会话
   - `getTotalStats()` — 全局汇总
   - 数据缓存 + 增量刷新

2. 数据结构：
   ```typescript
   interface TokenAnalyticsData {
     sessions: Array<{
       sessionId: string
       title: string
       engineId: string
       createdAt: string
       updatedAt: string
       tokenUsage: DialogMeta['tokenUsage']
     }>
     lastUpdated: number
   }
   ```

### Phase 3: 设置面板 Token 统计 Tab

**目标：** 在设置面板新增一个 Tab，展示 Token 统计的完整视图。

**变更：**

1. **`src/components/Settings/SettingsSidebar.tsx`** — 新增 `token-stats` Tab ID
   ```typescript
   export type SettingsTabId =
     | ... | 'token-stats'
   ```
   新增导航项：`{ id: 'token-stats', icon: <BarChart3 size={16} />, labelKey: 'nav.tokenStats' }`

2. **`src/components/Settings/SettingsPage.tsx`** — 新增 `TokenStatsTab` 渲染分支

3. **新建 `src/components/Settings/tabs/TokenStatsTab.tsx`** — 统计页面：
   - **顶部概览卡片**：总输入/输出/cache/花费
   - **按模型图表**：条形图/饼图展示各模型消耗
   - **按时间图表**：折线图/柱状图展示日/周/月趋势
   - **Top 会话**：消耗最多的会话列表
   - **引擎分布**：各引擎的用量占比
   - 使用纯 CSS 绘制（无第三方图表库依赖）

4. **`src/locales/zh-CN/settings.json`** — 新增 `nav.tokenStats` 翻译
   **`src/locales/en-US/settings.json`** — 对应英文翻译

### Phase 4: 状态栏集成

**目标：** 从 ContextMeter 悬浮卡提供"查看完整统计"入口，以及输入框状态栏的增强。

**变更：**

1. **`src/components/Chat/ContextMeter.tsx`** — 悬浮详情卡底部新增"查看 Token 统计"按钮
   ```tsx
   <button onClick={() => openSettingsPanel('token-stats')}>
     查看 Token 统计
   </button>
   ```

2. **事件机制**：通过 `window.dispatchEvent(new CustomEvent('polaris:open-settings', { detail: { tab: 'token-stats' } }))` 打开设置面板到对应 Tab

## 3. 实施顺序

```
Phase 1 → Phase 2 → Phase 3 → Phase 4
```

每阶段完成验证无误后再进入下一阶段。

## 4. 验证方法

- **Phase 1**: 发送几条消息后，检查 JSONL 文件 meta 行是否包含 `tokenUsage` 字段
- **Phase 2**: 单元测试覆盖聚合逻辑（按模型/按时间/空数据）
- **Phase 3**: 手动检查设置面板 Token 统计 Tab 展示是否正确
- **Phase 4**: 点击 ContextMeter 悬浮卡的"查看 Token 统计"按钮，确认跳转到设置面板对应 Tab