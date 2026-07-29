/**
 * Pocket Chat — 独立 AI 对话页
 *
 * 与桌面端完全隔离：直连 OpenAI 兼容 API（从设置页激活的 AI Profile 读取
 * baseUrl/apiKey/model），流式响应，多会话历史存 localStorage。
 *
 * 布局：主页面只显示当前对话的消息流 + 底部输入区；
 * 会话历史收纳到左侧抽屉（汉堡按钮打开），提高信息密度。
 *
 * === Agent 循环 ===
 * 支持模型调用工具（tool_use）操作手机。
 * 工作流程：
 *   1. 用户发消息 → 构建 messages（含 system prompt + tools 定义）
 *   2. 流式请求 → 解析 text delta + tool_use delta
 *   3. 有 tool_use → 执行工具（前端 API / Tauri invoke）→ 结果回送
 *   4. 循环直到模型返回纯文本或达到 maxTurns
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Markdown } from "../components/Markdown";
import { ToolBlockCard } from "../components/ToolBlockCard";
import { useAgentLoop } from "../services/useAgentLoop";

import type {
  MsgBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCardData,
  WireApi,
  ToolDefinition,
  ToolAvailability,
} from "../services/toolTypes";

import {
  supportsToolUse,
  getAvailableTools,
  getEnabledToolDefinitions,
  normalizeToBlocks,
  extractText,
  extractToolCalls,
  extractToolResults,
  TOOL_REGISTRY,
} from "../services/toolRegistry";

// ============================================================================
// 存储
// ============================================================================

const KEYS = {
  sessions: "pocket-sessions",
  msgs: (id: string) => `pocket-msgs-${id}`,
};

function load<T>(k: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(k)!) ?? fallback; } catch { return fallback; }
}
function save(k: string, v: unknown) { localStorage.setItem(k, JSON.stringify(v)); }

// ============================================================================
// 类型
// ============================================================================

interface Session {
  id: string; title: string; updated: number; last: string;
}

/** 消息：content 双形态（string 兼容旧数据 + Array<MsgBlock> 支持工具） */
export interface Msg {
  id: string; role: "user" | "assistant" | "error" | "tool";
  content: string | MsgBlock[]; ts: number;
}

/** AI Profile 配置 */
interface ActiveProfile {
  baseUrl: string; apiKey: string; model: string;
  wireApi?: WireApi; name?: string;
}

// ============================================================================
// Profile 读取
// ============================================================================

function readActiveProfile(): ActiveProfile | null {
  try {
    const raw = localStorage.getItem("pocket-config");
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    const profiles = cfg.modelProfiles as ActiveProfile[] | undefined;
    if (Array.isArray(profiles)) {
      const active = profiles.find(p => (p as { active?: boolean }).active && p.baseUrl && p.apiKey && p.model);
      if (active) {
        return {
          baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model,
          wireApi: active.wireApi, name: active.name,
        };
      }
    }
    // 旧格式
    if (cfg.apiBase && cfg.apiKey) {
      return { baseUrl: cfg.apiBase, apiKey: cfg.apiKey, model: cfg.model || "gpt-4o" };
    }
    return null;
  } catch { return null; }
}

// ============================================================================
// 组件
// ============================================================================

function uid(): string { return `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

const SUGGESTIONS = [
  { icon: "✦", text: "帮我写一封本周工作周报" },
  { icon: "✎", text: "用大白话解释什么是闭包" },
  { icon: "☑", text: "总结今天的待办优先级" },
  { icon: "📍", text: "我现在的地理位置在哪？" },
  { icon: "🕐", text: "告诉我现在的准确时间" },
];

export function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>(() => load(KEYS.sessions, []));
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ActiveProfile | null>(() => readActiveProfile());
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Agent 循环状态
  const { isRunning: agentRunning, currentTurn, run: runAgent, abort: abortAgent } = useAgentLoop();
  const abortRef = useRef<AbortController | null>(null);

  // 工具卡片（每轮工具执行的 UI 状态）
  const [toolCards, setToolCards] = useState<Map<string, ToolCardData>>(new Map());

  // 当前流式内容（纯文本部分，实时渲染）
  const [streamText, setStreamText] = useState("");
  const streamTextRef = useRef("");
  // 标记本轮是否已在 onToolCalls 中写入过 assistant 消息（防止 onDone 重复写入）
  const turnAssistantWrittenRef = useRef(false);

  // 工具可用性缓存
  const [availableTools, setAvailableTools] = useState<ToolAvailability[]>([]);

  // 是否启用工具模式（有可用工具 + wireApi 支持）
  const toolsEnabled = useMemo(() => {
    if (!profile) return false;
    if (!supportsToolUse(profile.wireApi)) return false;
    const enabled = getEnabledToolDefinitions(availableTools);
    return enabled.length > 0;
  }, [profile, availableTools]);

  const hasConfig = !!profile;

  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 切换到本页时重新读取 Profile
  const refreshProfile = useCallback(() => setProfile(readActiveProfile()), []);
  useEffect(() => { refreshProfile(); }, [refreshProfile]);

  useEffect(() => {
    const handler = () => refreshProfile();
    window.addEventListener("pocket-config-changed", handler);
    return () => window.removeEventListener("pocket-config-changed", handler);
  }, [refreshProfile]);

  // 切换会话时加载历史消息（自动将旧 string 内容升级为 MsgBlock[]）
  useEffect(() => {
    if (active) {
      const raw = load(KEYS.msgs(active), [] as Msg[]);
      setMsgs(raw.map((m: Msg) => {
        if (typeof m.content === "string") {
          return { ...m, content: [{ type: "text", text: m.content }] as MsgBlock[] };
        }
        return m;
      }));
    } else {
      setMsgs([]);
    }
  }, [active]);

  // 工具可用性探测（启动时 + Profile 切换时）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tools = await getAvailableTools();
      if (!cancelled) setAvailableTools(tools);
    })();
    return () => { cancelled = true; };
  }, [active]);

  // 自动滚动
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, streamText, toolCards]);

  // 输入框自适应高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [input]);

  // 工具状态更新时滚动到底
  useEffect(() => { if (toolCards.size > 0) { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); } }, [toolCards]);

  // ============================================================================
  // 操作
  // ============================================================================

  const clearError = useCallback(() => setError(null), []);

  const newSession = () => {
    clearError();
    const s: Session = { id: Date.now().toString(), title: "新对话", updated: Date.now(), last: "" };
    setSessions(prev => { save(KEYS.sessions, [s, ...prev]); return [s, ...prev]; });
    setActive(s.id);
    setMsgs([]);
    setDrawerOpen(false);
  };

  const selectSession = (id: string) => {
    clearError();
    setActive(id);
    setMsgs(load(KEYS.msgs(id), []).map((m: Msg) => {
      if (typeof m.content === "string") {
        return { ...m, content: [{ type: "text", text: m.content }] as MsgBlock[] };
      }
      return m;
    }));
    setDrawerOpen(false);
  };

  const deleteSession = (id: string) => {
    clearError();
    setSessions(p => { const n = p.filter(s => s.id !== id); save(KEYS.sessions, n); return n; });
    localStorage.removeItem(KEYS.msgs(id));
    if (active === id) { setActive(null); setMsgs([]); }
  };

  // ============================================================================
  // Agent 循环消息写入辅助
  // ============================================================================

  const addMsg = useCallback((msg: Msg, isUser: boolean = false) => {
    setMsgs(prev => {
      const next = [...prev, msg];
      if (active) save(KEYS.msgs(active), next);
      return next;
    });
    if (isUser && active) {
      const lastText = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      setSessions(p => {
        const n = p.map(s => s.id === active ? { ...s, updated: Date.now(), last: lastText.slice(0, 80) } : s);
        save(KEYS.sessions, n);
        return n;
      });
    }
  }, [active]);

  /** 添加工具卡片 */
  const addToolCard = useCallback(
    (toolUseId: string, name: string, input: Record<string, unknown>, icon: string = "🔧") => {
      setToolCards(prev => { const m = new Map(prev); m.set(toolUseId, { id: toolUseId, name, icon, input, status: "running" }); return m; });
    }, []
  );

  /** 更新工具卡片状态 */
  const updateToolCard = useCallback(
    (toolUseId: string, status: "success" | "error", result: string, resultIsError: boolean = false) => {
      setToolCards(prev => { const m = new Map(prev); const card = m.get(toolUseId); if (card) m.set(toolUseId, { ...card, status, result, resultIsError }); return m; });
    }, []
  );

  // ============================================================================
  // 发送消息
  // ============================================================================

  const sendMessage = async () => {
    clearError();
    const text = input.trim();
    if (!text || agentRunning) return;
    setInput("");
    await sendMessageWith(text, msgs);
  };

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

    // 添加用户消息
    const userMsg: Msg = { id: uid(), role: "user", content: [{ type: "text", text } as TextBlock], ts: Date.now() };
    addMsg(userMsg, true);

    // ====== 判断是否启用 Agent 循环 ======
    if (toolsEnabled) {
      await runAgentLoop(text, baseMsgs, cfg);
      return;
    }

    // ====== 纯文本模式（向后兼容，不走 Agent 循环） ======
    await runTextOnly(cfg, sid, [...baseMsgs, userMsg]);
  }, [active, msgs, agentRunning, toolsEnabled, addMsg]);

  // ============================================================================
  // Agent 循环实现
  // ============================================================================

  const runAgentLoop = useCallback(async (text: string, baseMsgs: Msg[], cfg: ActiveProfile) => {
    setStreamText("");
    streamTextRef.current = "";
    setToolCards(new Map());

    const initialMessages = baseMsgs.map(m => ({ role: m.role, content: m.content }));

    runAgent({
      profile: cfg,
      availableTools,
      baseMessages: initialMessages,
      userInput: text,
      requestTimeout: 60000,
      toolTimeout: 20000,
      maxTurns: 6,
      callbacks: {
        onTurnStart: (turn) => {
          setStreamText("");
          streamTextRef.current = "";
          turnAssistantWrittenRef.current = false;
          if (turn > 0) { setToolCards(new Map()); }
        },

        onTextDelta: (delta, fullText) => {
          streamTextRef.current = fullText;
          setStreamText(fullText);
        },

        onToolCalls: (toolCalls) => {
          const assistantBlocks: MsgBlock[] = [];
          if (streamTextRef.current) {
            assistantBlocks.push({ type: "text", text: streamTextRef.current } as TextBlock);
          }
          for (const tc of toolCalls) {
            assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input } as ToolUseBlock);
          }
          const assistantMsg: Msg = { id: uid(), role: "assistant", content: assistantBlocks, ts: Date.now() };
          addMsg(assistantMsg);
          turnAssistantWrittenRef.current = true;

          const toolDefMap = new Map(TOOL_REGISTRY.map(t => [t.name, t]));
          for (const tc of toolCalls) {
            const def = toolDefMap.get(tc.name);
            addToolCard(tc.id, tc.name, tc.input, def?.icon ?? "🔧");
          }
        },

        onToolResult: (toolUseId, content, isError) => {
          updateToolCard(toolUseId, isError ? "error" : "success", content, isError);
        },

        onToolResultBlocks: (blocks) => {
          for (const block of blocks) {
            const toolMsg: Msg = { id: uid(), role: "tool", content: [block as ToolResultBlock], ts: Date.now() };
            addMsg(toolMsg);
          }
        },

        onDone: (reason) => {
          if (reason === "completed" && !turnAssistantWrittenRef.current && streamTextRef.current) {
            const assistantMsg: Msg = { id: uid(), role: "assistant", content: [{ type: "text", text: streamTextRef.current } as TextBlock], ts: Date.now() };
            addMsg(assistantMsg);
          }
          setStreamText("");
          streamTextRef.current = "";
        },

        onError: (msg) => { setError(msg); },
      },
    });
  }, [availableTools, addMsg, addToolCard, updateToolCard, runAgent]);

  // ============================================================================
  // 纯文本模式（向后兼容）
  // ============================================================================

  const runTextOnly = useCallback(async (cfg: ActiveProfile, sid: string, updated: Msg[]) => {
    setStreamText("");
    streamTextRef.current = "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const apiBase = cfg.baseUrl.replace(/\/+$/, "");
      const url = `${apiBase}/chat/completions`;

      const body = JSON.stringify({
        model: cfg.model,
        messages: updated.map(m => ({
          role: m.role === "error" ? "assistant" : m.role === "tool" ? "user" : m.role,
          content: typeof m.content === "string" ? m.content : extractText(m.content),
        })),
        stream: true,
      });

      const { proxyStreamFetch } = await import("../services/chatProxy");

      let full = "";
      let cancelled = false;
      let cancelStream = () => {};

      proxyStreamFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body,
      }, (chunk, done, error) => {
        if (cancelled) return;
        if (error) { setError(error); return; }
        if (chunk) {
          const lines = chunk.split("\n").filter(l => l.startsWith("data: "));
          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) { full += delta; streamTextRef.current = full; setStreamText(full); }
            } catch { /* skip */ }
          }
        }
        if (done) {
          if (full) {
            const am: Msg = { id: uid(), role: "assistant", content: [{ type: "text", text: full } as TextBlock], ts: Date.now() };
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
          setStreamText("");
          streamTextRef.current = "";
        }
      }).then(c => { cancelStream = c; });

      ctrl.signal.addEventListener("abort", () => { cancelled = true; cancelStream(); });
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "发送失败，请检查 API 配置和网络");
    } finally {
      abortRef.current = null;
    }
  }, []);

  // ============================================================================
  // 停止
  // ============================================================================

  const stopStreaming = () => {
    if (agentRunning) {
      abortAgent();
    } else {
      abortRef.current?.abort();
    }
    // 保留已接收的部分回复
    if (streamTextRef.current.trim()) {
      const partial: Msg = { id: uid(), role: "assistant", content: [{ type: "text", text: `${streamTextRef.current}\n\n_（已中断）_` } as TextBlock], ts: Date.now() };
      setMsgs(prev => { const next = [...prev, partial]; if (active) save(KEYS.msgs(active), next); return next; });
    }
    setStreamText("");
    streamTextRef.current = "";
  };

  // ============================================================================
  // 消息操作
  // ============================================================================

  const copyMsg = useCallback(async (content: string) => {
    try { await navigator.clipboard.writeText(content); } catch { /* ignore */ }
  }, []);

  const retryFrom = useCallback(async (msgId: string) => {
    if (agentRunning) return;
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const target = msgs[idx];
    if (target.role !== "user") return;
    const text = typeof target.content === "string" ? target.content : extractText(target.content);
    const truncated = msgs.slice(0, idx + 1);
    setMsgs(truncated);
    if (active) save(KEYS.msgs(active), truncated);
    setInput(text);
    setTimeout(() => { setInput(""); sendMessageWith(text, truncated); }, 0);
  }, [msgs, active, agentRunning]);

  // ============================================================================
  // 渲染
  // ============================================================================

  const curSession = sessions.find(s => s.id === active);

  /** 渲染消息内容（string 或 MsgBlock[]） */
  const renderMsgContent = useCallback((content: string | MsgBlock[], role: string) => {
    if (typeof content === "string") {
      return role === "assistant" ? <Markdown content={content} /> : <span className="whitespace-pre-wrap break-words">{content}</span>;
    }
    const parts: React.ReactNode[] = [];
    for (const block of content) {
      if (block.type === "text") {
        if (role === "assistant") {
          parts.push(<Markdown key={`t-${parts.length}`} content={block.text} />);
        } else {
          parts.push(<span key={`t-${parts.length}`} className="whitespace-pre-wrap break-words">{block.text}</span>);
        }
      } else if (block.type === "tool_use") {
        parts.push(
          <div key={`tu-${block.id}`} className="mt-1 rounded-[8px] border border-border bg-background-base/40 px-2.5 py-1.5 text-[11px]">
            <span className="font-mono text-text-secondary">{block.name}</span>
            <span className="text-text-tertiary ml-1">({JSON.stringify(block.input)})</span>
          </div>
        );
      } else if (block.type === "tool_result") {
        parts.push(
          <div key={`tr-${block.tool_use_id}`} className="mt-1 rounded-[8px] border border-border bg-background-surface/50 px-2.5 py-1.5 text-[11px]">
            <span className="font-mono text-text-tertiary">结果</span>
            <span className="text-text-primary ml-1 whitespace-pre-wrap break-words">{block.content}</span>
          </div>
        );
      }
    }
    return <div className="space-y-0.5">{parts}</div>;
  }, []);

  const send = () => sendMessage();

  // 工具模式下显示提示徽章
  const toolsBadge = toolsEnabled && (
    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[10px] text-primary">
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      工具已启用
    </span>
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* 顶栏 */}
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => setDrawerOpen(true)} className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-border bg-background-surface text-text-secondary transition-colors hover:bg-border" title="会话历史">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.8px]" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold">{curSession?.title || "新对话"}</h3>
          <div className="flex items-center gap-1.5">
            {profile && <span className="font-mono text-[10px] text-text-tertiary">{profile.name || profile.model}</span>}
            {toolsBadge}
            {agentRunning && currentTurn > 0 && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[10px] text-warning">
                ⚡ Agent 轮次 {currentTurn}
              </span>
            )}
          </div>
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
        {msgs.length === 0 && !agentRunning && (
          <div className="flex flex-col items-center gap-4 py-12">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <svg viewBox="0 0 24 24" className="h-8 w-8 fill-none stroke-current stroke-[1.6px]" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </div>
            <div className="text-center">
              <p className="text-[14px] font-semibold text-text-primary">{hasConfig ? "开始对话" : "配置 AI 后开始"}</p>
              <p className="mt-1 text-[12px] text-text-tertiary">
                {hasConfig ? toolsEnabled ? "可以问我任何问题，或让我操作手机（拍照、位置、剪贴板等）" : "选择下方话题或直接输入" : "前往设置激活一个 Profile"}
              </p>
            </div>
            {hasConfig && (
              <div className="flex w-full flex-col gap-2">
                {SUGGESTIONS.map(s => (
                  <button key={s.text} onClick={() => sendMessageWith(s.text, [])}
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
            <div className={`max-w-[92%] rounded-2xl px-3.5 py-2 text-[13px] shadow-sm ${
              m.role === "user"
                ? "bg-primary text-background-base [border-bottom-right-radius:5px] font-medium"
                : m.role === "error"
                  ? "border border-danger/40 bg-danger/8 text-danger [border-bottom-left-radius:5px]"
                  : m.role === "tool"
                    ? "border border-warning/30 bg-warning/4 text-text-secondary [border-bottom-left-radius:5px]"
                    : "border border-border bg-background-surface text-text-primary [border-bottom-left-radius:5px]"
            }`}>
              {renderMsgContent(m.content, m.role)}
              {m.role !== "tool" && (
                <div className={`mt-1 flex items-center gap-1 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <button onClick={() => { const text = typeof m.content === "string" ? m.content : extractText(m.content); copyMsg(text); }}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity hover:bg-background-base/40 group-hover/msg:opacity-100" title="复制"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    复制
                  </button>
                  {m.role === "user" && (
                    <button onClick={() => retryFrom(m.id)} disabled={agentRunning}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity hover:bg-background-base/40 disabled:opacity-30 group-hover/msg:opacity-100" title="重试"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.6-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.6 6.3L3 16M3 21v-5h5" /></svg>
                      重试
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* 流式文本（纯文本模式） */}
        {streamText && !agentRunning && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded-2xl border border-border bg-background-surface px-3.5 py-2 text-[13px] [border-bottom-left-radius:5px]">
              <Markdown content={streamText} />
              <span className="ml-0.5 inline-block w-[7px] text-primary animate-pulse">▌</span>
            </div>
          </div>
        )}

        {/* 工具执行卡片 */}
        {toolCards.size > 0 && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded-2xl border border-border bg-background-surface px-3.5 py-2 text-[13px] [border-bottom-left-radius:5px]">
              {Array.from(toolCards.values()).map(card => (
                <ToolBlockCard key={card.id} data={card} />
              ))}
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
          placeholder={toolsEnabled ? "输入消息…（可让 AI 操作手机）" : "输入消息…"}
          className="max-h-32 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
          disabled={agentRunning}
        />
        <button
          onClick={agentRunning ? stopStreaming : send}
          disabled={!agentRunning && !input.trim()}
          className={`flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-transform hover:scale-105 disabled:opacity-40 disabled:transform-none ${
            agentRunning ? "bg-danger/15 text-danger" : "bg-primary text-background-base"
          }`}
          title={agentRunning ? "停止" : "发送"}
        >
          {agentRunning ? (
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