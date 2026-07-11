/**
 * MobileSessions — 移动端会话列表 + 多会话聊天
 *
 * Phase 1：接入 MobileSessionRuntime
 * - 全局 chat-event 路由，切 Tab 不丢后台事件
 * - Tab 状态指示由 Runtime status 驱动
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  Send,
  ArrowLeft,
  RefreshCw,
  Check,
  X,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Square,
} from 'lucide-react';
import { invoke } from '@/services/transport';
import {
  getClaudeCodeHistoryService,
  type PagedResult,
  type SessionMetaResponse,
} from '@/services/claudeCodeHistoryService';
import { getCodexHistoryService } from '@/services/codexHistoryService';
import type { ChatMessage, EngineId } from '@/types';
import { renderChatMessage } from '@/components/Chat/renderChatMessage';
import {
  useMobileSessionRuntime,
  selectActiveSession,
  selectTabSessions,
  setMobileHistoryRefresher,
} from './runtime/mobileSessionRuntime';
import type { PendingCard, SessionRuntimeState } from './runtime/types';
import { MobileSessionTabs } from './components/MobileSessionTabs';

export interface MobileSessionItem {
  id: string;
  title: string;
  engineId: EngineId;
  timestamp: string;
  messageCount: number;
  projectPath?: string;
}

export interface MobileSessionDetail extends MobileSessionItem {
  messages: ChatMessage[];
}

export function MobileSessions() {
  const activeSession = useMobileSessionRuntime(selectActiveSession);
  const tabSessions = useMobileSessionRuntime(selectTabSessions);
  const openSession = useMobileSessionRuntime((s) => s.openSession);
  const clearActive = useMobileSessionRuntime((s) => s.clearActive);
  const ensureInitialized = useMobileSessionRuntime((s) => s.ensureInitialized);
  const [openError, setOpenError] = useState<string | null>(null);

  // 全局 listen + 历史刷新器（只挂一次）
  useEffect(() => {
    void ensureInitialized();

    setMobileHistoryRefresher(async (session) => {
      try {
        if (session.engineId === 'codex') {
          const raw = await getCodexHistoryService().getSessionHistory(session.id);
          if (raw.length === 0) return null;
          return getCodexHistoryService().convertToChatMessages(raw);
        }
        const raw = await getClaudeCodeHistoryService().getSessionHistory(session.id);
        if (raw.length === 0) return null;
        return getClaudeCodeHistoryService().convertToChatMessages(raw);
      } catch {
        return null;
      }
    });

    return () => {
      setMobileHistoryRefresher(null);
    };
  }, [ensureInitialized]);

  const handleOpenSession = useCallback(
    (detail: MobileSessionDetail) => {
      setOpenError(null);
      const result = openSession({
        id: detail.id,
        title: detail.title,
        engineId: detail.engineId,
        projectPath: detail.projectPath,
        messages: detail.messages,
      });
      if (!result.ok) {
        setOpenError(result.reason);
      }
    },
    [openSession],
  );

  const tabBar =
    tabSessions.length > 0 ? (
      <MobileSessionTabs onAddNew={clearActive} />
    ) : null;

  if (activeSession) {
    return (
      <div className="flex flex-col gap-3">
        {tabBar}
        {openError && (
          <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
            {openError}
          </div>
        )}
        <MobileChatSession session={activeSession} onBack={clearActive} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {tabBar}
      {openError && (
        <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
          {openError}
        </div>
      )}
      <MobileSessionList onOpenSession={handleOpenSession} />
    </div>
  );
}

function MobileSessionList({
  onOpenSession,
}: {
  onOpenSession: (session: MobileSessionDetail) => void;
}) {
  const [sessions, setSessions] = useState<MobileSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtimeSessions = useMobileSessionRuntime((s) => s.sessions);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [claudeResult, codexResult] = await Promise.all([
        invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
          engineId: 'claude-code',
          page: 1,
          pageSize: 20,
        }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
        invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
          engineId: 'codex',
          page: 1,
          pageSize: 20,
        }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
      ]);

      const merged = [
        ...claudeResult.items.map((session) => toSessionItem(session, 'claude-code' as const)),
        ...codexResult.items.map((session) => toSessionItem(session, 'codex' as const)),
      ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      setSessions(merged.slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const openSession = async (item: MobileSessionItem) => {
    setLoading(true);
    setError(null);
    try {
      const messages =
        item.engineId === 'codex'
          ? getCodexHistoryService().convertToChatMessages(
              await getCodexHistoryService().getSessionHistory(item.id),
            )
          : getClaudeCodeHistoryService().convertToChatMessages(
              await getClaudeCodeHistoryService().getSessionHistory(item.id),
            );
      onOpenSession({ ...item, messages });
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
          <h2 className="text-base font-semibold">最近会话</h2>
          <p className="text-xs text-text-tertiary">查看并续接远程工程会话 · 支持多 Tab 并行</p>
        </div>
        <button
          type="button"
          onClick={() => void loadSessions()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新会话"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {loading && sessions.length === 0 && (
        <div className="text-sm text-text-tertiary">正在加载会话...</div>
      )}
      {!loading && sessions.length === 0 && !error && (
        <div className="text-sm text-text-tertiary">暂无会话</div>
      )}

      <div className="space-y-2">
        {sessions.map((session) => {
          const runtime = runtimeSessions[session.id];
          return (
            <button
              key={`${session.engineId}-${session.id}`}
              type="button"
              onClick={() => void openSession(session)}
              className="w-full rounded-2xl border border-border bg-background-elevated p-4 text-left shadow-soft"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {session.title}
                    </div>
                    {runtime && runtime.status !== 'idle' && (
                      <span
                        className={clsx(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[10px]',
                          runtime.status === 'running' && 'bg-primary/15 text-primary',
                          runtime.status === 'waiting' && 'bg-warning/15 text-warning',
                          runtime.status === 'error' && 'bg-danger/15 text-danger',
                        )}
                      >
                        {runtime.status === 'running'
                          ? '运行中'
                          : runtime.status === 'waiting'
                            ? '待确认'
                            : '错误'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-text-tertiary">
                    {session.projectPath || '自由会话'}
                  </div>
                </div>
                <span className="rounded-full bg-background-surface px-2 py-1 text-[10px] text-text-tertiary">
                  {session.engineId}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-text-tertiary">
                <span>{session.messageCount} 条消息</span>
                <span>{formatTime(session.timestamp)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MobileChatSession({
  session,
  onBack,
}: {
  session: SessionRuntimeState;
  onBack: () => void;
}) {
  const setInput = useMobileSessionRuntime((s) => s.setInput);
  const sendMessage = useMobileSessionRuntime((s) => s.sendMessage);
  const interrupt = useMobileSessionRuntime((s) => s.interrupt);
  const answerQuestion = useMobileSessionRuntime((s) => s.answerQuestion);
  const respondPlan = useMobileSessionRuntime((s) => s.respondPlan);
  const respondPermission = useMobileSessionRuntime((s) => s.respondPermission);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, session.partial?.content]);

  const handleSend = () => {
    void sendMessage(session.id, session.input);
  };

  return (
    <section className="flex min-h-[calc(100dvh-180px)] flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-border p-2 text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{session.title}</h2>
          <p className="truncate text-xs text-text-tertiary">
            {session.engineId} · {session.projectPath || '自由会话'}
            {session.status !== 'idle' ? ` · ${statusLabel(session.status)}` : ''}
          </p>
        </div>
        {session.sending && (
          <button
            type="button"
            onClick={() => void interrupt(session.id)}
            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1.5 text-xs text-text-secondary"
            aria-label="停止生成"
          >
            <Square size={12} />
            停止
          </button>
        )}
      </div>

      {session.error && (
        <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
          {session.error}
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto pb-2">
        {session.messages.map((message, index) => (
          <div key={message.id}>{renderChatMessage(message, index, undefined, undefined)}</div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {session.pendingCard && (
        <div className="sticky bottom-[72px] z-10">
          <PendingCardCard
            card={session.pendingCard}
            onAnswerQuestion={(selected, declined) =>
              void answerQuestion(session.id, selected, declined)
            }
            onApprovePlan={(approve) => void respondPlan(session.id, approve)}
            onPermissionResponse={(approve) => void respondPermission(session.id, approve)}
          />
        </div>
      )}

      <div className="sticky bottom-[72px] rounded-2xl border border-border bg-background-elevated p-2 shadow-xl">
        <textarea
          value={session.input}
          onChange={(event) => setInput(session.id, event.target.value)}
          placeholder="输入消息续接会话"
          rows={3}
          className="w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-text-tertiary"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSend}
            disabled={!session.input.trim() || session.sending}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <Send size={15} />
            {session.sending ? '发送中' : '发送'}
          </button>
        </div>
      </div>
    </section>
  );
}

function statusLabel(status: SessionRuntimeState['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'waiting':
      return '待确认';
    case 'error':
      return '错误';
    default:
      return '';
  }
}

function PendingCardCard({
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
  const [expanded, setExpanded] = useState(true);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);

  const toggleOption = (value: string) => {
    setSelectedOptions((prev) => {
      if (card.multiSelect) {
        return prev.includes(value) ? prev.filter((o) => o !== value) : [...prev, value];
      }
      return prev.includes(value) ? [] : [value];
    });
  };

  if (card.type === 'question') {
    const questions = card.questions || [
      { question: card.header || '是否继续？', options: card.options || [] },
    ];
    return (
      <div className="rounded-2xl border border-primary/40 bg-primary-faint p-3 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <AlertCircle size={15} />
            <span>需要你确认</span>
          </div>
          <button type="button" onClick={() => setExpanded(!expanded)} className="text-text-tertiary">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {expanded && (
          <div className="mt-3 space-y-4">
            {questions.map((q, i) => (
              <div key={i} className="space-y-2">
                <div className="text-sm text-text-secondary">{q.question}</div>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleOption(opt.value)}
                      className={clsx(
                        'rounded-xl px-3 py-1.5 text-xs border',
                        selectedOptions.includes(opt.value)
                          ? 'bg-primary text-white border-primary'
                          : 'border-border text-text-secondary bg-background-elevated',
                      )}
                    >
                      {opt.label || opt.value}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onAnswerQuestion(selectedOptions, false)}
                disabled={selectedOptions.length === 0}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm text-white disabled:opacity-50"
              >
                <Check size={15} />
                确认
              </button>
              <button
                type="button"
                onClick={() => onAnswerQuestion([], true)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background-elevated px-3 py-2.5 text-sm text-text-secondary"
              >
                <X size={15} />
                跳过
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (card.type === 'plan_approval_request') {
    return (
      <div className="rounded-2xl border border-warning/40 bg-warning-faint p-3 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-medium text-warning">
          <AlertCircle size={15} />
          <span>计划审批</span>
        </div>
        {card.message && <div className="mt-2 text-xs text-text-secondary">{card.message}</div>}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onApprovePlan(true)}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm text-white"
          >
            <Check size={15} />
            批准
          </button>
          <button
            type="button"
            onClick={() => onApprovePlan(false)}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background-elevated px-3 py-2.5 text-sm text-text-secondary"
          >
            <X size={15} />
            拒绝
          </button>
        </div>
      </div>
    );
  }

  if (card.type === 'permission_request') {
    return (
      <div className="rounded-2xl border border-danger/40 bg-danger-faint p-3 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-medium text-danger">
          <AlertCircle size={15} />
          <span>权限确认</span>
        </div>
        <div className="mt-2 text-xs text-text-secondary">
          {card.toolName && <div>工具: {card.toolName}</div>}
          {card.extra && <div className="mt-1 line-clamp-2">{card.extra}</div>}
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onPermissionResponse(true)}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm text-white"
          >
            <Check size={15} />
            允许
          </button>
          <button
            type="button"
            onClick={() => onPermissionResponse(false)}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background-elevated px-3 py-2.5 text-sm text-text-secondary"
          >
            <X size={15} />
            拒绝
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function toSessionItem(session: SessionMetaResponse, engineId: EngineId): MobileSessionItem {
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
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
