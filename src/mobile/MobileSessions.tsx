import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Send, ArrowLeft, RefreshCw, Check, X, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { invoke, listen } from '@/services/transport';
import { getClaudeCodeHistoryService, type PagedResult, type SessionMetaResponse } from '@/services/claudeCodeHistoryService';
import { getCodexHistoryService } from '@/services/codexHistoryService';
import type { ChatMessage, EngineId } from '@/types';
import type { AIEvent } from '@/ai-runtime/event';
import { renderChatMessage } from '@/components/Chat/renderChatMessage';
import { useMobileSession, dispatchAIEvent, type PendingCard } from './hooks/useMobileSession';
import { useMobileMultiSessionStore } from './stores/mobileMultiSessionStore';
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
  const sessions = useMobileMultiSessionStore(s => s.sessions);
  const activeSessionId = useMobileMultiSessionStore(s => s.activeSessionId);
  const addSession = useMobileMultiSessionStore(s => s.addSession);
  const clearActive = useMobileMultiSessionStore(s => s.clearActive);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  // Tab 条 + 按钮在所有视图都可用（有钉住会话时）
  const tabBar = sessions.length > 0 ? (
    <MobileSessionTabs onAddNew={clearActive /* + 按钮回到列表添加新会话 */} />
  ) : null;

  // 有激活会话 → 渲染聊天页
  if (activeSession) {
    return (
      <div className="flex flex-col gap-3">
        {tabBar}
        <MobileChatSession session={activeSession} onBack={clearActive} />
      </div>
    );
  }

  // 无激活会话 → 列表
  return (
    <div className="flex flex-col gap-3">
      {tabBar}
      <MobileSessionList onOpenSession={addSession} />
    </div>
  );
}

function MobileSessionList({ onOpenSession }: { onOpenSession: (session: MobileSessionDetail) => void }) {
  const [sessions, setSessions] = useState<MobileSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        ...claudeResult.items.map(session => toSessionItem(session, 'claude-code' as const)),
        ...codexResult.items.map(session => toSessionItem(session, 'codex' as const)),
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
      const messages = item.engineId === 'codex'
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
          <p className="text-xs text-text-tertiary">查看并续接远程工程会话</p>
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

      {error && <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">{error}</div>}
      {loading && sessions.length === 0 && <div className="text-sm text-text-tertiary">正在加载会话...</div>}
      {!loading && sessions.length === 0 && !error && <div className="text-sm text-text-tertiary">暂无会话</div>}

      <div className="space-y-2">
        {sessions.map(session => (
          <button
            key={`${session.engineId}-${session.id}`}
            type="button"
            onClick={() => void openSession(session)}
            className="w-full rounded-2xl border border-border bg-background-elevated p-4 text-left shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">{session.title}</div>
                <div className="mt-1 truncate text-xs text-text-tertiary">{session.projectPath || '自由会话'}</div>
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
        ))}
      </div>
    </section>
  );
}

function MobileChatSession({ session, onBack }: { session: MobileSessionDetail; onBack: () => void }) {
  const {
    messages,
    input,
    sending,
    error,
    pendingCard,
    getPartial,
    setPartial,
    setMessages,
    setInput,
    setSending,
    setError,
    setPendingCard,
    persistToCache,
  } = useMobileSession(session.id, session.messages);
  const unlistenRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /** 发送后重新拉取消息列表，保证完整性 */
  const refreshHistory = useCallback(async () => {
    try {
      if (session.engineId === 'codex') {
        const raw = await getCodexHistoryService().getSessionHistory(session.id);
        if (raw.length > 0) {
          setMessages(getCodexHistoryService().convertToChatMessages(raw));
        }
      } else {
        const raw = await getClaudeCodeHistoryService().getSessionHistory(session.id);
        if (raw.length > 0) {
          setMessages(getClaudeCodeHistoryService().convertToChatMessages(raw));
        }
      }
    } catch {
      // 静默失败，用当前缓冲消息
    }
  }, [session.engineId, session.id, setMessages]);

  useEffect(() => {
    const setup = async () => {
      try {
        const unlisten = await listen<{ contextId?: string; payload: AIEvent }>('chat-event', (event) => {
          // 只处理本会话的事件
          // 发送端（send / handlePermissionResponse）传 contextId: `mobile-${session.id}`，
          // 后端原样透传，因此监听端必须用相同前缀，否则所有自己的事件都被过滤丢弃 → 消息不回显。
          const expectedContextId = `mobile-${session.id}`;
          if (event.contextId && event.contextId !== expectedContextId) return;

          const aiEvent = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          if (!aiEvent || typeof aiEvent.type !== 'string') return;

          dispatchAIEvent(aiEvent, {
            sessionId: session.id,
            getPartial,
            setPartial,
            setMessages,
            setSending,
            setError,
            setPendingCard,
            onResult: () => void refreshHistory(),
          });
        });
        unlistenRef.current = unlisten;
      } catch {
        // WS 不可用时静默
      }
    };

    void setup();
    return () => {
      // 卸载前把响应式状态写回缓存，保证 Tab 切换后能恢复
      persistToCache();
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
    // getPartial/setPartial 等是稳定回调；显式依赖 session.id 避免漏更新
  }, [session.id, getPartial, setPartial, setMessages, setSending, setError, setPendingCard, persistToCache, refreshHistory]);

  /** 处理待确认交互的回复 */
  const handleAnswerQuestion = useCallback(async (selected: string[], declined: boolean) => {
    if (!pendingCard?.questionId) return;
    try {
      if (declined) {
        await invoke('answer_question', { sessionId: session.id, callId: pendingCard.questionId, answer: { declined: true } });
      } else {
        await invoke('answer_question', {
          sessionId: session.id,
          callId: pendingCard.questionId,
          answer: { selected },
        });
      }
      setPendingCard(null);
    } catch {
      // 静默，下次 result/error 会清理状态
    }
  }, [pendingCard?.questionId, session.id]);

  const handleApprovePlan = useCallback(async (approve: boolean) => {
    if (!pendingCard?.planId) return;
    try {
      if (approve) {
        await invoke('approve_plan', { sessionId: session.id, planId: pendingCard.planId });
      } else {
        await invoke('reject_plan', { sessionId: session.id, planId: pendingCard.planId });
      }
      setPendingCard(null);
    } catch {
      setSending(false);
    }
  }, [pendingCard?.planId, session.id]);

  const handlePermissionResponse = useCallback(async (approve: boolean) => {
    // 移动端没有 ConversationStore，权限决策通过向会话发送用户消息完成。
    // 桌面端走 resolvePermissionRequest + addSessionAllowedTools 路径；
    // 移动端简化为发送"批准"或"拒绝"消息，由 AI 自行理解用户意图。
    setPendingCard(null);
    const userMessage: ChatMessage = {
      id: `mobile-perm-${Date.now()}`,
      type: 'user',
      content: approve ? '批准' : '拒绝',
      timestamp: new Date().toISOString(),
    };
    setMessages(current => [...current, userMessage]);
    try {
      await invoke('continue_chat', {
        sessionId: session.id,
        message: approve ? '批准' : '拒绝',
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: `mobile-${session.id}`,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [session.engineId, session.id, session.projectPath]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMessage: ChatMessage = {
      id: `mobile-user-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages(current => [...current, userMessage]);
    setInput('');
    setSending(true);
    setError(null);
    try {
      await invoke('continue_chat', {
        sessionId: session.id,
        message: text,
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: `mobile-${session.id}`,
        },
      });
      // 不用等 WS 事件主动重置 sending；
      // result / session_end / error 里会清 sending
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  };

  return (
    <section className="flex min-h-[calc(100dvh-180px)] flex-col gap-3">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-full border border-border p-2 text-text-secondary">
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{session.title}</h2>
          <p className="truncate text-xs text-text-tertiary">{session.engineId} · {session.projectPath || '自由会话'}</p>
        </div>
      </div>

      {error && <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">{error}</div>}

      <div className="flex-1 space-y-3 overflow-y-auto pb-2">
        {messages.map((message, index) => (
          <div key={message.id}>
            {renderChatMessage(message, index, undefined, undefined)}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 待处理交互卡片 */}
      {pendingCard && (
        <div className="sticky bottom-[72px] z-10">
          <PendingCardCard
            card={pendingCard}
            onAnswerQuestion={handleAnswerQuestion}
            onApprovePlan={handleApprovePlan}
            onPermissionResponse={handlePermissionResponse}
          />
        </div>
      )}

      <div className="sticky bottom-[72px] rounded-2xl border border-border bg-background-elevated p-2 shadow-xl">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="输入消息续接会话"
          rows={3}
          className="w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-text-tertiary"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || sending}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <Send size={15} />
            {sending ? '发送中' : '发送'}
          </button>
        </div>
      </div>
    </section>
  );
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
    setSelectedOptions(prev => {
      if (card.multiSelect) {
        return prev.includes(value) ? prev.filter(o => o !== value) : [...prev, value];
      }
      return prev.includes(value) ? [] : [value];
    });
  };

  // Question card
  if (card.type === 'question') {
    const questions = card.questions || [{ question: card.header || '是否继续？', options: card.options || [] }];
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
                  {q.options.map(opt => (
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

  // Plan approval card
  if (card.type === 'plan_approval_request') {
    return (
      <div className="rounded-2xl border border-warning/40 bg-warning-faint p-3 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-medium text-warning">
          <AlertCircle size={15} />
          <span>计划审批</span>
        </div>
        {card.message && (
          <div className="mt-2 text-xs text-text-secondary">{card.message}</div>
        )}
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

  // Permission request card
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
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
