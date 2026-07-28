/**
 * Pocket Chat — 独立 AI 对话页
 *
 * 与桌面端完全隔离：直连 OpenAI 兼容 API（从设置页激活的 AI Profile 读取
 * baseUrl/apiKey/model），流式响应，多会话历史存 localStorage。
 *
 * 布局：主页面只显示当前对话的消息流 + 底部输入区；
 * 会话历史收纳到左侧抽屉（汉堡按钮打开），提高信息密度。
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Markdown } from "../components/Markdown";

// 空状态建议 prompt
const SUGGESTIONS = [
  { icon: "✦", text: "帮我写一封本周工作周报" },
  { icon: "✎", text: "用大白话解释什么是闭包" },
  { icon: "☑", text: "总结今天的待办优先级" },
];

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

/** AI Profile 配置（与 SettingsPage 的 ModelProfile 对齐） */
interface ActiveProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  name?: string;
}

/** 从 localStorage 读取激活的 AI Profile（active=true），回退到旧三字段配置 */
function readActiveProfile(): ActiveProfile | null {
  try {
    const raw = localStorage.getItem("pocket-config");
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    // 优先：激活的 Profile
    const profiles = cfg.modelProfiles as ActiveProfile[] | undefined;
    if (Array.isArray(profiles)) {
      const active = profiles.find(p => (p as { active?: boolean }).active);
      if (active && active.baseUrl && active.apiKey && active.model) {
        return { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model, name: active.name };
      }
    }
    // 回退：旧三字段配置
    if (cfg.apiBase && cfg.apiKey) {
      return { baseUrl: cfg.apiBase, apiKey: cfg.apiKey, model: cfg.model || "gpt-4o" };
    }
    return null;
  } catch {
    return null;
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
  const [profile, setProfile] = useState<ActiveProfile | null>(() => readActiveProfile());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasConfig = !!profile;

  // 切换到本页时重新读取 Profile（用户可能在设置页改过）
  const refreshProfile = useCallback(() => setProfile(readActiveProfile()), []);
  useEffect(() => { refreshProfile(); }, [refreshProfile]);

  // 监听设置页保存事件
  useEffect(() => {
    const handler = () => refreshProfile();
    window.addEventListener("pocket-config-changed", handler);
    return () => window.removeEventListener("pocket-config-changed", handler);
  }, [refreshProfile]);

  // 切换会话时加载历史消息
  useEffect(() => {
    if (active) setMsgs(load(KEYS.msgs(active), []));
    else setMsgs([]);
  }, [active]);

  // 自动滚动
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, stream, error]);

  // 输入框自适应高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [input]);

  const clearError = useCallback(() => setError(null), []);

  const newSession = () => {
    clearError();
    const s: Session = { id: Date.now().toString(), title: "新对话", updated: Date.now(), last: "" };
    setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
    setActive(s.id);
    setMsgs([]);
    setDrawerOpen(false);
  };

  const sendMessage = async () => {
    clearError();
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessageWith(text, msgs);
  };

  /** 核心：用给定文本和已存在消息列表发起请求 */
  const sendMessageWith = useCallback(async (text: string, baseMsgs: Msg[]) => {
    clearError();
    if (!text.trim()) return;

    const cfg = readActiveProfile();
    if (!cfg) {
      setError("请先在「设置 → AI 供应商」中激活一个 Profile 后再发送消息");
      setProfile(null);
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
    const updated = [...baseMsgs, userMsg];
    setMsgs(updated);
    if (sid) save(KEYS.msgs(sid), updated);
    setStreaming(true);
    setStream("");

    const ctrl = new AbortController();
    abort.current = ctrl;

    try {
      const apiBase = cfg.baseUrl.replace(/\/+$/, "");
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: updated.map(m => ({ role: m.role === "error" ? "assistant" : m.role, content: m.content })),
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let msg = `请求失败 (${res.status})`;
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
              break;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) { full += delta; setStream(full); }
            } catch { /* skip */ }
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
            const n = p.map(s => s.id === sid ? { ...s, updated: Date.now(), last: full.slice(0, 80) } : s);
            save(KEYS.sessions, n);
            return n;
          });
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        setStreaming(false); setStream(""); return;
      }
      setError((e as Error).message || "发送失败，请检查 API 配置和网络");
    } finally {
      setStreaming(false);
      setStream("");
    }
  }, [active, msgs, streaming]);

  const stopStreaming = () => {
    abort.current?.abort();
    // 保留已接收的部分回复（若有），标注中断后落盘
    if (stream.trim()) {
      const partial: Msg = { id: `${Date.now()}-a`, role: "assistant", content: `${stream}\n\n_（已中断）_`, ts: Date.now() };
      setMsgs(prev => {
        const next = [...prev, partial];
        if (active) save(KEYS.msgs(active), next);
        return next;
      });
    }
    setStreaming(false);
    setStream("");
  };

  // 复制消息内容
  const copyMsg = useCallback(async (content: string) => {
    try { await navigator.clipboard.writeText(content); } catch { /* ignore */ }
  }, []);

  // 重试：以某条 user 消息为最后一条，丢弃其后内容重新发起
  const retryFrom = useCallback(async (msgId: string) => {
    if (streaming) return;
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const target = msgs[idx];
    if (target.role !== "user") return;
    // 截断到该 user 消息（含），丢弃其后的 assistant/error
    const truncated = msgs.slice(0, idx + 1);
    setMsgs(truncated);
    if (active) save(KEYS.msgs(active), truncated);
    // 用该消息内容重新发送（不 push 新 user 消息）
    setInput(target.content);
    // 下一帧触发发送
    setTimeout(() => {
      setInput("");
      sendMessageWith(target.content, truncated);
    }, 0);
  }, [msgs, active, streaming]);

  const selectSession = (id: string) => {
    clearError();
    setActive(id);
    setMsgs(load(KEYS.msgs(id), []));
    setDrawerOpen(false);
  };

  const deleteSession = (id: string) => {
    clearError();
    setSessions(p => { const n = p.filter(s => s.id !== id); save(KEYS.sessions, n); return n; });
    localStorage.removeItem(KEYS.msgs(id));
    if (active === id) { setActive(null); setMsgs([]); }
  };

  const send = () => sendMessage();
  const curSession = sessions.find(s => s.id === active);

  return (
    <div className="relative flex h-full flex-col">
      {/* 顶栏：汉堡 + 当前会话标题 */}
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => setDrawerOpen(true)} className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-border bg-background-surface text-text-secondary transition-colors hover:bg-border" title="会话历史">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.8px]" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold">{curSession?.title || "新对话"}</h3>
          {profile && <span className="font-mono text-[10px] text-text-tertiary">{profile.name || profile.model}</span>}
        </div>
        <button onClick={newSession} className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-background-surface text-text-secondary transition-colors hover:bg-border" title="新对话">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.8px]" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      {/* 未配置引导 */}
      {!hasConfig && (
        <div className="mb-2 rounded-xl border border-primary/40 bg-primary/8 px-4 py-3">
          <p className="text-xs font-semibold text-primary">⚠ 请先配置 AI</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">进入「设置 → AI 供应商」激活一个 Profile 后即可开始对话</p>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/8 px-3 py-2">
          <span className="shrink-0 text-xs text-danger">✕</span>
          <span className="min-w-0 flex-1 text-[11px] leading-5 text-danger">{error}</span>
          <button onClick={clearError} className="shrink-0 text-[10px] text-text-tertiary hover:text-text-primary">关闭</button>
        </div>
      )}

      {/* 消息流 */}
      <div className="flex-1 space-y-3 overflow-y-auto">
        {msgs.length === 0 && !streaming && (
          <div className="flex flex-col items-center gap-4 py-12">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <svg viewBox="0 0 24 24" className="h-8 w-8 fill-none stroke-current stroke-[1.6px]" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </div>
            <div className="text-center">
              <p className="text-[14px] font-semibold text-text-primary">{hasConfig ? "开始对话" : "配置 AI 后开始"}</p>
              <p className="mt-1 text-[12px] text-text-tertiary">{hasConfig ? "选择下方话题或直接输入" : "前往设置激活一个 Profile"}</p>
            </div>
            {hasConfig && (
              <div className="flex w-full flex-col gap-2">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s.text}
                    onClick={() => sendMessageWith(s.text, [])}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-background-surface px-3.5 py-2.5 text-left text-[13px] text-text-secondary transition-colors hover:border-primary/40 hover:bg-primary/5"
                  >
                    <span className="text-primary">{s.icon}</span>
                    <span className="flex-1">{s.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {msgs.map(m => (
          <div key={m.id} className={`group/msg flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[86%] rounded-2xl px-3.5 py-2 text-[13px] shadow-sm ${
              m.role === "user"
                ? "bg-primary text-background-base [border-bottom-right-radius:5px] font-medium"
                : m.role === "error"
                  ? "border border-danger/40 bg-danger/8 text-danger [border-bottom-left-radius:5px]"
                  : "border border-border bg-background-surface text-text-primary [border-bottom-left-radius:5px]"
            }`}>
              {m.role === "assistant" ? (
                <Markdown content={m.content} />
              ) : (
                <span className="whitespace-pre-wrap break-words">{m.content}</span>
              )}
              {/* 消息操作条 */}
              <div className={`mt-1 flex items-center gap-1 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <button
                  onClick={() => copyMsg(m.content)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity hover:bg-background-base/40 group-hover/msg:opacity-100"
                  title="复制"
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  复制
                </button>
                {m.role === "user" && (
                  <button
                    onClick={() => retryFrom(m.id)}
                    disabled={streaming}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity hover:bg-background-base/40 disabled:opacity-30 group-hover/msg:opacity-100"
                    title="重试"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.6-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.6 6.3L3 16M3 21v-5h5" /></svg>
                    重试
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {streaming && stream && (
          <div className="flex justify-start">
            <div className="max-w-[86%] rounded-2xl border border-border bg-background-surface px-3.5 py-2 text-[13px] [border-bottom-left-radius:5px]">
              <Markdown content={stream} />
              <span className="ml-0.5 inline-block w-[7px] text-primary animate-pulse">▌</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="mt-3 flex items-end gap-2 rounded-[14px] border border-border bg-background-elevated p-2 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(203,166,247,0.12)]">
        <textarea
          ref={taRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1}
          placeholder="输入消息…"
          className="max-h-32 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
          disabled={streaming}
        />
        <button
          onClick={streaming ? stopStreaming : send}
          disabled={!streaming && !input.trim()}
          className={`flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-transform hover:scale-105 disabled:opacity-40 disabled:transform-none ${
            streaming ? "bg-danger/15 text-danger" : "bg-primary text-background-base"
          }`}
          title={streaming ? "停止" : "发送"}
        >
          {streaming ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
          )}
        </button>
      </div>

      {/* 会话历史抽屉 */}
      {drawerOpen && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/45 transition-opacity" onClick={() => setDrawerOpen(false)} />
          <aside className="fixed left-0 top-0 bottom-0 z-[61] flex w-[280px] max-w-[75%] flex-col border-r border-border bg-background-elevated shadow-[0_8px_28px_rgba(0,0,0,0.28)]" style={{ transform: "translateX(0)", animation: "slideIn 0.25s ease" }}>
            <style>{`@keyframes slideIn{from{transform:translateX(-100%)}to{transform:translateX(0)}}`}</style>
            <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
              <span className="text-[14px] font-semibold">对话历史</span>
              <button onClick={() => setDrawerOpen(false)} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-border text-text-secondary hover:bg-background-surface">
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-3 py-2">
              <button onClick={newSession} className="flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary py-2 text-[13px] font-medium text-background-base transition-opacity hover:opacity-90">
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[2.4px]" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                新对话
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2.5 py-1">
              {sessions.length === 0 && <p className="py-6 text-center text-[11px] text-text-tertiary">暂无对话</p>}
              {sessions.map(s => (
                <div key={s.id} className={`mb-1 flex items-center gap-2 rounded-[10px] border px-2.5 py-2 transition-colors ${active === s.id ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-background-surface"}`}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => selectSession(s.id)}>
                    <span className="block truncate text-[12px] font-medium text-text-primary">{s.title}</span>
                    <span className="block truncate text-[10px] text-text-tertiary">{s.last || "（空）"}</span>
                  </button>
                  <button onClick={() => deleteSession(s.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-danger/10 hover:text-danger" title="删除">
                    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
