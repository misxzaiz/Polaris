/**
 * SettingsPage — 设置页
 *
 * 三区块：
 * 1. AI 供应商（对标主项目 ModelProviderTab，多 Profile 多模型管理）
 * 2. Personal Hub（Supabase 配置）
 * 3. 关于
 *
 * Profile 数据模型对齐主项目 src/types/modelProfile.ts。
 * Profile 持久化到 localStorage（pocket-config.modelProfiles），
 * ChatPage 读取激活 Profile（active=true）的 baseUrl/apiKey/model 发请求。
 */
import { useState, useMemo, useCallback, useEffect } from "react";
import {
  getServerUrl,
  storeServerUrl,
  clearServerUrl,
  getTokenMd5,
  storeTokenMd5,
  getServerHistory,
  addServerToHistory,
  removeServerFromHistory,
  md5Hex,
  type ServerHistoryEntry,
} from "../services/auth";

type WireApi = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
type ProfileCategory = "official" | "cn_official" | "aggregator" | "third_party" | "custom";

interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelOptions?: string[];
  wireApi: WireApi;
  category?: ProfileCategory;
  active?: boolean;
  contextWindow?: number;
}

interface ProviderPreset {
  name: string;
  category: ProfileCategory;
  defaultWireApi: WireApi;
  commonModels: string[];
  baseUrls: string[];
  description: string;
}

const COMMON_PRESETS: ProviderPreset[] = [
  { name: "SiliconFlow (硅基流动)", category: "aggregator", defaultWireApi: "anthropic-messages", commonModels: ["glm-4", "deepseek-v3", "Qwen-2.5-72B"], baseUrls: ["https://api.siliconflow.cn"], description: "国内主流 AI API 聚合平台" },
  { name: "OpenRouter", category: "aggregator", defaultWireApi: "openai-chat-completions", commonModels: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"], baseUrls: ["https://openrouter.ai/api/v1"], description: "跨模型 API 网关，100+ 模型" },
  { name: "火山引擎 (Volcengine)", category: "cn_official", defaultWireApi: "anthropic-messages", commonModels: ["glm-4", "Yi-Lightning"], baseUrls: ["https://ark.cn-beijing.volces.com/api/v3"], description: "字节跳动旗下云平台" },
  { name: "Together AI", category: "aggregator", defaultWireApi: "openai-chat-completions", commonModels: ["meta-llama/Llama-3-70b-chat-hf"], baseUrls: ["https://api.together.xyz/v1"], description: "开源模型 API 平台" },
  { name: "自定义端点", category: "custom", defaultWireApi: "anthropic-messages", commonModels: [], baseUrls: [], description: "手动输入任意兼容端点" },
];

const CATEGORY_LABEL: Record<ProfileCategory, string> = { official: "官方", cn_official: "国内官方", aggregator: "聚合", third_party: "第三方", custom: "自定义" };
const WIRE_LABEL: Record<WireApi, string> = { "anthropic-messages": "Anthropic", "openai-chat-completions": "OpenAI Chat", "openai-responses": "Responses" };

function loadProfiles(): ModelProfile[] {
  try {
    const cfg = JSON.parse(localStorage.getItem("pocket-config") || "{}");
    return cfg.modelProfiles || [];
  } catch { return []; }
}

export function SettingsPage() {
  const [profiles, setProfiles] = useState<ModelProfile[]>(() => loadProfiles());
  const [search, setSearch] = useState("");
  const [engineFilter, setEngineFilter] = useState<"all" | "claude" | "codex">("all");
  const [showPresets, setShowPresets] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // 其他配置
  const [supabaseUrl, setSupabaseUrl] = useState(() => JSON.parse(localStorage.getItem("pocket-config") || "{}").supabaseUrl || "");
  const [supabaseKey, setSupabaseKey] = useState(() => JSON.parse(localStorage.getItem("pocket-config") || "{}").supabaseKey || "");
  const [encKey, setEncKey] = useState(() => JSON.parse(localStorage.getItem("pocket-config") || "{}").encryptionKey || "");
  // ├─ 桌面端连接状态 ──────────────────────────────────
  const [connServerInput, setConnServerInput] = useState(() => getServerUrl());
  const [connTokenInput, setConnTokenInput] = useState("");
  const [connConnected, setConnConnected] = useState(false);
  const [connChecking, setConnChecking] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [connHistory, setConnHistory] = useState<ServerHistoryEntry[]>(() => getServerHistory());

  const reloadConnHistory = useCallback(() => {
    setConnHistory(getServerHistory());
  }, []);

  const connCheck = useCallback(async () => {
    const url = getServerUrl();
    if (!url) { setConnConnected(false); return; }
    setConnChecking(true);
    setConnError(null);
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`);
      if (res.ok) {
        setConnConnected(true);
        setConnServerInput(url);
        addServerToHistory(url, getTokenMd5());
        reloadConnHistory();
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      setConnConnected(false);
      setConnError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnChecking(false);
    }
  }, [reloadConnHistory]);

  useEffect(() => { void connCheck(); }, [connCheck]);

  const connSave = async () => {
    const url = connServerInput.trim().replace(/\/$/, "");
    if (!url) return;
    storeServerUrl(url);
    if (connTokenInput.trim()) {
      storeTokenMd5(await md5Hex(connTokenInput.trim()));
    }
    // 重建 transport
    const { rebuildTransport } = await import("../services/desktopTransport");
    rebuildTransport();
    await connCheck();
  };

  const connPickFromHistory = async (entry: ServerHistoryEntry) => {
    setConnServerInput(entry.url);
    setConnTokenInput("");
    storeServerUrl(entry.url);
    if (entry.tokenMd5) storeTokenMd5(entry.tokenMd5);
    else storeTokenMd5("");
    const { rebuildTransport } = await import("../services/desktopTransport");
    rebuildTransport();
    await connCheck();
  };

  const connDisconnect = async () => {
    const { disconnect } = await import("../services/desktopTransport");
    disconnect();
    await clearServerUrl();
    setConnConnected(false);
    setConnServerInput("");
    setConnTokenInput("");
    setConnError(null);
    reloadConnHistory();
  };

  const [saved, setSaved] = useState(false);

  const persistProfiles = (next: ModelProfile[]) => {
    setProfiles(next);
    const cfg = JSON.parse(localStorage.getItem("pocket-config") || "{}");
    cfg.modelProfiles = next;
    localStorage.setItem("pocket-config", JSON.stringify(cfg));
    window.dispatchEvent(new CustomEvent("pocket-config-changed"));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter(p => !q || p.name.toLowerCase().includes(q) || p.model.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q));
  }, [profiles, search]);

  const openCreate = (preset?: ProviderPreset) => {
    setShowPresets(false);
    setEditing(preset ? {
      id: "", name: preset.name, baseUrl: preset.baseUrls[0] || "", apiKey: "", model: preset.commonModels[0] || "",
      modelOptions: [...preset.commonModels], wireApi: preset.defaultWireApi, category: preset.category,
    } : null);
    setShowEditor(true);
  };
  const openEdit = (p: ModelProfile) => { setEditing(p); setShowEditor(true); };
  const saveProfile = (p: ModelProfile) => {
    if (editing?.id) persistProfiles(profiles.map(x => x.id === p.id ? p : x));
    else persistProfiles([{ ...p, id: `profile_${Date.now().toString(36)}` }, ...profiles]);
    setShowEditor(false); setEditing(null);
  };
  const removeProfile = (id: string) => persistProfiles(profiles.filter(x => x.id !== id));
  const activate = (p: ModelProfile) => persistProfiles(profiles.map(x => ({ ...x, active: x.id === p.id ? !x.active : false })));

  const saveAll = () => {
    const cfg = JSON.parse(localStorage.getItem("pocket-config") || "{}");
    cfg.supabaseUrl = supabaseUrl;
    cfg.supabaseKey = supabaseKey;
    cfg.encryptionKey = encKey;
    localStorage.setItem("pocket-config", JSON.stringify(cfg));
    window.dispatchEvent(new CustomEvent("pocket-config-changed"));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* 1. AI 供应商 */}
      <section>
        <h3 className="mb-2.5 text-[15px] font-semibold">AI 供应商</h3>
        <div className="rounded-[14px] border border-border bg-background-elevated p-3 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
          <div className="mb-2.5 flex items-center gap-2">
            <div className="relative flex-1">
              <svg viewBox="0 0 24 24" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 fill-none stroke-text-tertiary stroke-2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索 profile..." className="w-full rounded-[10px] border border-border bg-background-surface py-1.5 pl-8 pr-3 text-xs text-text-primary outline-none focus:border-primary" />
            </div>
            <div className="relative">
              <button onClick={() => setShowPresets(!showPresets)} className="rounded-[8px] border border-warning/50 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning transition-colors hover:bg-warning/10">从预设</button>
              {showPresets && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowPresets(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-background-elevated p-1.5 shadow-xl">
                    {COMMON_PRESETS.map(preset => (
                      <button key={preset.name} onClick={() => openCreate(preset)} className="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-primary/5">
                        <span className="text-warning">✦</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-text-primary">{preset.name}</div>
                          <div className="truncate text-[10px] text-text-tertiary">{preset.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={() => openCreate()} className="rounded-[8px] bg-primary px-2.5 py-1.5 text-[11px] text-background-base transition-opacity hover:opacity-90">+ 新建</button>
          </div>
          <div className="mb-2.5 flex gap-1">
            {(["all", "claude", "codex"] as const).map(f => (
              <button key={f} onClick={() => setEngineFilter(f)} className={`rounded-full px-2.5 py-1 text-[10px] transition-all ${engineFilter === f ? "bg-primary/15 text-primary" : "border border-border bg-background-surface text-text-tertiary hover:bg-border"}`}>
                {f === "all" ? "全部" : f === "claude" ? "Claude" : "Codex"}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {filtered.length === 0 && <div className="py-6 text-center text-xs text-text-tertiary">暂无供应商 Profile，点击「新建」或「从预设」</div>}
            {filtered.map(p => (
              <div key={p.id} className={`flex items-center gap-2.5 rounded-[12px] border p-3 transition-[border-color,box-shadow] ${p.active ? "border-primary bg-primary/5" : "border-border bg-background-base hover:shadow-[0_2px_8px_rgba(0,0,0,0.12)]"}`}>
                <span className={`h-8 w-1 shrink-0 rounded-full transition-all ${p.active ? "bg-primary opacity-100 shadow-[0_0_6px_rgba(203,166,247,0.5)]" : "bg-text-tertiary opacity-40"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-text-primary">{p.name}</span>
                    <span className="rounded bg-[#89b4fa]/14 px-1.5 py-0.5 text-[9px] text-[#89b4fa]">Claude</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] ${p.wireApi === "openai-chat-completions" ? "bg-[#cba6f7]/14 text-primary" : p.wireApi === "openai-responses" ? "bg-[#f5c2e7]/14 text-[#f5c2e7]" : "bg-primary/10 text-primary"}`}>{WIRE_LABEL[p.wireApi]}</span>
                    {p.category && p.category !== "custom" && <span className="rounded bg-warning/14 px-1.5 py-0.5 text-[9px] text-warning">{CATEGORY_LABEL[p.category]}</span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">{p.model} · {safeHostname(p.baseUrl)}</div>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <button onClick={() => activate(p)} className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-primary" title={p.active ? "已激活" : "激活"}>
                    {p.active ? <span className="text-primary">●</span> : "○"}
                  </button>
                  <button onClick={() => openEdit(p)} className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-primary" title="编辑">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  </button>
                  <button onClick={() => removeProfile(p.id)} className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-danger" title="删除">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 1.5 桌面端连接 */}
      <section>
        <h3 className="mb-2.5 text-[15px] font-semibold">📡 桌面端连接</h3>
        <div className="space-y-3 rounded-[14px] border border-border bg-background-elevated p-4 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
          {connConnected && (
            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-green/5 border border-green/20">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-green shrink-0 shadow-[0_0_6px_rgba(166,227,161,0.5)]" />
                <span className="text-xs text-green shrink-0">已连接</span>
                <code className="text-[10px] text-text-tertiary truncate">{getServerUrl()}</code>
              </div>
              <button onClick={connDisconnect} className="text-[10px] text-danger/80 hover:text-danger shrink-0 ml-1">
                断开
              </button>
            </div>
          )}

          <Field label="服务地址">
            <input value={connServerInput} onChange={e => setConnServerInput(e.target.value)}
              className="input-base font-mono" placeholder="http://192.168.1.10:9830" />
          </Field>
          <Field label="访问 Token（可选）">
            <input type="password" value={connTokenInput} onChange={e => setConnTokenInput(e.target.value)}
              className="input-base font-mono" placeholder="留空则不启用鉴权" />
          </Field>

          {connError && (
            <div className="rounded-lg border border-danger/30 bg-danger-faint px-2.5 py-2 text-[11px] text-danger">
              {connError}
            </div>
          )}

          <button onClick={connSave} disabled={connChecking || !connServerInput.trim()}
            className="w-full rounded-[10px] bg-primary py-2.5 text-sm font-medium text-background-base disabled:opacity-40 transition-opacity hover:opacity-90">
            {connChecking ? "连接中..." : "保存并连接"}
          </button>

          {connConnected && (
            <button onClick={connDisconnect}
              className="w-full rounded-[10px] border border-danger/30 bg-danger/5 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger/10">
              断开连接
            </button>
          )}

          {connHistory.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[10px] text-text-tertiary">最近连接</span>
              {connHistory.map(entry => (
                <div key={entry.url}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background-surface px-2.5 py-2">
                  <button onClick={() => connPickFromHistory(entry)} disabled={connChecking}
                    className="min-w-0 flex-1 text-left">
                    <span className="truncate text-[11px] text-text-primary block">{entry.url}</span>
                    <span className="text-[9px] text-text-tertiary">
                      {entry.tokenMd5 ? "已配 Token" : "无 Token"}
                    </span>
                  </button>
                  <button onClick={() => { removeServerFromHistory(entry.url); reloadConnHistory(); }}
                    className="text-text-tertiary hover:text-danger text-xs shrink-0">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 2. Personal Hub */}
      <section>
        <h3 className="mb-2.5 text-[15px] font-semibold">Personal Hub</h3>
        <div className="space-y-3 rounded-[14px] border border-border bg-background-elevated p-4 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
          <Field label="Supabase URL"><input value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)} className="input-base font-mono" placeholder="https://xxx.supabase.co" /></Field>
          <Field label="Supabase Anon Key"><input type="password" value={supabaseKey} onChange={e => setSupabaseKey(e.target.value)} className="input-base font-mono" placeholder="eyJhbGci..." /></Field>
          <Field label="加密密钥（可选）"><input type="password" value={encKey} onChange={e => setEncKey(e.target.value)} className="input-base font-mono" placeholder="用于笔记描述加密" /></Field>
        </div>
      </section>

      {/* 关于 */}
      <section>
        <h3 className="mb-2.5 text-[15px] font-semibold">关于</h3>
        <div className="rounded-[14px] border border-border bg-background-elevated p-4 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
          <div className="flex justify-between border-b border-border py-1.5 text-xs"><span className="text-text-tertiary">应用</span><span className="font-mono text-text-primary">Polaris Pocket</span></div>
          <div className="flex justify-between border-b border-border py-1.5 text-xs"><span className="text-text-tertiary">版本</span><span className="font-mono text-text-primary">v1.0.0</span></div>
          <div className="flex justify-between border-b border-border py-1.5 text-xs"><span className="text-text-tertiary">分支</span><span className="font-mono text-text-primary">polaris-pocket</span></div>
          <div className="flex justify-between py-1.5 text-xs"><span className="text-text-tertiary">协议</span><span className="font-mono text-text-primary">MIT</span></div>
        </div>
      </section>

      {/* 保存按钮 */}
      <div className="flex gap-2 pb-2">
        <button onClick={saveAll} className="flex-1 rounded-[10px] bg-primary py-2.5 text-sm font-medium text-background-base transition-opacity hover:opacity-90">
          {saved ? "✓ 已保存" : "保存配置"}
        </button>
      </div>

      {showEditor && <ProfileEditor initial={editing} onSave={saveProfile} onClose={() => { setShowEditor(false); setEditing(null); }} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-text-tertiary">{label}</label>
      {children}
    </div>
  );
}

// ============================================================================
// Profile 编辑器（对标主项目 ProfileEditorModal，移动端底部抽屉）
// ============================================================================
function ProfileEditor({ initial, onSave, onClose }: { initial: ModelProfile | null; onSave: (p: ModelProfile) => void; onClose: () => void }) {
  const [name, setName] = useState(initial?.name || "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [apiKey, setApiKey] = useState(initial?.apiKey || "");
  const [model, setModel] = useState(initial?.model || "");
  const [modelOptions, setModelOptions] = useState<string[]>(initial?.modelOptions || []);
  const [wireApi, setWireApi] = useState<WireApi>(initial?.wireApi || "anthropic-messages");
  const [category, setCategory] = useState<ProfileCategory | "">(initial?.category || "");
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow ? String(initial.contextWindow) : "");
  const [showApiKey, setShowApiKey] = useState(false);

  const canSubmit = name.trim() && baseUrl.trim() && model.trim() && apiKey.trim();

  const submit = () => {
    if (!canSubmit) return;
    onSave({
      id: initial?.id || "",
      name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(),
      model: model.trim(),
      modelOptions: [...new Set([model.trim(), ...modelOptions].filter(Boolean))],
      wireApi, category: category || undefined,
      contextWindow: contextWindow ? parseInt(contextWindow, 10) : undefined,
      active: initial?.active,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[88vh] w-full max-w-[430px] overflow-y-auto rounded-t-2xl border border-border bg-background-elevated p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">{initial?.id ? "编辑供应商" : "新建供应商"}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current stroke-2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
        </div>
        <div className="space-y-3">
          <Field label="名称"><input value={name} onChange={e => setName(e.target.value)} className="input-base" placeholder="DeepSeek V4 Pro" /></Field>
          <Field label="Base URL"><input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="input-base font-mono" placeholder="https://api.example.com/v1" /></Field>
          <Field label="API Key">
            <div className="relative">
              <input type={showApiKey ? "text" : "password"} value={apiKey} onChange={e => setApiKey(e.target.value)} className="input-base font-mono pr-9" placeholder="sk-..." />
              <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary">{showApiKey ? "🙈" : "👁"}</button>
            </div>
          </Field>
          <Field label="模型">
            <input value={model} onChange={e => setModel(e.target.value)} className="input-base font-mono" placeholder="gpt-4o" list="pocket-model-list" />
            <datalist id="pocket-model-list">{modelOptions.map(m => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="协议">
            <select value={wireApi} onChange={e => setWireApi(e.target.value as WireApi)} className="input-base">
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="openai-chat-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="分类">
              <select value={category} onChange={e => setCategory(e.target.value as ProfileCategory | "")} className="input-base">
                <option value="">未指定</option>
                <option value="official">官方</option>
                <option value="cn_official">国内官方</option>
                <option value="aggregator">聚合</option>
                <option value="third_party">第三方</option>
                <option value="custom">自定义</option>
              </select>
            </Field>
            <Field label="上下文窗口（token）">
              <input type="number" value={contextWindow} onChange={e => setContextWindow(e.target.value)} className="input-base font-mono" placeholder="200000" />
            </Field>
          </div>
          <Field label="可选模型列表（逗号分隔）">
            <input value={modelOptions.join(", ")} onChange={e => setModelOptions(e.target.value.split(",").map(m => m.trim()).filter(Boolean))} className="input-base font-mono" placeholder="gpt-4o, gpt-4o-mini" />
          </Field>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 rounded-[10px] border border-border py-2.5 text-sm text-text-secondary">取消</button>
            <button onClick={submit} disabled={!canSubmit} className="flex-1 rounded-[10px] bg-primary py-2.5 text-sm font-medium text-background-base disabled:opacity-40">保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
