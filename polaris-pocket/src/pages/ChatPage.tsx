/**
 * Pocket Chat — 独立 AI 对话页
 *
 * 核心交互：
 * - 用户输入文本 → 发送 → 流式显示 AI 回复
 * - 支持多会话切换
 * - 错误清晰反馈，不再静默吞掉
 * - 未配置 API 时有明显的引导提示
 */
import { useState, useRef, useEffect, useCallback } from "react";

// ---- 存储 ----
const KEYS = {
  sessions: "pocket-sessions",
  msgs: (id: string) => `pocket-msgs-${id}`,
};
function load<T>(k: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(k)!) ?? fallback; } catch { return fallback; }
}
function save(k: string, v: unknown) { localStorage.setItem(k, JSON.stringify(v)); }

interface Session {
  id: string; title: string; updated: number; last: string;
}
interface Msg {
  id: string; role: "user" | "assistant" | "error"; content: string; ts: number;
}
interface ChatConfig {
  apiBase: string; apiKey: string; model: string;
}

// 从 localStorage 读取配置
function readConfig(): ChatConfig {
  const defaultCfg: ChatConfig = { apiBase: "", apiKey: "", model: "gpt-4o" };
  try {
    const raw = localStorage.getItem("pocket-config");
    if (!raw) return defaultCfg;
    const parsed = JSON.parse(raw) as Partial<ChatConfig>;
    return { ...defaultCfg, ...parsed };
  } catch {
    return defaultCfg;
  }
}

export function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>(() => load(KEYS.sessions, []));
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [stream, setStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [configRead, setConfigRead] = useState<ChatConfig>(() => readConfig());
  const abort = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const hasConfig = configRead.apiKey !== "";

  // 每次渲染时重新读取配置（从 localStorage）
  useEffect(() => {
    setConfigRead(readConfig());
  }, []);

  // 切换会话时加载历史消息
  useEffect(() => {
    if (active) {
      const cached = load(KEYS.msgs(active), []);
      setMsgs(cached);
    } else {
      setMsgs([]);
    }
  }, [active]);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, stream, error]);

  // 清除错误
  const clearError = useCallback(() => setError(null), []);

  const newSession = () => {
    clearError();
    const s: Session = { id: Date.now().toString(), title: "新对话", updated: Date.now(), last: "" };
    setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
    setActive(s.id);
    setMsgs([]);
  };

  const sendMessage = async () => {
    clearError();
    const text = input.trim();
    if (!text) return;

    // 未配置 API Key
    if (!hasConfig) {
      setError("请先在「设置」中配置 AI API Key 后再发送消息");
      return;
    }

    // 先检查配置是否有变化（可能刚在设置页保存）
    const cfg = readConfig();
    if (!cfg.apiKey) {
      setConfigRead(cfg);
      setError("请先在「设置」中配置 AI API Key 后再发送消息");
      return;
    }

    let sid = active;
    if (!sid) {
      const s: Session = { id: Date.now().toString(), title: text.slice(0, 40), updated: Date.now(), last: "" };
      sid = s.id;
      setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
      setActive(sid);
    }

    const userMsg: Msg = { id: `${Date.now()}-u`, role: "user", content: text, ts: Date.now() };
    const updated = [...msgs, userMsg];
    setMsgs(updated);
    if (sid) save(KEYS.msgs(sid), updated);
    setInput("");
    setStreaming(true);
    setStream("");

    const ctrl = new AbortController();
    abort.current = ctrl;

    try {
      const apiBase = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model || "gpt-4o",
          messages: updated.map(m => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let msg = `请求失败 (${res.status})`;
        // 尝试解析错误详情
        try {
          const body = JSON.parse(errText);
          msg = body.error?.message || body.message || body.detail || msg;
        } catch {
          if (errText) msg += `: ${errText.slice(0, 100)}`;
        }
        throw new Error(msg);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n").filter(l => l.startsWith("data: "));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              if (full) {
                setMsgs(prev => [...prev, {
                  id: `${Date.now()}-a`,
                  role: "assistant",
                  content: full,
                  ts: Date.now(),
                }]);
              }
              break;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                setStream(full);
              }
            } catch {
              // 跳过非 JSON 行
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (full) {
        const am: Msg = { id: `${Date.now()}-a`, role: "assistant", content: full, ts: Date.now() };
        const final = [...updated, am];
        setMsgs(final);
        if (sid) save(KEYS.msgs(sid), final);
        if (sid) {
          setSessions(p => {
            const n = p.map(s => s.id === sid
              ? { ...s, updated: Date.now(), last: full.slice(0, 80) }
              : s
            );
            save(KEYS.sessions, n);
            return n;
          });
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        setStreaming(false);
        setStream("");
        return;
      }
      const msg = (e as Error).message || "发送失败，请检查 API 配置和网络";
      setError(msg);
      // 保存错误消息到聊天记录（可选，方便调试）
    } finally {
      setStreaming(false);
      setStream("");
    }
  };

  const stopStreaming = () => {
    abort.current?.abort();
    setStreaming(false);
    setStream("");
  };

  const selectSession = (id: string) => {
    clearError();
    setActive(id);
    setMsgs(load(KEYS.msgs(id), []));
  };

  const deleteSession = (id: string) => {
    clearError();
    setSessions(p => {
      const n = p.filter(s => s.id !== id);
      save(KEYS.sessions, n);
      return n;
    });
    localStorage.removeItem(KEYS.msgs(id));
    if (active === id) {
      setActive(null);
      setMsgs([]);
    }
  };

  const send = () => sendMessage();

  return (
    <div className="flex h-full flex-col">
      {/* 未配置 API 引导 */}
      {!hasConfig && (
        <div className="mb-2 rounded-xl border border-primary/40 bg-primary/8 px-4 py-3">
          <p className="text-xs font-semibold text-primary">
            ⚠ 请先配置 AI
          </p>
          <p className="mt-1 text-[10px] leading-5 text-text-secondary">
            进入「设置」→ 填入 API 地址和 Key 后即可开始对话
          </p>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/8 px-3 py-2">
          <span className="shrink-0 text-xs text-danger">✕</span>
          <span className="min-w-0 flex-1 text-[11px] leading-5 text-danger">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 text-[10px] text-text-tertiary hover:text-text-primary"
          >
            关闭
          </button>
        </div>
      )}

      {/* 会话列表 */}
      <div className="mb-2 space-y-1.5 rounded-xl border border-border bg-background-elevated p-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text-secondary">对话</span>
          <button type="button" onClick={newSession} className="rounded bg-background-surface px-2 py-1 text-xs text-text-secondary">+ 新对话</button>
        </div>
        {sessions.length === 0 && <p className="text-[10px] text-text-tertiary">暂无对话</p>}
        {sessions.slice(0, 15).map(s => (
          <div key={s.id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs" style={active === s.id ? { background: "rgba(203,166,247,0.12)", color: "#cba6f7" } : undefined}>
            <button className="min-w-0 flex-1 text-left truncate" onClick={() => selectSession(s.id)}>
              <span className="block truncate">{s.title}</span>
              <span className="block truncate text-[9px] text-text-tertiary">{s.last}</span>
            </button>
            <button className="text-text-tertiary hover:text-danger" onClick={() => deleteSession(s.id)}>×</button>
          </div>
        ))}
      </div>

      {/* 消息流 */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {msgs.length === 0 && !streaming && (
          <p className="py-8 text-center text-[11px] text-text-tertiary">
            {hasConfig ? "开始对话吧，输入消息后按发送" : "配置好 API 后开始对话"}
          </p>
        )}
        {msgs.map(m => (
          <div key={m.id} className={`rounded-xl px-3 py-2 text-sm leading-6 ${
            m.role === "user" ? "ml-6 bg-primary/10"
              : m.role === "error" ? "mr-6 border border-danger/40 bg-danger/8"
              : "mr-6 border border-border bg-background-surface"
          }`}>
            <span className="mb-0.5 block text-[9px] text-text-tertiary">
              {m.role === "user" ? "你" : m.role === "error" ? "错误" : "AI"}
            </span>
            <span className="whitespace-pre-wrap break-words">{m.content}</span>
          </div>
        ))}
        {streaming && stream && (
          <div className="mr-6 rounded-xl border border-border bg-background-surface px-3 py-2 text-sm whitespace-pre-wrap break-words">
            {stream}
            <span className="inline-block ml-1 text-text-tertiary">▌</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="mt-2 flex gap-1.5">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="输入消息..."
          className="flex-1 resize-none rounded-lg border border-border bg-background-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary disabled:opacity-50"
          disabled={streaming || !hasConfig}
        />
        <button
          onClick={streaming ? stopStreaming : send}
          disabled={!input.trim()}
          className={`rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${
            streaming ? "bg-danger/20 text-danger" : "bg-primary text-background-base"
          }`}
        >
          {streaming ? "停" : "发"}
        </button>
      </div>
    </div>
  );
}
