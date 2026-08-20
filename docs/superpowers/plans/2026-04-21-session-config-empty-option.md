# SessionConfigSelector 空值选项与手动输入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为会话配置选择器添加"不设置"选项和手动输入功能，调整默认值为通用/Opus/最高/跳过权限

**Architecture:**
1. 修改 `sessionConfig.ts` 调整默认值和选项顺序
2. 修改 `SessionConfigSelector.tsx` 添加"自定义"输入功能
3. 调整 store 类型支持任意字符串输入

**Tech Stack:** React, TypeScript, Zustand, Tailwind CSS

---

## 文件结构

```
src/types/sessionConfig.ts       # 类型定义、默认值、选项列表
src/components/Chat/SessionConfigSelector.tsx  # 选择器 UI 组件
src/stores/sessionConfigStore.ts # 配置持久化 Store
```

---

## Task 1: 调整默认值和选项顺序

**Files:**
- Modify: `src/types/sessionConfig.ts`

- [ ] **Step 1: 修改 DEFAULT_SESSION_CONFIG 默认值**

将默认值改为：通用、Opus、最高、跳过权限

```typescript
export const DEFAULT_SESSION_CONFIG: Required<SessionRuntimeConfig> = {
  agent: 'general-purpose',
  model: 'opus',
  effort: 'max',
  permissionMode: 'bypassPermissions',
}
```

- [ ] **Step 2: 调整 PRESET_AGENTS 选项顺序**

将"不设置"移到第一位，其余保持不变：

```typescript
export const PRESET_AGENTS: CLIAgent[] = [
  {
    id: '',
    name: '不设置',
    description: '不传 Agent 参数，使用 CLI 默认模式',
    defaultModel: undefined,
    tags: ['内置'],
  },
  {
    id: 'general-purpose',
    name: '通用',
    description: '默认通用助手',
    defaultModel: undefined,
    tags: ['内置'],
  },
  // ... 其他 agent 保持不变
]
```

- [ ] **Step 3: 调整 PRESET_MODELS 选项顺序**

将"不设置"移到第一位，Opus 移到第二位：

```typescript
export const PRESET_MODELS: CLIModel[] = [
  {
    id: '',
    name: '不设置',
    description: '不传模型参数，使用 Agent 默认或 CLI 默认模型',
    isDefault: false,
    supportsStreaming: true,
  },
  {
    id: 'opus',
    name: 'Opus',
    description: '最强性能，适合复杂推理任务',
    supportsStreaming: true,
    contextWindow: 200000,
  },
  {
    id: 'sonnet',
    name: 'Sonnet',
    description: '平衡性能和速度，适合大多数任务',
    isDefault: true,
    supportsStreaming: true,
    contextWindow: 200000,
  },
  {
    id: 'haiku',
    name: 'Haiku',
    description: '快速响应，适合简单任务',
    supportsStreaming: true,
    contextWindow: 200000,
  },
]
```

- [ ] **Step 4: 调整 EFFORT_OPTIONS 选项顺序**

将"不设置"移到第一位，"最高"移到第二位：

```typescript
export const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string; description: string }> = [
  {
    value: '',
    label: '不设置',
    description: '不传努力参数，使用 CLI 默认级别',
  },
  {
    value: 'max',
    label: '最高',
    description: '全力以赴，最高质量输出',
  },
  {
    value: 'high',
    label: '高',
    description: '深入思考，适合复杂问题',
  },
  {
    value: 'medium',
    label: '中',
    description: '平衡速度和质量',
  },
  {
    value: 'low',
    label: '低',
    description: '快速响应，适合简单问题',
  },
]
```

- [ ] **Step 5: 调整 PERMISSION_MODE_OPTIONS 选项顺序**

"不设置"对应 `bypassPermissions`，移到第一位，其余保持：

```typescript
export const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode | ''; label: string; description: string }> = [
  {
    value: 'bypassPermissions',
    label: '不设置',
    description: '跳过所有权限检查',
  },
  {
    value: 'default',
    label: '默认',
    description: '敏感操作需要确认',
  },
  {
    value: 'auto',
    label: '自动',
    description: '安全操作自动批准',
  },
  {
    value: 'acceptEdits',
    label: '接受编辑',
    description: '自动接受文件编辑',
  },
  {
    value: 'plan',
    label: '规划',
    description: '仅规划不执行',
  },
  {
    value: 'dontAsk',
    label: '拒绝危险',
    description: '拒绝危险操作',
  },
]
```

- [ ] **Step 6: 验证编译通过**

```bash
cd D:/space/base/Polaris && pnpm run build 2>&1 | head -30
```

Expected: 构建成功，无 TypeScript 错误

---

## Task 2: 添加手动输入功能

**Files:**
- Modify: `src/components/Chat/SessionConfigSelector.tsx`

- [ ] **Step 1: 添加自定义输入状态**

在 `SessionConfigSelector` 组件中添加输入模式状态：

```typescript
// 在 useState 声明区域添加
const [customInput, setCustomInput] = useState<{ type: SelectorType; value: string } | null>(null)
const inputRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 2: 添加自定义输入处理函数**

```typescript
// 处理自定义输入确认
const handleCustomInputConfirm = useCallback((type: SelectorType) => {
  if (!customInput || customInput.type !== type) return
  const value = customInput.value.trim()
  if (value) {
    handleSelect(type, value)
  }
  setCustomInput(null)
}, [customInput, handleSelect])

// 打开自定义输入模式
const openCustomInput = useCallback((type: SelectorType) => {
  setCustomInput({ type, value: '' })
  setOpenDropdown(null)
  // 延迟聚焦输入框
  setTimeout(() => inputRef.current?.focus(), 0)
}, [])
```

- [ ] **Step 3: 修改 renderDropdown 添加自定义选项**

在每个下拉列表末尾添加"自定义..."选项和输入框：

```typescript
// 在 renderDropdown 函数的 return 语句中修改
return (
  <div className={clsx(
    'absolute bottom-full left-0 mb-1',
    'bg-background-elevated border border-border rounded-lg shadow-lg',
    'min-w-[180px] max-h-[240px] overflow-y-auto',
    'z-50 animate-in fade-in slide-in-from-bottom-1 duration-150'
  )}>
    {items.map((item) => (
      <button
        key={item.value}
        onClick={() => handleSelect(type, item.value)}
        className={clsx(
          'w-full px-3 py-2 text-left text-xs',
          'hover:bg-background-hover transition-colors',
          'flex flex-col gap-0.5',
          currentValue === item.value && 'bg-primary/10 text-primary'
        )}
      >
        <span className="font-medium">{item.label}</span>
        {item.description && (
          <span className="text-text-tertiary text-[10px]">{item.description}</span>
        )}
      </button>
    ))}
    {/* 分隔线 */}
    <div className="border-t border-border my-1" />
    {/* 自定义输入选项 */}
    <button
      onClick={() => openCustomInput(type)}
      className={clsx(
        'w-full px-3 py-2 text-left text-xs',
        'hover:bg-background-hover transition-colors',
        'text-text-tertiary italic'
      )}
    >
      ✏️ 自定义...
    </button>
  </div>
)
```

- [ ] **Step 4: 添加自定义输入浮层**

在组件 return 中添加输入浮层：

```typescript
// 在 containerRef div 内部末尾添加
{/* 自定义输入浮层 */}
{customInput && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
    <div className="bg-background-elevated border border-border rounded-lg p-4 min-w-[280px] shadow-xl">
      <div className="text-xs text-text-secondary mb-2">
        输入自定义 {selectorMeta[customInput.type].label} 值：
      </div>
      <input
        ref={inputRef}
        type="text"
        value={customInput.value}
        onChange={(e) => setCustomInput({ ...customInput, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCustomInputConfirm(customInput.type)
          if (e.key === 'Escape') setCustomInput(null)
        }}
        className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
        placeholder={`输入 ${customInput.type} 值...`}
      />
      <div className="flex justify-end gap-2 mt-3">
        <button
          onClick={() => setCustomInput(null)}
          className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
        >
          取消
        </button>
        <button
          onClick={() => handleCustomInputConfirm(customInput.type)}
          className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover"
        >
          确认
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 5: 修改 getAgentLabel/getModelLabel 支持自定义值显示**

```typescript
const getAgentLabel = useCallback((agentId?: string) => {
  if (!agentId) return t('sessionConfig.noAgent', '不设置')
  const agent = agentList.find(a => a.id === agentId)
  // 自定义值直接返回
  return agent?.name || agentId
}, [t, agentList])

const getModelLabel = useCallback((modelId?: string) => {
  if (!modelId) return t('sessionConfig.noModel', '不设置')
  const model = PRESET_MODELS.find(m => m.id === modelId)
  // 自定义值直接返回
  return model?.name || modelId
}, [t])
```

- [ ] **Step 6: 验证编译通过**

```bash
cd D:/space/base/Polaris && pnpm run build 2>&1 | head -30
```

Expected: 构建成功

---

## Task 3: 同步修改 CompactSessionSelector

**Files:**
- Modify: `src/components/Chat/SessionConfigSelector.tsx` (CompactSessionSelector 部分)

- [ ] **Step 1: 为 CompactSessionSelector 添加相同的自定义输入功能**

参照 Task 2 的修改，为 `CompactSessionSelector` 组件添加：
- `customInput` 状态
- `openCustomInput` 和 `handleCustomInputConfirm` 函数
- 下拉列表末尾的"自定义..."选项
- 自定义输入浮层

代码结构与 Task 2 一致，仅样式略有差异。

- [ ] **Step 2: 验证编译通过**

```bash
cd D:/space/base/Polaris && pnpm run build 2>&1 | head -30
```

---

## Task 4: 验证功能完整性

- [ ] **Step 1: 启动开发服务器**

```bash
cd D:/space/base/Polaris && pnpm run tauri:dev
```

- [ ] **Step 2: 手动验证**

1. 检查默认显示：Agent=通用，Model=Opus，Effort=最高，Permission=不设置
2. 点击下拉，检查"不设置"是否在第一位
3. 点击"自定义..."，输入自定义值，确认后检查是否正确显示
4. 刷新页面，检查配置是否持久化

- [ ] **Step 3: 提交代码**

```bash
git add src/types/sessionConfig.ts src/components/Chat/SessionConfigSelector.tsx
git commit -m "feat(sessionConfig): 添加不设置选项和手动输入功能

- 调整默认值为通用/Opus/最高/跳过权限
- 各配置项首位添加'不设置'选项
- 下拉列表添加'自定义...'输入功能"
```
