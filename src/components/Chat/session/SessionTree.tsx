/**
 * 会话树形列表组件
 *
 * 显示会话的树形结构，支持 Fork 关系和 PR 关联的可视化
 */

import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, MessageSquare, RotateCcw, Loader2, ChevronRight, ChevronDown, Circle, Dot } from 'lucide-react'
import type { UnifiedHistoryItem } from '@/services/historyService'
import { ForkIndicator } from './ForkIndicator'

export interface SessionTreeProps {
  /** 会话列表 */
  sessions: UnifiedHistoryItem[]
  /** 加载中 */
  loading?: boolean
  /** 恢复会话回调 */
  onRestore?: (session: UnifiedHistoryItem) => void
  /** 正在恢复的会话 ID */
  restoringId?: string | null
  /** 选中会话回调 */
  onSelect?: (session: UnifiedHistoryItem) => void
  /** 选中的会话 ID */
  selectedId?: string | null
  /** 导航到父会话 */
  onNavigateToParent?: (sessionId: string) => void
  /** 导航到子会话 */
  onNavigateToChild?: (sessionId: string) => void
  /** 查看 PR */
  onViewPR?: (prNumber: number, url?: string) => void
}

/** 会话树节点 */
interface SessionTreeNode {
  session: UnifiedHistoryItem
  children: SessionTreeNode[]
  level: number
}

/**
 * 构建会话树结构
 */
function buildSessionTree(sessions: UnifiedHistoryItem[]): SessionTreeNode[] {
  // 建立 ID -> Session 映射
  const sessionMap = new Map<string, UnifiedHistoryItem>()
  const nodeMap = new Map<string, SessionTreeNode>()

  sessions.forEach(s => {
    sessionMap.set(s.id, s)
    nodeMap.set(s.id, { session: s, children: [], level: 0 })
  })

  // 建立父子关系
  const roots: SessionTreeNode[] = []

  sessions.forEach(s => {
    const node = nodeMap.get(s.id)
    if (!node) return

    if (s.parentSessionId && nodeMap.has(s.parentSessionId)) {
      // 有父节点，添加到父节点的 children
      const parent = nodeMap.get(s.parentSessionId)
      if (parent) {
        parent.children.push(node)
        node.level = parent.level + 1
      }
    } else {
      // 无父节点，作为根节点
      roots.push(node)
    }
  })

  // 按时间排序（最新的在前）
  const sortByTime = (a: SessionTreeNode, b: SessionTreeNode) =>
    new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime()

  const sortChildren = (node: SessionTreeNode) => {
    node.children.sort(sortByTime)
    node.children.forEach(sortChildren)
  }

  roots.sort(sortByTime)
  roots.forEach(sortChildren)

  return roots
}

/**
 * 会话树节点组件
 */
interface SessionNodeProps {
  node: SessionTreeNode
  level: number
  expanded: boolean
  selected: boolean
  restoring: boolean
  onToggle: () => void
  onSelect: () => void
  onRestore: () => void
  onNavigateToParent?: (sessionId: string) => void
  onNavigateToChild?: (sessionId: string) => void
  onViewPR?: (prNumber: number, url?: string) => void
}

function SessionNode({
  node,
  level,
  expanded,
  selected,
  restoring,
  onToggle,
  onSelect,
  onRestore,
  onNavigateToParent,
  onNavigateToChild,
  onViewPR,
}: SessionNodeProps) {
  const { t } = useTranslation('chat')
  const { session, children } = node
  const hasChildren = children.length > 0

  // 缩进
  const indentStyle = { paddingLeft: `${level * 16 + 12}px` }

  // 状态图标
  const StatusIcon = session.linkedPr ? Circle : Dot
  const statusColor = session.linkedPr
    ? 'text-violet-500'
    : hasChildren
      ? 'text-amber-500'
      : 'text-blue-500'

  // 格式化时间
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)

    if (diffMins < 1) return t('history.justNow')
    if (diffMins < 60) return t('history.minutesAgo', { count: diffMins })
    if (diffHours < 24) return t('history.hoursAgo', { count: diffHours })

    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="select-none">
      {/* 节点行 */}
      <div
        className={`flex items-start gap-2 py-2.5 cursor-pointer transition-colors group ${
          selected
            ? 'bg-primary/10 border-l-2 border-primary'
            : 'hover:bg-background-hover border-l-2 border-transparent'
        }`}
        style={indentStyle}
        onClick={onSelect}
      >
        {/* 展开/折叠按钮 */}
        <div className="w-4 h-4 flex items-center justify-center shrink-0 mt-0.5">
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggle()
              }}
              className="text-text-tertiary hover:text-text-primary"
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          ) : (
            <StatusIcon className={`w-3 h-3 ${statusColor}`} />
          )}
        </div>

        {/* 会话内容 */}
        <div className="flex-1 min-w-0">
          {/* 标题行 */}
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-text-primary truncate flex-1">
              {session.title}
            </h3>
            {session.linkedPr && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 shrink-0">
                PR #{session.linkedPr.number}
              </span>
            )}
          </div>

          {/* 元信息 */}
          <div className="flex items-center gap-3 text-xs text-text-tertiary mb-1.5">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {t('history.messages', { count: session.messageCount })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTime(session.timestamp)}
            </span>
          </div>

          {/* Fork 指示器（紧凑模式） */}
          {(session.parentSessionId || (session.childSessionIds && session.childSessionIds.length > 0) || session.gitBranch) && (
            <ForkIndicator
              parentSessionId={session.parentSessionId}
              childSessionIds={session.childSessionIds}
              gitBranch={session.gitBranch}
              compact
            />
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRestore()
            }}
            disabled={restoring}
            className={`p-1.5 rounded-md hover:bg-background-elevated transition-colors ${
              restoring ? 'opacity-50 cursor-not-allowed' : 'text-text-secondary hover:text-text-primary'
            }`}
            title={t('history.restoreSession')}
          >
            {restoring ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* 子节点 */}
      {hasChildren && expanded && (
        <div className="relative">
          {/* 连接线 */}
          <div
            className="absolute top-0 bottom-0 border-l border-amber-200 dark:border-amber-800"
            style={{ left: `${level * 16 + 20}px` }}
          />
          {children.map((child) => (
            <SessionNode
              key={child.session.id}
              node={child}
              level={level + 1}
              expanded={false}
              selected={false}
              restoring={false}
              onToggle={() => {}}
              onSelect={() => {}}
              onRestore={() => {}}
              onNavigateToParent={onNavigateToParent}
              onNavigateToChild={onNavigateToChild}
              onViewPR={onViewPR}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 会话树组件
 */
export function SessionTree({
  sessions,
  loading = false,
  onRestore,
  restoringId,
  onSelect,
  selectedId,
  onNavigateToParent,
  onNavigateToChild,
  onViewPR,
}: SessionTreeProps) {
  const { t } = useTranslation('chat')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // 构建树结构
  const tree = useMemo(() => buildSessionTree(sessions), [sessions])

  // 切换展开状态
  const toggleExpand = useCallback((sessionId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }, [])

  // 扁平化树节点用于渲染（保持层级信息）
  const flattenedNodes = useMemo(() => {
    const result: SessionTreeNode[] = []

    const flatten = (nodes: SessionTreeNode[]) => {
      nodes.forEach(node => {
        result.push(node)
        if (expandedIds.has(node.session.id) && node.children.length > 0) {
          flatten(node.children)
        }
      })
    }

    flatten(tree)
    return result
  }, [tree, expandedIds])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-text-tertiary" />
        <p className="mt-3 text-sm text-text-secondary">{t('history.loading')}</p>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
        <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
        <p className="text-sm">{t('history.noHistory')}</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-border-subtle">
      {flattenedNodes.map((node) => (
        <SessionNode
          key={node.session.id}
          node={node}
          level={node.level}
          expanded={expandedIds.has(node.session.id)}
          selected={selectedId === node.session.id}
          restoring={restoringId === node.session.id}
          onToggle={() => toggleExpand(node.session.id)}
          onSelect={() => onSelect?.(node.session)}
          onRestore={() => onRestore?.(node.session)}
          onNavigateToParent={onNavigateToParent}
          onNavigateToChild={onNavigateToChild}
          onViewPR={onViewPR}
        />
      ))}
    </div>
  )
}

export default SessionTree
