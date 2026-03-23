/**
 * Developer 面板 - 调试 AIEvent 原始流
 *
 * 功能：
 * 1. 显示 AIEvent 原始流
 * 2. 可按 taskId / sessionId 过滤
 * 3. UI 只读，不影响逻辑
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { clsx } from 'clsx'
import type { AIEvent } from '../../ai-runtime'
import { getEventBus } from '../../ai-runtime'

/** 单个事件记录 */
interface EventRecord {
  id: string
  timestamp: number
  event: AIEvent
}

/** 过滤器类型 */
type FilterType = 'all' | 'taskId' | 'sessionId'

/** 事件类型颜色映射 */
const EVENT_TYPE_COLORS: Record<string, string> = {
  token: 'text-blue-400',
  tool_call_start: 'text-yellow-400',
  tool_call_end: 'text-green-400',
  progress: 'text-purple-400',
  result: 'text-emerald-400',
  error: 'text-red-400',
  session_start: 'text-cyan-400',
  session_end: 'text-gray-400',
  user_message: 'text-orange-400',
  assistant_message: 'text-pink-400',
  task_metadata: 'text-indigo-400',
  task_progress: 'text-violet-400',
  task_completed: 'text-teal-400',
  task_canceled: 'text-rose-400',
}

export interface DeveloperPanelProps {
  className?: string
  width?: number
  /** 是否填充剩余空间（当右侧没有其他面板时） */
  fillRemaining?: boolean
}

export function DeveloperPanel({ className = '', width, fillRemaining = false }: DeveloperPanelProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [events, setEvents] = useState<EventRecord[]>([])
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [filterValue, setFilterValue] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [maxEvents, setMaxEvents] = useState(20)
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null)

  const eventsEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 订阅 EventBus
  useEffect(() => {
    const eventBus = getEventBus({ debug: false })

    const unsubscribe = eventBus.onAny((event: AIEvent) => {
      const record: EventRecord = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        event,
      }

      setEvents((prev) => {
        const newEvents = [...prev, record]
        // 限制最大事件数量
        if (newEvents.length > maxEvents) {
          return newEvents.slice(-maxEvents)
        }
        return newEvents
      })
    })

    return () => unsubscribe()
  }, [maxEvents])

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events, autoScroll])

  // 过滤后的事件列表
  const filteredEvents = useMemo(() => {
    if (filterType === 'all' || !filterValue) {
      if (selectedEventType) {
        return events.filter((r) => r.event.type === selectedEventType)
      }
      return events
    }

    return events.filter((record) => {
      const event = record.event

      if (filterType === 'taskId') {
        return 'taskId' in event && event.taskId === filterValue
      }

      if (filterType === 'sessionId') {
        return 'sessionId' in event && event.sessionId === filterValue
      }

      return true
    })
  }, [events, filterType, filterValue, selectedEventType])

  // 提取所有事件类型
  const eventTypes = useMemo(() => {
    const types = new Set(events.map((r) => r.event.type))
    return Array.from(types).sort()
  }, [events])

  // 清空事件
  const clearEvents = () => {
    setEvents([])
  }

  // 复制事件 JSON
  const copyEvent = (event: AIEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2))
  }

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + '.' + date.getMilliseconds().toString().padStart(3, '0')
  }

  // 渲染单个事件的详情
  const renderEventDetail = (event: AIEvent) => {
    const detail: Record<string, unknown> = { ...event }
    delete (detail as { type?: unknown }).type

    return (
      <pre className="text-xs text-text-tertiary font-mono whitespace-pre-wrap break-all">
        {JSON.stringify(detail, null, 2)}
      </pre>
    )
  }

  // 填充模式：嵌入左侧面板容器，继承外层尺寸
  if (fillRemaining) {
    return (
      <div
        ref={containerRef}
        className={clsx(
          'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background-elevated',
          className
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-sm font-medium text-text-primary">Developer</span>
            <span className="text-xs text-text-tertiary bg-background-surface px-2 py-0.5 rounded-md">
              {filteredEvents.length}
            </span>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* 过滤器栏 */}
          <div className="flex flex-col gap-2 px-4 py-3 border-b border-border-subtle bg-background-surface shrink-0">
            {/* 第一行：过滤类型 */}
            <div className="flex items-center gap-2">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as FilterType)}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="all">全部事件</option>
                <option value="taskId">按 Task ID</option>
                <option value="sessionId">按 Session ID</option>
              </select>

              {(filterType === 'taskId' || filterType === 'sessionId') && (
                <input
                  type="text"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={filterType === 'taskId' ? 'Task ID...' : 'Session ID...'}
                  className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
                />
              )}
            </div>

            {/* 第二行：事件类型过滤 + 操作按钮 */}
            <div className="flex items-center gap-2">
              <select
                value={selectedEventType || ''}
                onChange={(e) => setSelectedEventType(e.target.value || null)}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="">全部类型</option>
                {eventTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>

              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={clsx(
                  'px-2 py-1.5 text-xs rounded-md border transition-colors',
                  autoScroll
                    ? 'bg-primary/10 border-primary text-primary'
                    : 'bg-background border-border text-text-tertiary hover:text-text-primary'
                )}
                title={autoScroll ? '自动滚动: 开' : '自动滚动: 关'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>

              <button
                onClick={clearEvents}
                className="px-2 py-1.5 text-xs bg-background border border-border text-text-tertiary rounded-md hover:text-text-primary hover:bg-background-hover transition-colors"
                title="清空事件"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>

            {/* 第三行：最大事件数设置 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-tertiary">最大事件数:</span>
              <input
                type="number"
                min={100}
                max={10000}
                step={100}
                value={maxEvents}
                onChange={(e) => setMaxEvents(Number(e.target.value))}
                className="w-20 px-2 py-1 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* 事件列表 */}
          <div className="flex min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                <svg className="w-12 h-12 mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-sm">暂无事件</span>
              </div>
            ) : (
              <div className="min-w-0 space-y-1">
                {filteredEvents.map((record) => {
                  const eventType = record.event.type
                  const colorClass = EVENT_TYPE_COLORS[eventType] || 'text-text-secondary'

                  return (
                    <div
                      key={record.id}
                      className={clsx(
                        'p-2 rounded-md bg-background-surface border border-border-subtle hover:border-border transition-colors cursor-default'
                      )}
                    >
                      {/* 事件头部 */}
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={clsx('text-xs font-mono font-medium', colorClass)}>
                            {eventType}
                          </span>
                          <span className="text-xs text-text-tertiary font-mono">
                            {formatTime(record.timestamp)}
                          </span>
                        </div>
                        <button
                          onClick={() => copyEvent(record.event)}
                          className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                          title="复制 JSON"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>

                      {/* 事件详情 */}
                      {renderEventDetail(record.event)}
                    </div>
                  )
                })}
                <div ref={eventsEndRef} />
              </div>
            )}
          </div>

          {/* 底部状态栏 */}
          <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-tertiary bg-background-surface flex items-center justify-between shrink-0">
            <span>总计: {events.length}</span>
            <span>已过滤: {filteredEvents.length}</span>
          </div>
        </div>
      </div>
    )
  }

  const widthStyle = isOpen
    ? { width: width ? `${width}px` : '400px' }
    : { width: '40px' }

  return (
    <aside
      ref={containerRef}
      className={clsx(
        'flex min-h-0 min-w-0 flex-col border-l border-border bg-background-elevated transition-all duration-300 shrink-0',
        className
      )}
      style={widthStyle}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
        {isOpen ? (
          <>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-sm font-medium text-text-primary">Developer</span>
              <span className="text-xs text-text-tertiary bg-background-surface px-2 py-0.5 rounded-md">
                {filteredEvents.length}
              </span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 text-text-tertiary hover:text-text-primary transition-colors rounded-lg hover:bg-background-hover"
              title="折叠面板"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </>
        ) : (
          <button
            onClick={() => setIsOpen(true)}
            className="w-full h-full flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors"
            title="展开 Developer 面板"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* 内容区 */}
      {isOpen && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* 过滤器栏 */}
          <div className="flex flex-col gap-2 px-4 py-3 border-b border-border-subtle bg-background-surface shrink-0">
            {/* 第一行：过滤类型 */}
            <div className="flex items-center gap-2">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as FilterType)}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="all">全部事件</option>
                <option value="taskId">按 Task ID</option>
                <option value="sessionId">按 Session ID</option>
              </select>

              {(filterType === 'taskId' || filterType === 'sessionId') && (
                <input
                  type="text"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={filterType === 'taskId' ? 'Task ID...' : 'Session ID...'}
                  className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
                />
              )}
            </div>

            {/* 第二行：事件类型过滤 + 操作按钮 */}
            <div className="flex items-center gap-2">
              <select
                value={selectedEventType || ''}
                onChange={(e) => setSelectedEventType(e.target.value || null)}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="">全部类型</option>
                {eventTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>

              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={clsx(
                  'px-2 py-1.5 text-xs rounded-md border transition-colors',
                  autoScroll
                    ? 'bg-primary/10 border-primary text-primary'
                    : 'bg-background border-border text-text-tertiary hover:text-text-primary'
                )}
                title={autoScroll ? '自动滚动: 开' : '自动滚动: 关'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>

              <button
                onClick={clearEvents}
                className="px-2 py-1.5 text-xs bg-background border border-border text-text-tertiary rounded-md hover:text-text-primary hover:bg-background-hover transition-colors"
                title="清空事件"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>

            {/* 第三行：最大事件数设置 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-tertiary">最大事件数:</span>
              <input
                type="number"
                min={100}
                max={10000}
                step={100}
                value={maxEvents}
                onChange={(e) => setMaxEvents(Number(e.target.value))}
                className="w-20 px-2 py-1 text-xs bg-background border border-border rounded-md text-text-primary focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* 事件列表 */}
          <div className="flex min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                <svg className="w-12 h-12 mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-sm">暂无事件</span>
              </div>
            ) : (
              <div className="min-w-0 space-y-1">
                {filteredEvents.map((record) => {
                  const eventType = record.event.type
                  const colorClass = EVENT_TYPE_COLORS[eventType] || 'text-text-secondary'

                  return (
                    <div
                      key={record.id}
                      className={clsx(
                        'p-2 rounded-md bg-background-surface border border-border-subtle hover:border-border transition-colors cursor-default'
                      )}
                    >
                      {/* 事件头部 */}
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={clsx('text-xs font-mono font-medium', colorClass)}>
                            {eventType}
                          </span>
                          <span className="text-xs text-text-tertiary font-mono">
                            {formatTime(record.timestamp)}
                          </span>
                        </div>
                        <button
                          onClick={() => copyEvent(record.event)}
                          className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                          title="复制 JSON"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>

                      {/* 事件详情 */}
                      {renderEventDetail(record.event)}
                    </div>
                  )
                })}
                <div ref={eventsEndRef} />
              </div>
            )}
          </div>

          {/* 底部状态栏 */}
          <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-tertiary bg-background-surface flex items-center justify-between shrink-0">
            <span>总计: {events.length}</span>
            <span>已过滤: {filteredEvents.length}</span>
          </div>
        </div>
      )}
    </aside>
  )
}
