# 会话接管功能需求规划

> 状态：规划中
> 创建时间：2026-04-12
> 预计工期：3-5 天

---

## 一、需求概述

### 1.1 背景

当前 Polaris 系统中存在多个 AI 会话产生源：
- **定时任务 (Scheduler)**：定时触发 Claude Code 执行
- **QQ 机器人**：接收用户消息，调用 Claude Code
- **飞书机器人**：接收用户消息，调用 Claude Code

这些会话在后台执行时，用户无法实时查看输出、无法交互。

### 1.2 目标

提供一个**会话管理面板**，让用户能够：
1. 查看所有活跃的 AI 会话（按来源分组）
2. **接管**任意会话，在 AI 对话页面新开窗口进行交互
3. 接管后可：查看实时输出、发送消息、中断执行

### 1.3 核心概念

```
源 (Source)                    AI 会话实例 (Session)
─────────────────────────────────────────────────────
定时任务-每日代码审查:
  ├─ session-1 (2026-04-12 08:00 执行) ← 已完成
  └─ session-2 (2026-04-12 12:00 执行) ← 执行中，可接管

QQ机器人-技术群:
  ├─ session-3 (用户A的对话) ← 等待输入
  └─ session-4 (用户B的对话) ← 执行中，可接管
```

---

## 二、功能需求

### 2.1 会话管理面板

**位置**：左侧面板新增入口，或作为独立面板

**结构**：
```
┌─────────────────────────────────────────────────┐
│  会话管理                              [订阅管理] │
├─────────────────────────────────────────────────┤
│  📅 定时任务                                     │
│  ├─ 每日代码审查                                 │
│  │   └─ 🟢 执行中 12:03        [接管] [中断]    │
│  │                                              │
│  └─ 周报生成                                     │
│      └─ ✅ 已完成 04-08        [接管] [查看]    │
│                                                 │
│  💬 QQ机器人                                     │
│  └─ 技术交流群                                   │
│      ├─ 🟢 用户B提问中         [接管] [回复]    │
│      └─ ⏸️  等待用户回复        [接管]           │
│                                                 │
│  📱 飞书机器人                                   │
│  └─ 产品反馈通道               [折叠 ▶]         │
│                                                 │
│  ─────────────────────────────                  │
│  📝 手动会话                                     │
│  ├─ 对话1                        [切换] [关闭]  │
│  └─ 对话2                        [切换] [关闭]  │
└─────────────────────────────────────────────────┘
```

### 2.2 接管功能

**触发条件**：用户点击会话的"接管"按钮

**接管流程**：
1. 在 AI 对话页面新增一个标签页/窗口
2. 加载该会话的历史消息（如有）
3. 后续事件实时流向新窗口
4. 用户可像正常对话一样交互

**接管后的标签页**：
```
┌─────────────────────────────────────────────────┐
│ [对话1] [对话2] [📅每日审查-执行中] [+]          │
│                    ↑                            │
│              新增标签页，显示来源标识             │
├─────────────────────────────────────────────────┤
│  来源: 定时任务"每日代码审查"                    │
│  状态: 执行中                                    │
│  ─────────────────────────────────────          │
│  AI: 正在分析代码库...                           │
│  [工具] Read src/auth.ts                        │
│  AI: 发现一个潜在的安全问题...                   │
│                                                 │
│  ┌─────────────────────────────────────┐       │
│  │ 继续追问...                    [发送]│       │
│  └─────────────────────────────────────┘       │
└─────────────────────────────────────────────────┘
```

### 2.3 操作定义

| 操作 | 说明 | 适用状态 |
|------|------|----------|
| **接管** | 新开窗口，接管该会话 | 任意状态 |
| **查看** | 只读模式查看历史 | 已完成 |
| **中断** | 中断正在执行的会话 | 执行中 |
| **回复** | 在该会话中发送消息 | 等待输入 |

---

## 三、数据模型

### 3.1 类型定义

```typescript
// src/stores/conversationStore/types.ts

/** 会话来源类型 */
export type SessionSourceType = 'scheduler' | 'qqbot' | 'feishu' | 'manual';

/** 会话来源信息 */
export interface SessionSourceInfo {
  type: SessionSourceType;
  sourceId: string;        // taskId 或机器人实例ID
  sourceName: string;      // 显示名称："每日代码审查"
  instanceId?: string;     // 具体实例：QQ群ID、飞书会话ID
  icon?: string;           // 图标标识
}

/** 按来源聚合的会话组 */
export interface SourceSessionGroup {
  sourceType: SessionSourceType;
  sourceId: string;
  sourceName: string;
  icon?: string;
  sessions: SessionMetadata[];
}

/** 来源订阅关系 */
export interface SourceSubscription {
  sourceType: SessionSourceType;
  sourceId: string;
  subscribedAt: string;
  autoShow: boolean;  // 新会话是否自动打开窗口
}
```

### 3.2 扩展 SessionMetadata

```typescript
// src/stores/conversationStore/types.ts

export interface SessionMetadata {
  id: string;
  title: string;
  type: 'project' | 'free';
  workspaceId: string | null;
  workspaceName?: string;
  contextWorkspaceIds: string[];
  workspaceLocked?: boolean;
  silentMode?: boolean;
  status: 'idle' | 'running' | 'waiting' | 'error' | 'background-running';
  lastAccessedAt: number;
  createdAt: string;
  updatedAt: string;

  // ===== 新增字段 =====
  /** 会话来源信息（定时任务/机器人产生的会话有此字段） */
  source?: SessionSourceInfo;
  /** 接管时间（用户主动接管后设置） */
  takenOverAt?: string;
  /** 后端会话ID（用于 continue_chat API） */
  backendSessionId?: string;
}
```

---

## 四、技术实现方案

### 4.1 模块改动清单

| 模块 | 文件路径 | 改动内容 | 优先级 |
|------|----------|----------|--------|
| 类型定义 | `src/stores/conversationStore/types.ts` | 新增 `SessionSourceType`、`SessionSourceInfo`、`SourceSessionGroup`；扩展 `SessionMetadata` | P0 |
| 事件路由 | `src/services/eventRouter.ts` | 新增来源聚合查询、会话来源注册 | P0 |
| 会话管理 | `src/stores/conversationStore/sessionStoreManager.ts` | 新增 `takeOverSession`、`getSessionsBySource`、`getSourceGroups` 方法 | P0 |
| 定时任务 Store | `src/stores/schedulerStore.ts` | 执行时注册会话来源 | P1 |
| 集成 Store | `src/stores/integrationStore.ts` | 消息处理时注册会话来源 | P2 |
| 管理面板组件 | `src/components/Session/SessionSourcePanel.tsx` | 新增组件 | P1 |
| 执行日志抽屉 | `src/components/Scheduler/ExecutionLogDrawer.tsx` | 增加"接管"按钮 | P1 |
| 集成面板 | `src/components/Integration/` | 增加"接管"按钮 | P2 |

### 4.2 EventRouter 扩展

```typescript
// src/services/eventRouter.ts

export class EventRouter {
  // ===== 新增属性 =====

  /** 按来源聚合的会话 Map<sourceKey, Set<sessionId>> */
  private sourceSessions: Map<string, Set<string>> = new Map();

  /** 来源订阅 Map<sourceKey, Set<windowId>> */
  private sourceSubscriptions: Map<string, Set<string>> = new Map();

  // ===== 新增方法 =====

  /**
   * 生成来源 key
   */
  private getSourceKey(sourceType: string, sourceId: string): string {
    return `${sourceType}-${sourceId}`;
  }

  /**
   * 注册会话归属来源
   * 在会话创建时调用，记录会话属于哪个来源
   */
  registerSessionSource(
    sessionId: string,
    sourceType: SessionSourceType,
    sourceId: string
  ): void {
    const key = this.getSourceKey(sourceType, sourceId);
    if (!this.sourceSessions.has(key)) {
      this.sourceSessions.set(key, new Set());
    }
    this.sourceSessions.get(key)!.add(sessionId);
    log.debug('注册会话来源', { sessionId, sourceType, sourceId });
  }

  /**
   * 取消注册会话来源
   * 在会话删除时调用
   */
  unregisterSessionSource(
    sessionId: string,
    sourceType: SessionSourceType,
    sourceId: string
  ): void {
    const key = this.getSourceKey(sourceType, sourceId);
    this.sourceSessions.get(key)?.delete(sessionId);
  }

  /**
   * 订阅某个来源
   * 当该来源产生新会话时，自动创建窗口
   */
  subscribeSource(
    sourceType: SessionSourceType,
    sourceId: string,
    subscriberId: string
  ): () => void {
    const key = this.getSourceKey(sourceType, sourceId);
    if (!this.sourceSubscriptions.has(key)) {
      this.sourceSubscriptions.set(key, new Set());
    }
    this.sourceSubscriptions.get(key)!.add(subscriberId);

    return () => {
      this.sourceSubscriptions.get(key)?.delete(subscriberId);
    };
  }

  /**
   * 获取来源下的所有会话 ID
   */
  getSessionsBySource(
    sourceType: SessionSourceType,
    sourceId: string
  ): string[] {
    const key = this.getSourceKey(sourceType, sourceId);
    return Array.from(this.sourceSessions.get(key) || []);
  }

  /**
   * 获取所有来源分组
   */
  getAllSourceGroups(): Map<string, Set<string>> {
    return new Map(this.sourceSessions);
  }

  /**
   * 获取来源的订阅者
   */
  getSourceSubscribers(
    sourceType: SessionSourceType,
    sourceId: string
  ): string[] {
    const key = this.getSourceKey(sourceType, sourceId);
    return Array.from(this.sourceSubscriptions.get(key) || []);
  }
}
```

### 4.3 SessionStoreManager 扩展

```typescript
// src/stores/conversationStore/sessionStoreManager.ts

interface SessionManagerActions {
  // ...existing methods...

  // ===== 新增：接管相关 =====

  /**
   * 接管会话 - 创建可见窗口
   *
   * @param sourceType 来源类型
   * @param sourceId 来源ID（taskId 或机器人实例ID）
   * @param options 可选配置
   * @returns 前端会话 ID
   */
  takeOverSession: (
    sourceType: SessionSourceType,
    sourceId: string,
    options?: {
      backendSessionId?: string;  // 后端会话ID，用于继续对话
      title?: string;             // 自定义标题
    }
  ) => string;

  /**
   * 获取来源下的会话列表
   */
  getSessionsBySource: (
    sourceType: SessionSourceType,
    sourceId: string
  ) => SessionMetadata[];

  /**
   * 获取所有来源分组
   */
  getSourceGroups: () => SourceSessionGroup[];

  /**
   * 订阅来源（新会话自动接管）
   */
  subscribeToSource: (
    sourceType: SessionSourceType,
    sourceId: string
  ) => () => void;

  /**
   * 更新会话的后端 sessionId
   * 当收到 session_start 事件时调用
   */
  updateSessionBackendId: (
    frontendSessionId: string,
    backendSessionId: string
  ) => void;
}

// ===== 实现部分 =====

function createSessionManagerStore() {
  return createStore<SessionManagerStore>((set, get) => ({
    // ...existing implementation...

    takeOverSession: (sourceType, sourceId, options = {}) => {
      const { backendSessionId, title } = options;

      // 1. 确定前端 sessionId
      // 如果有 backendSessionId，使用它作为前端 sessionId（确保事件路由正确）
      // 否则生成新的 UUID
      const sessionId = backendSessionId || crypto.randomUUID();

      // 2. 检查会话是否已存在
      if (get().stores.has(sessionId)) {
        // 已存在，切换到该会话
        get().switchSession(sessionId);
        log.info('会话已存在，切换到该会话', { sessionId });
        return sessionId;
      }

      // 3. 获取来源名称
      const sourceName = getSourceDisplayName(sourceType, sourceId, get());

      // 4. 创建会话
      get().createSession({
        id: sessionId,
        type: 'free',
        title: title || `${sourceName} - 会话`,
        silentMode: false,
      });

      // 5. 设置来源信息和接管时间
      set((state) => {
        const meta = state.sessionMetadata.get(sessionId);
        if (meta) {
          const newMetadata = new Map(state.sessionMetadata);
          newMetadata.set(sessionId, {
            ...meta,
            source: {
              type: sourceType,
              sourceId,
              sourceName,
            },
            takenOverAt: new Date().toISOString(),
            backendSessionId,
          });
          return { sessionMetadata: newMetadata };
        }
        return state;
      });

      // 6. 注册到 EventRouter
      getEventRouter().registerSessionSource(sessionId, sourceType, sourceId);

      // 7. 切换到该会话
      get().switchSession(sessionId);

      log.info('接管会话成功', { sessionId, sourceType, sourceId });
      return sessionId;
    },

    getSessionsBySource: (sourceType, sourceId) => {
      const sessionIds = getEventRouter().getSessionsBySource(sourceType, sourceId);
      return sessionIds
        .map(id => get().sessionMetadata.get(id))
        .filter((m): m is SessionMetadata => m !== undefined);
    },

    getSourceGroups: () => {
      const groups = getEventRouter().getAllSourceGroups();
      const result: SourceSessionGroup[] = [];

      groups.forEach((sessionIds, key) => {
        // 解析 key: "scheduler-task123" 或 "qqbot-instance1"
        const [type, ...idParts] = key.split('-');
        const id = idParts.join('-'); // 处理 ID 中包含 '-' 的情况

        const sessions = Array.from(sessionIds)
          .map(sid => get().sessionMetadata.get(sid))
          .filter((m): m is SessionMetadata => m !== undefined);

        if (sessions.length > 0) {
          const firstSession = sessions[0];
          result.push({
            sourceType: type as SessionSourceType,
            sourceId: id,
            sourceName: firstSession.source?.sourceName || id,
            icon: firstSession.source?.icon,
            sessions: sessions.sort((a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            ),
          });
        }
      });

      // 按来源类型排序：scheduler > qqbot > feishu
      return result.sort((a, b) => {
        const order = { scheduler: 0, qqbot: 1, feishu: 2, manual: 3 };
        return (order[a.sourceType] ?? 99) - (order[b.sourceType] ?? 99);
      });
    },

    subscribeToSource: (sourceType, sourceId) => {
      const subscriberId = crypto.randomUUID();
      return getEventRouter().subscribeSource(sourceType, sourceId, subscriberId);
    },

    updateSessionBackendId: (frontendSessionId, backendSessionId) => {
      set((state) => {
        const meta = state.sessionMetadata.get(frontendSessionId);
        if (meta) {
          const newMetadata = new Map(state.sessionMetadata);
          newMetadata.set(frontendSessionId, {
            ...meta,
            backendSessionId,
          });
          return { sessionMetadata: newMetadata };
        }
        return state;
      });
    },
  }));
}

/**
 * 获取来源显示名称
 */
function getSourceDisplayName(
  sourceType: SessionSourceType,
  sourceId: string,
  getState: () => SessionManagerState
): string {
  switch (sourceType) {
    case 'scheduler': {
      // 从 schedulerStore 获取任务名称
      const task = useSchedulerStore.getState().tasks.find(t => t.id === sourceId);
      return task?.name || `定时任务 ${sourceId}`;
    }
    case 'qqbot': {
      // 从 integrationStore 获取机器人名称
      const instance = useIntegrationStore.getState().getActiveInstance('qqbot');
      return instance?.name || `QQ机器人 ${sourceId}`;
    }
    case 'feishu': {
      const instance = useIntegrationStore.getState().getActiveInstance('feishu');
      return instance?.name || `飞书机器人 ${sourceId}`;
    }
    default:
      return sourceId;
  }
}
```

### 4.4 SchedulerStore 改造

```typescript
// src/stores/schedulerStore.ts

// 在 handleTaskDue 方法中，创建会话时注册来源
handleTaskDue: async (event) => {
  // ...existing code...

  // 调用 AI 引擎时，使用标准化的 contextId
  const sessionId = await invoke<string>('start_chat', {
    message: finalPrompt,
    options: {
      workDir,
      contextId: `scheduler-${taskId}`,  // 格式: scheduler-{taskId}
      engineId,
      enableMcpTools: engineId === 'claude-code',
    },
  });

  // ===== 新增：注册会话来源 =====
  // 后端返回的 sessionId 即为后端会话ID
  // 前端使用 contextId 作为前端 sessionId（保持一致性）
  const frontendSessionId = `scheduler-${taskId}`;
  getEventRouter().registerSessionSource(
    frontendSessionId,
    'scheduler',
    taskId
  );

  // 更新执行信息，记录 sessionId
  set((state) => {
    const newExecutions = new Map(state.executions);
    const execution = newExecutions.get(taskId);
    if (execution) {
      execution.sessionId = sessionId;
    }
    return { executions: newExecutions };
  });

  console.log('[Scheduler] 任务执行会话 ID:', sessionId);
},
```

### 4.5 新增组件：SessionSourcePanel

```tsx
// src/components/Session/SessionSourcePanel.tsx

/**
 * 会话来源管理面板
 *
 * 显示所有 AI 会话，按来源分组（定时任务/机器人/手动）
 * 支持接管、中断、查看等操作
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Bot,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle,
  XCircle,
  Circle,
  Play,
  Square,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  useSessionManagerActions,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager';
import { useSchedulerStore } from '@/stores';
import type {
  SessionSourceType,
  SourceSessionGroup,
  SessionMetadata,
} from '@/stores/conversationStore/types';

interface SessionSourcePanelProps {
  /** 关闭回调（接管后调用） */
  onClose?: () => void;
  /** 自定义类名 */
  className?: string;
}

export function SessionSourcePanel({ onClose, className }: SessionSourcePanelProps) {
  const { t } = useTranslation('common');
  const { takeOverSession, getSourceGroups, interruptSession } = useSessionManagerActions();
  const allSessions = useSessionMetadataList();

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // 获取来源分组
  const groups = useMemo(() => getSourceGroups(), [allSessions]);

  // 手动会话（无来源）
  const manualSessions = useMemo(
    () => allSessions.filter(s => !s.source),
    [allSessions]
  );

  // 按类型分组
  const schedulerGroups = groups.filter(g => g.sourceType === 'scheduler');
  const qqbotGroups = groups.filter(g => g.sourceType === 'qqbot');
  const feishuGroups = groups.filter(g => g.sourceType === 'feishu');

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleTakeOver = (group: SourceSessionGroup, sessionId?: string) => {
    takeOverSession(group.sourceType, group.sourceId, {
      backendSessionId: sessionId,
    });
    onClose?.();
  };

  const handleInterrupt = async (sessionId: string) => {
    await interruptSession(sessionId);
  };

  return (
    <div className={cn('flex flex-col h-full bg-background-surface', className)}>
      {/* 头部 */}
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-primary">
          {t('sessionSource.title', '会话管理')}
        </h2>
        <span className="text-xs text-text-muted">
          {groups.reduce((sum, g) => sum + g.sessions.length, 0) + manualSessions.length} 个会话
        </span>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 定时任务 */}
        {schedulerGroups.length > 0 && (
          <SourceSection
            icon={<Clock size={14} />}
            title={t('sessionSource.scheduler', '定时任务')}
            groups={schedulerGroups}
            expandedGroups={expandedGroups}
            onToggle={toggleGroup}
            onTakeOver={handleTakeOver}
            onInterrupt={handleInterrupt}
          />
        )}

        {/* QQ机器人 */}
        {qqbotGroups.length > 0 && (
          <SourceSection
            icon={<Bot size={14} />}
            title={t('sessionSource.qqbot', 'QQ机器人')}
            groups={qqbotGroups}
            expandedGroups={expandedGroups}
            onToggle={toggleGroup}
            onTakeOver={handleTakeOver}
            onInterrupt={handleInterrupt}
          />
        )}

        {/* 飞书机器人 */}
        {feishuGroups.length > 0 && (
          <SourceSection
            icon={<MessageSquare size={14} />}
            title={t('sessionSource.feishu', '飞书机器人')}
            groups={feishuGroups}
            expandedGroups={expandedGroups}
            onToggle={toggleGroup}
            onTakeOver={handleTakeOver}
            onInterrupt={handleInterrupt}
          />
        )}

        {/* 手动会话 */}
        {manualSessions.length > 0 && (
          <div className="border-t border-border">
            <div className="px-3 py-1.5 text-xs text-text-muted bg-background-base">
              {t('sessionSource.manual', '手动会话')}
            </div>
            {manualSessions.map(session => (
              <SessionItem
                key={session.id}
                session={session}
                onTakeOver={() => {
                  // 手动会话不需要接管，直接切换
                  onClose?.();
                }}
              />
            ))}
          </div>
        )}

        {/* 空状态 */}
        {groups.length === 0 && manualSessions.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-sm text-text-muted py-8">
            {t('sessionSource.empty', '暂无会话')}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== 子组件 =====

interface SourceSectionProps {
  icon: React.ReactNode;
  title: string;
  groups: SourceSessionGroup[];
  expandedGroups: Set<string>;
  onToggle: (key: string) => void;
  onTakeOver: (group: SourceSessionGroup, sessionId?: string) => void;
  onInterrupt: (sessionId: string) => void;
}

function SourceSection({
  icon,
  title,
  groups,
  expandedGroups,
  onToggle,
  onTakeOver,
  onInterrupt,
}: SourceSectionProps) {
  return (
    <div className="border-b border-border">
      {/* 分类标题 */}
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted bg-background-base">
        {icon}
        <span>{title}</span>
      </div>

      {/* 来源列表 */}
      {groups.map(group => {
        const key = `${group.sourceType}-${group.sourceId}`;
        const isExpanded = expandedGroups.has(key);
        const runningSession = group.sessions.find(s => s.status === 'running');
        const hasRunning = !!runningSession;

        return (
          <div key={key}>
            {/* 来源行 */}
            <div
              className="px-3 py-2 flex items-center justify-between hover:bg-background-hover cursor-pointer"
              onClick={() => onToggle(key)}
            >
              <div className="flex items-center gap-2">
                {isExpanded ? (
                  <ChevronDown size={14} className="text-text-muted" />
                ) : (
                  <ChevronRight size={14} className="text-text-muted" />
                )}
                <span className="text-sm text-text-primary truncate max-w-40">
                  {group.sourceName}
                </span>
                {hasRunning && (
                  <Loader2 size={12} className="text-info animate-spin" />
                )}
                <span className="text-xs text-text-muted">
                  {group.sessions.length}
                </span>
              </div>

              {/* 接管按钮 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTakeOver(group, runningSession?.id);
                }}
                className={cn(
                  'px-2 py-0.5 text-xs rounded transition-colors',
                  hasRunning
                    ? 'bg-primary text-white hover:bg-primary-dark'
                    : 'bg-background-hover text-text-secondary hover:text-text-primary'
                )}
              >
                {hasRunning ? '接管' : '查看'}
              </button>
            </div>

            {/* 展开的会话列表 */}
            {isExpanded && (
              <div className="pl-6 pr-3 pb-2 space-y-1">
                {group.sessions.map(session => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    showTakeOver={!session.takenOverAt}
                    onTakeOver={() => onTakeOver(group, session.id)}
                    onInterrupt={() => onInterrupt(session.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SessionItemProps {
  session: SessionMetadata;
  showTakeOver?: boolean;
  onTakeOver?: () => void;
  onInterrupt?: () => void;
}

function SessionItem({ session, showTakeOver, onTakeOver, onInterrupt }: SessionItemProps) {
  const isRunning = session.status === 'running';

  return (
    <div className="py-1.5 px-2 flex items-center justify-between rounded hover:bg-background-hover group">
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={session.status} />
        <span className="text-sm text-text-primary truncate max-w-32">
          {session.title}
        </span>
        {session.takenOverAt && (
          <span className="text-xs text-primary">已接管</span>
        )}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {showTakeOver && onTakeOver && (
          <button
            onClick={onTakeOver}
            className="px-1.5 py-0.5 text-xs text-primary hover:underline"
          >
            接管
          </button>
        )}
        {isRunning && onInterrupt && (
          <button
            onClick={onInterrupt}
            className="px-1.5 py-0.5 text-xs text-danger hover:underline"
          >
            中断
          </button>
        )}
      </div>
    </div>
  );
}

/** 状态指示点 */
function StatusDot({ status }: { status: SessionMetadata['status'] }) {
  const iconMap: Record<SessionMetadata['status'], React.ReactNode> = {
    idle: <Circle size={10} className="text-text-muted" />,
    running: <Loader2 size={10} className="text-info animate-spin" />,
    waiting: <Circle size={10} className="text-warning" />,
    error: <XCircle size={10} className="text-danger" />,
    'background-running': <Loader2 size={10} className="text-info animate-spin" />,
  };
  return <>{iconMap[status]}</>;
}

export default SessionSourcePanel;
```

### 4.6 改造 ExecutionLogDrawer

```tsx
// src/components/Scheduler/ExecutionLogDrawer.tsx

// 在 ExecutionTab 组件中增加接管按钮

import { useSessionManagerActions } from '@/stores/conversationStore/sessionStoreManager';

// ...existing imports...

function ExecutionTab({
  execution,
  isActive,
  onClick,
  onClose,
}: {
  execution: TaskExecutionInfo;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const { takeOverSession } = useSessionManagerActions();
  const isRunning = execution.state === 'running';

  const handleTakeOver = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 使用 taskId 作为 sourceId
    takeOverSession('scheduler', execution.taskId, {
      backendSessionId: execution.sessionId, // 如果后端返回了 sessionId
    });
  };

  return (
    <button
      onClick={onClick}
      className={/* ...existing classes... */}
    >
      <StateIcon state={execution.state} />
      <span className="max-w-24 truncate">{execution.taskName}</span>

      {/* 新增：接管按钮 */}
      {isRunning && (
        <span
          onClick={handleTakeOver}
          className="ml-1 text-xs text-primary hover:underline"
        >
          接管
        </span>
      )}

      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 text-text-muted hover:text-text-primary"
      >
        ×
      </span>
    </button>
  );
}

// 扩展 TaskExecutionInfo 类型，增加 sessionId 字段
// src/types/scheduler.ts
export interface TaskExecutionInfo {
  taskId: string;
  taskName: string;
  state: ExecutionState;
  startTime: number;
  endTime?: number;
  logs: ExecutionLogEntry[];
  sessionId?: string;  // 新增：后端会话ID
}
```

---

## 五、实现计划

### Phase 1：基础能力（预计 1.5 天）

| 序号 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 1.1 | 类型定义扩展 | `src/stores/conversationStore/types.ts` | 0.5h |
| 1.2 | EventRouter 扩展 | `src/services/eventRouter.ts` | 2h |
| 1.3 | SessionStoreManager 扩展 | `src/stores/conversationStore/sessionStoreManager.ts` | 3h |
| 1.4 | 单元测试 | `src/stores/**/*.test.ts` | 1h |

### Phase 2：定时任务接管（预计 1 天）

| 序号 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 2.1 | SchedulerStore 改造 | `src/stores/schedulerStore.ts` | 1h |
| 2.2 | ExecutionLogDrawer 改造 | `src/components/Scheduler/ExecutionLogDrawer.tsx` | 2h |
| 2.3 | 测试定时任务接管流程 | - | 1h |

### Phase 3：管理面板（预计 1 天）

| 序号 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 3.1 | SessionSourcePanel 组件 | `src/components/Session/SessionSourcePanel.tsx` | 3h |
| 3.2 | 集成到左侧面板 | `src/components/Layout/LeftPanel.tsx` | 1h |
| 3.3 | 国际化 | `src/locales/zh/common.json` | 0.5h |

### Phase 4：集成扩展（预计 0.5 天）

| 序号 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 4.1 | IntegrationStore 改造 | `src/stores/integrationStore.ts` | 1h |
| 4.2 | 集成面板增加接管按钮 | `src/components/Integration/` | 1h |

---

## 六、测试用例

### 6.1 接管功能测试

```typescript
// src/stores/conversationStore/sessionStoreManager.test.ts

describe('takeOverSession', () => {
  it('should create new session if not exists', () => {
    const sessionId = sessionStoreManager.getState().takeOverSession(
      'scheduler',
      'task-123',
      { backendSessionId: 'backend-456' }
    );

    expect(sessionId).toBe('backend-456');
    expect(sessionStoreManager.getState().stores.has(sessionId)).toBe(true);

    const meta = sessionStoreManager.getState().sessionMetadata.get(sessionId);
    expect(meta?.source?.type).toBe('scheduler');
    expect(meta?.source?.sourceId).toBe('task-123');
    expect(meta?.takenOverAt).toBeDefined();
  });

  it('should switch to existing session if already exists', () => {
    // 先创建
    const sessionId = sessionStoreManager.getState().takeOverSession(
      'scheduler',
      'task-123'
    );

    // 再次接管
    const sessionId2 = sessionStoreManager.getState().takeOverSession(
      'scheduler',
      'task-123'
    );

    expect(sessionId).toBe(sessionId2);
  });

  it('should register session source to EventRouter', () => {
    const sessionId = sessionStoreManager.getState().takeOverSession(
      'scheduler',
      'task-456'
    );

    const sessions = getEventRouter().getSessionsBySource('scheduler', 'task-456');
    expect(sessions).toContain(sessionId);
  });
});

describe('getSourceGroups', () => {
  it('should return groups sorted by type', () => {
    // 创建不同来源的会话
    sessionStoreManager.getState().takeOverSession('feishu', 'feishu-1');
    sessionStoreManager.getState().takeOverSession('scheduler', 'task-1');
    sessionStoreManager.getState().takeOverSession('qqbot', 'qq-1');

    const groups = sessionStoreManager.getState().getSourceGroups();

    expect(groups[0].sourceType).toBe('scheduler');
    expect(groups[1].sourceType).toBe('qqbot');
    expect(groups[2].sourceType).toBe('feishu');
  });
});
```

### 6.2 事件路由测试

```typescript
// src/services/eventRouter.test.ts

describe('registerSessionSource', () => {
  it('should track session source relationship', () => {
    const router = getEventRouter();

    router.registerSessionSource('session-1', 'scheduler', 'task-1');
    router.registerSessionSource('session-2', 'scheduler', 'task-1');
    router.registerSessionSource('session-3', 'qqbot', 'qq-1');

    const schedulerSessions = router.getSessionsBySource('scheduler', 'task-1');
    expect(schedulerSessions).toEqual(['session-1', 'session-2']);

    const qqbotSessions = router.getSessionsBySource('qqbot', 'qq-1');
    expect(qqbotSessions).toEqual(['session-3']);
  });
});
```

---

## 七、风险与注意事项

### 7.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 后端 sessionId 与前端不一致 | 继续对话失败 | 使用 contextId 作为前端 sessionId，保持一致 |
| 事件路由冲突 | 事件丢失或重复 | EventRouter 单例模式，强制单 handler |
| 会话生命周期管理 | 内存泄漏 | LRU 驱逐 + dispose 清理 |

### 7.2 边界情况

1. **任务执行中用户刷新页面**：会话数据丢失，需要后端支持历史恢复
2. **同一来源并发执行**：多个会话同时运行，需要正确区分
3. **接管后中断**：需要同步更新原任务状态

### 7.3 后续优化

1. **后端事件携带 source 信息**：更准确的来源追踪
2. **历史消息加载 API**：接管时加载之前的历史
3. **会话持久化**：刷新后恢复会话状态

---

## 八、验收标准

- [ ] 用户可在管理面板查看所有会话（按来源分组）
- [ ] 点击"接管"后，AI 对话页面新开标签页
- [ ] 接管后事件实时流向新窗口
- [ ] 接管后可发送消息、中断执行
- [ ] 定时任务执行时自动注册来源
- [ ] 单元测试覆盖核心逻辑
