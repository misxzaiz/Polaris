/**
 * Pocket Chat — 独立 AI 对话页
 * 直接调用 OpenAI 兼容 API，不走桌面中继。
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
  id: string; role: "user" | "assistant"; content: string; ts: number;
}

export function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>(() => load(KEYS.sessions, []));
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [stream, setStream] = useState("");
  const abort = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const cfg = load<{ apiBase: string; apiKey: string; model: string }>(
    "pocket-config", { apiBase: "", apiKey: "", model: "gpt-4o" }
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, stream]);

  useEffect(() => {
    if (active) setMsgs(load(KEYS.msgs(active), []));
    else setMsgs([]);
  }, [active]);

  const newSession = () => {
    const s: Session = { id: Date.now().toString(), title: "新对话", updated: Date.now(), last: "" };
    setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
    setActive(s.id); setMsgs([]);
  };

  const _sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming || !cfg.apiKey) return;
    let sid = active;
    if (!sid) {
      const s: Session = { id: Date.now().toString(), title: text.slice(0, 30), updated: Date.now(), last: "" };
      sid = s.id;
      setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
      setActive(sid); setMsgs([]);
    }
    const userMsg: Msg = { id: `${Date.now()}-u`, role: "user", content: text, ts: Date.now() };
    const updated = [...msgs, userMsg];
    setMsgs(updated);
    if (sid) save(KEYS.msgs(sid), updated);
    setInput(""); setStreaming(true); setStream("");

    const ctrl = new AbortController(); abort.current = ctrl;

    try {
      const res = await fetch((cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model || "gpt-4o", messages: updated.map(m => ({ role: m.role, content: m.content })), stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder(); let full = "";
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          for (const line of dec.decode(value, { stream: true }).split("\n").filter(l => l.startsWith("data: "))) {
            if (line.slice(6) === "[DONE]") { full && setMsgs(p => [...p, { id: `${Date.now()}-a`, role: "assistant", content: full, ts: Date.now() }]); break; }
            try { const p = JSON.parse(line.slice(6)); const d = p.choices?.[0]?.delta?.content; if (d) { full += d; setStream(full); } } catch {}
          }
        }
      } finally { reader.releaseLock(); }
      if (full) {
        const am: Msg = { id: `${Date.now()}-a`, role: "assistant", content: full, ts: Date.now() };
        const final = [...updated, am];
        setMsgs(final);
        if (sid) save(KEYS.msgs(sid), final);
        if (sid) setSessions(p => {
          const n = p.map(s => s.id === sid ? { ...s, updated: Date.now(), last: full.slice(0, 80) } : s);
          save(KEYS.sessions, n); return n;
        });
      }
    } catch (e: any) {
      if (e.name === "AbortError") { /* cancelled */ }
    } finally { setStreaming(false); setStream(""); }
  };

  const handleSend = () => { _sendMessage(); };

  const stop = () => { abort.current?.abort(); setStreaming(false); setStream(""); };

  const selectSession = (id: string) => { setActive(id); setMsgs(load(KEYS.msgs(id), [])); };
  const deleteSession = (id: string) => {
    setSessions(p => {
      const n = p.filter(s => s.id !== id); save(KEYS.sessions, n); return n;
    });
    localStorage.removeItem(KEYS.msgs(id));
    if (active === id) { setActive(null); setMsgs([]); }
  };

  return (
    <div className="flex h-full flex-col">
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
              {s.title}<span className="ml-1 block text-[9px] text-text-tertiary">{s.last}</span>
            </button>
            <button className="text-text-tertiary hover:text-danger" onClick={() => deleteSession(s.id)}>×</button>
          </div>
        ))}
      </div>

      {/* 消息流 */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {msgs.map(m => (
          <div key={m.id} className={`rounded-xl px-3 py-2 text-sm leading-6 ${m.role === "user" ? "ml-6 bg-primary/10" : "mr-6 border border-border bg-background-surface"}`}>
            <span className="mb-0.5 block text-[9px] text-text-tertiary">{m.role === "user" ? "你" : "AI"}</span>
            <span className="whitespace-pre-wrap break-words">{m.content}</span>
          </div>
        ))}
        {streaming && stream && <div className="mr-6 rounded-xl border border-border bg-background-surface px-3 py-2 text-sm whitespace-pre-wrap break-words">{stream}</div>}
        <div ref={bottomRef} />
      </div>

      {/* 输入 */}
      <div className="mt-2 flex gap-1.5">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={!cfg.apiKey ? "请先在设置中配置 API" : "输入消息..."}
          rows={2}
          disabled={streaming || !cfg.apiKey}
          className="flex-1 resize-none rounded-lg border border-border bg-background-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
        />
        <button onClick={streaming ? stop : handleSend} disabled={!input.trim() || !cfg.apiKey}
          className={`rounded-lg px-3 py-2 text-xs ${streaming ? "bg-danger/20 text-danger" : "bg-primary text-background-base"} disabled:opacity-40`}>
          {streaming ? "停" : "发"}
        </button>
      </div>
    </div>
  );
}
