/**
 * SpacePage — 个人空间（真实 Supabase 云同步）
 *
 * 与主项目 Personal Hub 共享同一 Supabase 后端、同一 links 表、同一份数据。
 * - 未登录 → LoginCard（Supabase auth 登录/注册）
 * - 已登录 → LinksView（搜索/类型 Tab/高级筛选/LinkCard/分页/FAB/编辑器）
 *
 * 数据模型与主项目 src/services/personalHub/types.ts 一致。
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { getSupabase, isSupabaseConfigured, getPersonalHubConfig } from "../services/supabaseClient";
import type { Session } from "@supabase/supabase-js";

type LinkType = "navigation" | "bookmark" | "todo" | "note";
type Priority = "low" | "medium" | "high";

interface Link {
  id: string;
  user_id: string;
  title: string;
  url?: string;
  description?: string;
  type: LinkType;
  tags?: string[];
  completed?: boolean;
  priority?: Priority;
  due_date?: string;
  is_encrypted?: boolean;
  icon?: string;
  created_at: string;
  updated_at: string;
}

const STORAGE_KEY = "pocket-hub-session";
const TYPE_LABELS: Record<LinkType, string> = { navigation: "导航", bookmark: "书签", todo: "待办", note: "笔记" };
const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const PRIORITY_COLOR: Record<Priority, string> = { high: "#f38ba8", medium: "#f9e2af", low: "#a6e3a1" };
const TYPE_TABS: { value: LinkType | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "navigation", label: "导航" },
  { value: "bookmark", label: "书签" },
  { value: "todo", label: "待办" },
  { value: "note", label: "笔记" },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SpacePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [configured] = useState(() => isSupabaseConfigured());

  useEffect(() => {
    if (!configured) { setAuthLoading(false); return; }
    const supabase = getSupabase();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s) localStorage.setItem(STORAGE_KEY, "1"); else localStorage.removeItem(STORAGE_KEY);
    });
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  if (authLoading) return <div className="py-10 text-center text-xs text-text-tertiary">加载中...</div>;
  if (!configured) return <UnconfiguredCard />;
  if (!session) return <LoginCard />;
  return <LinksView session={session} />;
}

// ============================================================================
// 未配置
// ============================================================================
function UnconfiguredCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-background-elevated px-5 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <svg viewBox="0 0 24 24" className="h-7 w-7 fill-none stroke-current stroke-[1.6px]" strokeLinejoin="round"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" /></svg>
      </div>
      <h3 className="text-[15px] font-semibold">个人空间</h3>
      <p className="max-w-[260px] text-xs leading-relaxed text-text-tertiary">基于 Supabase 云同步。请在「设置 → Personal Hub」填写 URL 与 anon key 后使用。</p>
    </div>
  );
}

// ============================================================================
// 登录卡
// ============================================================================
function LoginCard() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setInfo(null);
    if (!EMAIL_RE.test(email)) { setError("邮箱格式不正确"); return; }
    if (password.length < 6) { setError("密码长度至少 6 位"); return; }
    setLoading(true);
    const supabase = getSupabase();
    try {
      if (tab === "register") {
        if (password !== confirm) { setError("两次输入的密码不一致"); setLoading(false); return; }
        const { error: err } = await supabase.auth.signUp({ email, password });
        if (err) setError(err.message);
        else { setInfo("注册成功，请查收验证邮件后登录"); setTab("login"); }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-[17px] font-semibold">个人空间</h2>
        <p className="mt-1 text-xs text-text-tertiary">登录以同步你的导航、书签与待办</p>
      </div>
      <div className="flex rounded-[10px] bg-background-surface p-1">
        {(["login", "register"] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setError(null); setInfo(null); }} className={`flex-1 rounded-[8px] py-1.5 text-xs font-medium transition-colors ${tab === t ? "bg-background-elevated text-text-primary shadow-sm" : "text-text-secondary"}`}>
            {t === "login" ? "登录" : "注册"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">邮箱</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" className="input-base" disabled={loading} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">密码</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 6 位" autoComplete={tab === "login" ? "current-password" : "new-password"} className="input-base" disabled={loading} />
        </div>
        {tab === "register" && (
          <div>
            <label className="mb-1 block text-xs text-text-secondary">确认密码</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="再次输入密码" autoComplete="new-password" className="input-base" disabled={loading} />
          </div>
        )}
        {error && <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
        {info && <div className="rounded-md border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">{info}</div>}
        <button type="submit" disabled={loading} className="w-full rounded-[10px] bg-primary py-2 text-sm font-medium text-background-base transition-opacity hover:opacity-90 disabled:opacity-50">
          {loading ? "处理中..." : tab === "login" ? "登录" : "注册"}
        </button>
      </form>
    </div>
  );
}

// ============================================================================
// LinksView（对标主项目 LinksView，移动版）
// ============================================================================
function LinksView({ session }: { session: Session }) {
  const userId = session.user.id;
  const email = session.user.email || "个人空间";

  const [links, setLinks] = useState<Link[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<LinkType | "all">("all");
  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<Priority | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed">("all");
  const [sortBy, setSortBy] = useState<"created_at" | "updated_at" | "title" | "priority" | "due_date">("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [editing, setEditing] = useState<Link | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const fetchTags = useCallback(async () => {
    try {
      const { data, error: e } = await getSupabase().from("links").select("tags").eq("user_id", userId).not("tags", "is", null);
      if (e) throw e;
      const counts: Record<string, number> = {};
      (data || []).forEach((item: { tags?: string[] | null }) => (item.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
      setAllTags(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t]) => t));
    } catch { /* tags 非关键 */ }
  }, [userId]);

  const fetchLinks = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let query = getSupabase().from("links").select("*", { count: "exact" }).eq("user_id", userId);
      if (filterType !== "all") query = query.eq("type", filterType);
      if (selectedTags.length > 0) query = query.contains("tags", selectedTags);
      if (selectedPriority !== "all") query = query.in("priority", [selectedPriority]);
      if (statusFilter === "pending") query = query.eq("completed", false);
      else if (statusFilter === "completed") query = query.eq("completed", true);
      const term = search.trim();
      if (term) query = query.or(`title.ilike.%${term}%,description.ilike.%${term}%`);
      query = query.order(sortBy, { ascending: sortOrder === "asc" });
      const from = (page - 1) * pageSize, to = from + pageSize - 1;
      query = query.range(from, to);
      const { data, count, error: e } = await query;
      if (e) throw e;
      setLinks((data || []) as Link[]);
      setTotalCount(count || 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [userId, filterType, selectedTags, selectedPriority, statusFilter, search, sortBy, sortOrder, page, pageSize]);

  useEffect(() => { void fetchLinks(); }, [fetchLinks]);
  useEffect(() => { void fetchTags(); }, [fetchTags]);

  const signOut = async () => { await getSupabase().auth.signOut(); };

  const toggleComplete = async (l: Link) => {
    try {
      const { error: e } = await getSupabase().from("links").update({ completed: !l.completed }).eq("id", l.id);
      if (e) throw e;
      setLinks(prev => prev.map(x => x.id === l.id ? { ...x, completed: !x.completed } : x));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const removeLink = async (id: string) => {
    if (!confirm("确定删除这条记录吗？")) return;
    try {
      const { error: e } = await getSupabase().from("links").delete().eq("id", id);
      if (e) throw e;
      await Promise.all([fetchLinks(), fetchTags()]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const saveLink = async (l: Partial<Link> & { id?: string }) => {
    setError(null);
    try {
      if (l.id) {
        const { id: _id, ...patch } = l;
        const { error: e } = await getSupabase().from("links").update(patch).eq("id", l.id);
        if (e) throw e;
      } else {
        const { error: e } = await getSupabase().from("links").insert({ ...l, user_id: userId });
        if (e) throw e;
      }
      setShowEditor(false); setEditing(null);
      await Promise.all([fetchLinks(), fetchTags()]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const toggleTag = (t: string) => setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  return (
    <div className="relative flex h-full flex-col">
      {/* 顶栏 */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-gradient-to-br from-primary to-[#89b4fa] text-[12px] font-bold text-background-base">{email[0]?.toUpperCase()}</span>
          <span className="truncate max-w-[180px]">{email}</span>
        </div>
        <div className="flex gap-1">
          <button onClick={() => { void fetchLinks(); void fetchTags(); }} className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-background-surface text-text-secondary transition-colors hover:bg-border" title="刷新">
            <svg viewBox="0 0 24 24" className={`h-4 w-4 fill-none stroke-current stroke-2 ${loading ? "animate-spin" : ""}`} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.6-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.6 6.3L3 16M3 21v-5h5" /></svg>
          </button>
          <button onClick={signOut} className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-background-surface text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger" title="登出">
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          </button>
        </div>
      </div>

      {error && <div className="mb-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {/* 搜索 */}
      <div className="relative mb-3">
        <svg viewBox="0 0 24 24" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 fill-none stroke-text-tertiary stroke-2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="搜索标题、描述..." className="w-full rounded-[10px] border border-border bg-background-surface py-2 pl-9 pr-3 text-[13px] text-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-text-tertiary focus:border-primary focus:shadow-[0_0_0_3px_rgba(203,166,247,0.12)]" />
      </div>

      {/* 类型 Tab */}
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {TYPE_TABS.map(t => (
          <button key={t.value} onClick={() => { setFilterType(t.value); setPage(1); }} className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-all ${filterType === t.value ? "border-primary bg-primary text-background-base" : "border-border bg-background-surface text-text-secondary hover:bg-border"}`}>{t.label}</button>
        ))}
      </div>

      {/* 高级筛选 */}
      <button onClick={() => setShowAdvanced(!showAdvanced)} className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-background-surface px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-border">
        <svg viewBox="0 0 24 24" className={`h-3 w-3 fill-none stroke-current stroke-2 transition-transform ${showAdvanced ? "rotate-180" : ""}`} strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        高级筛选
        {(selectedTags.length > 0 || selectedPriority !== "all" || statusFilter !== "all") && <span className="ml-0.5 rounded-full bg-primary px-1 text-[9px] leading-tight text-background-base">{selectedTags.length + (selectedPriority !== "all" ? 1 : 0) + (statusFilter !== "all" ? 1 : 0)}</span>}
      </button>
      {showAdvanced && (
        <div className="mb-3 rounded-xl border border-border bg-background-elevated p-3">
          {allTags.length > 0 && (
            <div className="mb-2.5">
              <div className="mb-1.5 text-[10px] font-medium text-text-tertiary">标签</div>
              <div className="flex flex-wrap gap-1">
                {allTags.slice(0, 12).map(t => (
                  <button key={t} onClick={() => toggleTag(t)} className={`rounded-full px-2 py-0.5 text-[10px] transition-all ${selectedTags.includes(t) ? "bg-primary/15 text-primary" : "border border-border bg-background-surface text-text-secondary hover:bg-border"}`}>#{t}</button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1.5 text-[10px] font-medium text-text-tertiary">优先级</div>
              <div className="flex flex-wrap gap-1">
                {(["all", "high", "medium", "low"] as const).map(p => (
                  <button key={p} onClick={() => setSelectedPriority(p)} className="rounded-full px-2 py-0.5 text-[10px] transition-all" style={selectedPriority === p && p !== "all" ? { backgroundColor: PRIORITY_COLOR[p], color: "#1a1a2e" } : selectedPriority === p ? { backgroundColor: "var(--primary, #cba6f7)", color: "#1e1e2e" } : undefined}>
                    <span className={selectedPriority === p ? "" : "border border-border bg-background-surface rounded-full px-2 py-0.5"}>{p === "all" ? "全部" : PRIORITY_LABEL[p]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] font-medium text-text-tertiary">状态</div>
              <div className="flex flex-wrap gap-1">
                {(["all", "pending", "completed"] as const).map(s => (
                  <button key={s} onClick={() => setStatusFilter(s)} className={`rounded-full px-2 py-0.5 text-[10px] transition-all ${statusFilter === s ? "bg-primary text-background-base" : "border border-border bg-background-surface text-text-secondary hover:bg-border"}`}>{s === "all" ? "全部" : s === "pending" ? "待办" : "完成"}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 排序行 */}
      <div className="mb-3 flex items-center justify-between text-[11px]">
        <span className="font-mono text-text-tertiary">共 {totalCount} 条</span>
        <div className="flex gap-1">
          {(["created_at", "updated_at", "title", "priority", "due_date"] as const).map(s => (
            <button key={s} onClick={() => setSortBy(s)} className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${sortBy === s ? "font-medium text-primary" : "text-text-tertiary hover:text-text-secondary"}`}>
              {s === "created_at" ? "创建" : s === "updated_at" ? "更新" : s === "title" ? "标题" : s === "priority" ? "优先级" : "截止"}
              {sortBy === s && (sortOrder === "asc" ? " ↑" : " ↓")}
            </button>
          ))}
          <button onClick={() => setSortOrder(o => o === "asc" ? "desc" : "asc")} className="ml-1 rounded px-1 py-0.5 text-[10px] text-text-tertiary hover:text-text-primary">⇅</button>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 space-y-2.5">
        {loading && links.length === 0 && <div className="py-10 text-center text-[11px] text-text-tertiary">加载中...</div>}
        {!loading && links.length === 0 && !error && <div className="py-10 text-center text-xs text-text-tertiary">暂无记录，点击「+」添加</div>}
        {links.map(l => <LinkCard key={l.id} link={l} onEdit={l2 => { setEditing(l2); setShowEditor(true); }} onDelete={removeLink} onToggleComplete={toggleComplete} />)}
      </div>

      {/* 分页 */}
      {totalCount > 0 && (
        <div className="mt-3 flex items-center justify-between text-[11px] text-text-tertiary">
          <span>{page} / {totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="flex h-6 w-6 items-center justify-center rounded bg-background-surface transition-colors hover:bg-border disabled:opacity-30">
              <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="flex h-6 w-6 items-center justify-center rounded bg-background-surface transition-colors hover:bg-border disabled:opacity-30">
              <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* FAB */}
      <button onClick={() => { setEditing(null); setShowEditor(true); }} className="absolute bottom-4 right-4 z-20 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-background-base shadow-[0_8px_28px_rgba(0,0,0,0.28)] transition-transform hover:scale-110 hover:rotate-90" title="新增">
        <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-none stroke-current stroke-[2.4px]" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>

      {showEditor && <LinkEditor link={editing} onSave={saveLink} onClose={() => { setShowEditor(false); setEditing(null); }} />}
    </div>
  );
}

// ============================================================================
// LinkCard（对标主项目 PersonalHub/LinkCard.tsx）
// ============================================================================
function LinkCard({ link, onEdit, onDelete, onToggleComplete }: { link: Link; onEdit: (l: Link) => void; onDelete: (id: string) => void; onToggleComplete: (l: Link) => void }) {
  const overdue = link.due_date && !link.completed && new Date(link.due_date).getTime() < Date.now();
  const tags = (link.tags ?? []).slice(0, 4);
  const encKey = getPersonalHubConfig().encryptionKey.trim().length > 0;
  const TypeIcon = { navigation: Compass, bookmark: Star, todo: ListChecks, note: LinkIcon }[link.type];

  return (
    <div className="flex gap-2.5 rounded-xl border border-border bg-background-elevated p-3 transition-[border-color,box-shadow] hover:border-primary hover:shadow-[0_2px_8px_rgba(0,0,0,0.18)]">
      <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary/10 text-primary">
        <TypeIcon />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${link.completed ? "text-text-tertiary line-through" : "text-text-primary"}`}>
          {link.type === "todo" && <input type="checkbox" checked={!!link.completed} onChange={() => onToggleComplete(link)} className="accent-primary" />}
          <span className="truncate">{link.title}</span>
          {link.is_encrypted && encKey && <svg viewBox="0 0 24 24" className="h-[11px] w-[11px] fill-none stroke-text-tertiary stroke-2" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>}
        </div>
        {link.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">{link.description}</p>}
        {link.url && (
          <a href={link.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-primary hover:underline">
            <svg viewBox="0 0 24 24" className="h-[11px] w-[11px] fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6M10 14l4-4 4 4M14 10V4" /></svg>
            <span className="truncate">{link.url.replace(/^https?:\/\//, "")}</span>
          </a>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {tags.map(t => <span key={t} className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">#{t}</span>)}
          {link.tags && link.tags.length > 4 && <span className="text-[10px] text-text-muted">+{link.tags.length - 4}</span>}
          {link.priority && <span className="rounded px-1.5 py-0.5 text-[10px] text-background-base" style={{ backgroundColor: PRIORITY_COLOR[link.priority] }}>{PRIORITY_LABEL[link.priority]}</span>}
          {link.due_date && <span className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${overdue ? "text-danger" : "text-text-tertiary"}`}>
            <svg viewBox="0 0 24 24" className="h-[11px] w-[11px] fill-none stroke-current stroke-2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
            {formatRelativeDate(link.due_date)}
          </span>}
          <span className="ml-auto text-[10px] text-text-muted">{TYPE_LABELS[link.type]}</span>
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <button onClick={() => onEdit(link)} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-primary" title="编辑">
          <svg viewBox="0 0 24 24" className="h-[13px] w-[13px] fill-none stroke-current stroke-2" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
        </button>
        <button onClick={() => onDelete(link.id)} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-danger" title="删除">
          <svg viewBox="0 0 24 24" className="h-[13px] w-[13px] fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 编辑器
// ============================================================================
function LinkEditor({ link, onSave, onClose }: { link: Link | null; onSave: (l: Partial<Link> & { id?: string }) => void; onClose: () => void }) {
  const [title, setTitle] = useState(link?.title || "");
  const [url, setUrl] = useState(link?.url || "");
  const [description, setDescription] = useState(link?.description || "");
  const [type, setType] = useState<LinkType>(link?.type || "navigation");
  const [tags, setTags] = useState((link?.tags || []).join(", "));
  const [priority, setPriority] = useState<Priority | "">(link?.priority || "");
  const [due, setDue] = useState(link?.due_date ? link.due_date.slice(0, 10) : "");

  const submit = () => {
    if (!title.trim()) return;
    onSave({
      id: link?.id,
      title: title.trim(),
      url: url.trim() || undefined,
      description: description.trim() || undefined,
      type,
      tags: tags.split(",").map(t => t.trim()).filter(Boolean),
      priority: (priority || undefined) as Priority | undefined,
      due_date: due ? new Date(due).toISOString() : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[85vh] w-full max-w-[430px] overflow-y-auto rounded-t-2xl border border-border bg-background-elevated p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">{link ? "编辑" : "新建"}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current stroke-2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-text-tertiary">类型</label>
            <div className="flex gap-1.5">
              {(["navigation", "bookmark", "todo", "note"] as LinkType[]).map(t => (
                <button key={t} onClick={() => setType(t)} className={`flex-1 rounded-[10px] border py-1.5 text-[11px] transition-all ${type === t ? "border-primary bg-primary/10 text-primary" : "border-border bg-background-surface text-text-secondary"}`}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-tertiary">标题</label>
            <input value={title} onChange={e => setTitle(e.target.value)} className="input-base" placeholder="标题" />
          </div>
          {type !== "note" && type !== "todo" && (
            <div>
              <label className="mb-1 block text-[11px] text-text-tertiary">URL</label>
              <input value={url} onChange={e => setUrl(e.target.value)} className="input-base font-mono" placeholder="https://" />
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] text-text-tertiary">描述</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="w-full resize-none rounded-[10px] border border-border bg-background-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary" placeholder="描述" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] text-text-tertiary">标签（逗号分隔）</label>
              <input value={tags} onChange={e => setTags(e.target.value)} className="input-base font-mono" placeholder="tag1, tag2" />
            </div>
            {type === "todo" && (
              <>
                <div>
                  <label className="mb-1 block text-[11px] text-text-tertiary">优先级</label>
                  <select value={priority} onChange={e => setPriority(e.target.value as Priority | "")} className="input-base">
                    <option value="">无</option>
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-text-tertiary">截止日期</label>
                  <input type="date" value={due} onChange={e => setDue(e.target.value)} className="input-base" />
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 rounded-[10px] border border-border py-2.5 text-sm text-text-secondary">取消</button>
            <button onClick={submit} disabled={!title.trim()} className="flex-1 rounded-[10px] bg-primary py-2.5 text-sm font-medium text-background-base disabled:opacity-40">保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 图标 ----
function Compass() { return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18zM3 12h18" /></svg>; }
function Star() { return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.8px]" strokeLinejoin="round"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" /></svg>; }
function ListChecks() { return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>; }
function LinkIcon() { return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5 4.5l-1-1M14 11a5 5 0 0 0-7.5-4.5l1 1M14 4l-2 2M8 20l2-2" /></svg>; }

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`;
  if (diff <= 7) return `${diff} 天后`;
  return d.toLocaleDateString("zh-CN");
}
