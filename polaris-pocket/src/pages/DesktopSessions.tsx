/**
 * DesktopSessions — 连接桌面端后的会话续接页面
 *
 * 集成 WS 实时流式渲染 + Pending 卡片交互 + 中断能力。
 * 通过 desktopSessionRuntime 管理会话状态。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import { listSessions, getSessionHistory, type SessionMeta } from '../services/desktopClient';
import {
  useDesktopSessionRuntime,
  selectActiveSession,
  selectTabSessions,
} from '../runtime/desktopSessionRuntime';
import type { PendingCard, SessionRuntimeState } from '../runtime/types';

interface SessionItem {
  id: string;
  title: string;
  engineId: string;
  timestamp: string;
  messageCount: number;
  projectPath?: string;
}

export function DesktopSessions() {
  const activeSession = useDesktopSessionRuntime(selectActiveSession);
  const tabCount = useDesktopSessionRuntime((s) => s.tabOrder.length);
  const openSession = useDesktopSessionRuntime((s) => s.openSession);
  const clearActive = useDesktopSessionRuntime((s) => s.clearActive);
  const [openError, setOpenError] = useState<string | null>(null);

  // 确保运行时已初始化
  useEffect(() => {
    void useDesktopSessionRuntime.getState().ensureInitialized();
  }, []);

  const handleOpenSession = useCallback(
    (detail: { id: string; title: string; engineId: string; projectPath?: string; messages: import('../runtime/types').ChatMessage[] }) => {
      setOpenError(null);
      const result = openSession(detail);
      if (!result.ok) {
        setOpenError(result.reason);
      }
    },
    [openSession],
  );

  const tabBar = tabCount > 0 ? <SessionTabs onAddNew={clearActive} /> : null;

  if (activeSession) {
    return (
      <div className="flex flex-col gap-3">
        {tabBar}
        {openError && (
          <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">
            {openError}
          </div>
        )}
        <ChatSession session={activeSession} onBack={clearActive} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {tabBar}
      {openError && (
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">
          {openError}
        </div>
      )}
      <SessionList onOpenSession={handleOpenSession} />
    </div>
  );
}

// ============================================================================
// 会话列表
// ============================================================================

function SessionList({
  onOpenSession,
}: {
  onOpenSession: (session: { id: string; title: string; engineId: string; projectPath?: string; messages: import('../runtime/types').ChatMessage[] }) => void;
}) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [claudeRes, codexRes] = await Promise.all([
        listSessions('claude-code', 1, 20).catch(() => ({ items: [] as SessionMeta[], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
        listSessions('codex', 1, 20).catch(() => ({ items: [] as SessionMeta[], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
      ]);
      const merged = [
        ...claudeRes.items.map((s) => toSessionItem(s, 'claude-code')),
        ...codexRes.items.map((s) => toSessionItem(s, 'codex')),
      ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setSessions(merged.slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const openSession = async (item: SessionItem) => {
    setLoading(true);
    setError(null);
    try {
      const history = await getSessionHistory(item.id);
      onOpenSession({
        id: item.id,
        title: item.title,
        engineId: item.engineId,
        projectPath: item.projectPath,
        messages: history,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">续接桌面会话</h2>
          <p className="text-[10px] text-text-tertiary">查看并继续桌面端 AI 对话</p>
        </div>
        <button
          type="button"
          onClick={() => void loadSessions()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新"
        >
          <span className={clsx('inline-block', loading && 'animate-spin')}>⟳</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">{error}</div>
      )}

      {loading && sessions.length === 0 && (
        <div className="text-[11px] text-text-tertiary">加载中...</div>
      )}

      {!loading && sessions.length === 0 && !error && (
        <div className="text-[11px] text-text-tertiary">桌面端暂无会话</div>
      )}

      <div className="space-y-2">
        {sessions.map((session) => (
          <button
            key={`${session.engineId}-${session.id}`}
            type="button"
            onClick={() => void openSession(session)}
            className="w-full rounded-xl border border-border bg-background-elevated p-3 text-left"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-text-primary">{session.title}</div>
                <div className="mt-1 truncate text-[10px] text-text-tertiary">{session.projectPath || '自由会话'}</div>
              </div>
              <span className="shrink-0 rounded bg-background-surface px-1.5 py-0.5 text-[9px] text-text-tertiary">{session.engineId}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[9px] text-text-tertiary">
              <span>{session.messageCount} 条消息</span>
              <span>{formatTime(session.timestamp)}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// 会话 Tab 条
// ============================================================================

function SessionTabs({ onAddNew }: { onAddNew: () => void }) {
  const sessions = useDesktopSessionRuntime(selectTabSessions);
  const activeSessionId = useDesktopSessionRuntime((s) => s.activeSessionId);
  const setActiveSession = useDesktopSessionRuntime((s) => s.setActiveSession);
  const closeSession = useDesktopSessionRuntime((s) => s.closeSession);

  if (sessions.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-2" style={{ scrollbarWidth: 'none' }}>
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={clsx(
              'group relative flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] transition-colors cursor-pointer',
              active
                ? 'bg-primary text-white'
                : 'border border-border bg-background-surface text-text-secondary',
            )}
            onClick={() => setActiveSession(session.id)}
            role="button"
            tabIndex={0}
          >
            <span className={clsx(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              active && session.status === 'idle' ? 'bg-white/70' : statusDotClass(session.status),
            )} />
            <span className="max-w-[80px] truncate">{session.title || '无标题'}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeSession(session.id); }}
              className="ml-0.5 rounded-full p-0.5 hover:bg-white/20"
              aria-label="关闭会话"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddNew}
        className="flex shrink-0 items-center justify-center rounded-full border border-dashed border-border p-1.5 text-text-tertiary hover:text-text-primary"
        aria-label="添加会话"
      >
        +
      </button>
    </div>
  );
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-primary animate-pulse';
    case 'waiting': return 'bg-warning';
    case 'error': return 'bg-danger';
    default: return 'bg-text-tertiary/40';
  }
}

// ============================================================================
// 聊天会话视图（WS 流式渲染）
// ============================================================================

function ChatSession({ session, onBack }: { session: SessionRuntimeState; onBack: () => void }) {
  const setInput = useDesktopSessionRuntime((s) => s.setInput);
  const sendMessage = useDesktopSessionRuntime((s) => s.sendMessage);
  const interrupt = useDesktopSessionRuntime((s) => s.interrupt);
  const answerQuestion = useDesktopSessionRuntime((s) => s.answerQuestion);
  const respondPlan = useDesktopSessionRuntime((s) => s.respondPlan);
  const respondPermission = useDesktopSessionRuntime((s) => s.respondPermission);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, session.partial?.content]);

  const handleSend = () => {
    void sendMessage(session.id, session.input);
  };

  // 合并消息与流式 partial
  const displayMessages = session.partial
    ? session.messages.map((m) =>
        m.type === 'assistant' && m.isStreaming
          ? { ...m, content: session.partial!.content }
          : m,
      )
    : session.messages;

  return (
    <section className="flex min-h-[calc(100dvh-200px)] flex-col gap-3">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-border p-1.5 text-text-secondary"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold">{session.title}</h2>
          <p className="truncate text-[10px] text-text-tertiary">
            {session.engineId}
            {session.status !== 'idle' ? ` · ${statusLabel(session.status)}` : ''}
          </p>
        </div>
        {session.sending && (
          <button
            type="button"
            onClick={() => void interrupt(session.id)}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[10px] text-text-secondary"
            aria-label="停止生成"
          >
            █ 停止
          </button>
        )}
      </div>

      {/* 错误 */}
      {session.error && (
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">
          {session.error}
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 space-y-2 overflow-y-auto pb-2">
        {displayMessages.map((msg) => (
          <div
            key={msg.id}
            className={clsx(
              'rounded-xl px-3 py-2 text-[11px] leading-6',
              msg.type === 'user'
                ? 'bg-primary/15 text-text-primary ml-6'
                : 'bg-background-surface text-text-primary mr-6',
            )}
          >
            {msg.content}
            {msg.isStreaming && <span className="ml-0.5 animate-pulse">▊</span>}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Pending 卡片 */}
      {session.pendingCard && (
        <div className="sticky bottom-[72px] z-10">
          <PendingCardView
            card={session.pendingCard}
            onAnswerQuestion={(selected, declined) => void answerQuestion(session.id, selected, declined)}
            onApprovePlan={(approve) => void respondPlan(session.id, approve)}
            onPermissionResponse={(approve) => void respondPermission(session.id, approve)}
          />
        </div>
      )}

      {/* 输入框 */}
      <div className="sticky bottom-0 rounded-xl border border-border bg-background-elevated p-2">
        <textarea
          value={session.input}
          onChange={(e) => setInput(session.id, e.target.value)}
          placeholder="输入消息续接会话"
          rows={2}
          className="w-full resize-none bg-transparent px-1 py-1 text-[11px] outline-none placeholder:text-text-tertiary"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSend}
            disabled={!session.input.trim() || session.sending}
            className="rounded-lg bg-primary px-3 py-1.5 text-[11px] text-background-base disabled:opacity-40"
          >
            {session.sending ? '发送中' : '发送'}
          </button>
        </div>
      </div>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running': return '运行中';
    case 'waiting': return '待确认';
    case 'error': return '错误';
    default: return '';
  }
}

// ============================================================================
// Pending 卡片渲染
// ============================================================================

function PendingCardView({
  card,
  onAnswerQuestion,
  onApprovePlan,
  onPermissionResponse,
}: {
  card: PendingCard;
  onAnswerQuestion: (selected: string[], declined: boolean) => void;
  onApprovePlan: (approve: boolean) => void;
  onPermissionResponse: (approve: boolean) => void;
}) {
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);

  const toggleOption = (value: string) => {
    setSelectedOptions((prev) => {
      if (card.multiSelect) {
        return prev.includes(value) ? prev.filter((o) => o !== value) : [...prev, value];
      }
      return prev.includes(value) ? [] : [value];
    });
  };

  // Question 卡片
  if (card.type === 'question') {
    const questions = card.questions || [
      { question: card.header || '是否继续？', options: card.options || [] },
    ];
    return (
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-primary">
          <span>📋</span>
          <span>需要你确认</span>
        </div>
        <div className="mt-2 space-y-3">
          {questions.map((q, i) => (
            <div key={i} className="space-y-2">
              <div className="text-[11px] text-text-secondary">{q.question}</div>
              {q.options && q.options.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {(q.options).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleOption(opt.value)}
                      className={clsx(
                        'rounded-lg px-2.5 py-1.5 text-[10px] border',
                        selectedOptions.includes(opt.value)
                          ? 'bg-primary text-white border-primary'
                          : 'border-border text-text-secondary bg-background-elevated',
                      )}
                    >
                      {opt.label || opt.value}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAnswerQuestion(selectedOptions, false)}
              disabled={selectedOptions.length === 0}
              className="flex-1 rounded-lg bg-primary px-3 py-2 text-[11px] text-background-base disabled:opacity-40"
            >
              确认
            </button>
            <button
              type="button"
              onClick={() => onAnswerQuestion([], true)}
              className="rounded-lg border border-border bg-background-elevated px-3 py-2 text-[11px] text-text-secondary"
            >
              跳过
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Plan 审批卡片
  if (card.type === 'plan_approval_request') {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-warning">
          <span>📋</span>
          <span>计划审批</span>
        </div>
        {card.message && <div className="mt-2 text-[10px] text-text-secondary">{card.message}</div>}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onApprovePlan(true)}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-[11px] text-background-base"
          >
            批准
          </button>
          <button
            type="button"
            onClick={() => onApprovePlan(false)}
            className="rounded-lg border border-border bg-background-elevated px-3 py-2 text-[11px] text-text-secondary"
          >
            拒绝
          </button>
        </div>
      </div>
    );
  }

  // 权限确认卡片
  if (card.type === 'permission_request') {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-danger">
          <span>🔒</span>
          <span>权限确认</span>
        </div>
        <div className="mt-2 text-[10px] text-text-secondary">
          {card.toolName && <div>工具: {card.toolName}</div>}
          {card.extra && <div className="mt-1 line-clamp-2">{card.extra}</div>}
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onPermissionResponse(true)}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-[11px] text-background-base"
          >
            允许
          </button>
          <button
            type="button"
            onClick={() => onPermissionResponse(false)}
            className="rounded-lg border border-border bg-background-elevated px-3 py-2 text-[11px] text-text-secondary"
          >
            拒绝
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ============================================================================
// 工具函数
// ============================================================================

function toSessionItem(session: SessionMeta, engineId: string): SessionItem {
  return {
    id: session.sessionId,
    title: session.summary || '无标题会话',
    engineId,
    timestamp: session.updatedAt || session.createdAt || new Date().toISOString(),
    messageCount: session.messageCount || 0,
    projectPath: session.projectPath,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}