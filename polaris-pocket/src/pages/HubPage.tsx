/** Hub — 笔记 + 书签聚合页 */
import { useState, useEffect } from "react";

interface Note { id: string; title: string; body: string; ts: number; }

export function HubPage() {
  const [notes, setNotes] = useState<Note[]>(() => {
    try { return JSON.parse(localStorage.getItem("pocket-hub-notes") || "[]"); } catch { return []; }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const save = () => {
    const item = { id: selected || Date.now().toString(), title: title.trim() || "无题", body, ts: Date.now() };
    const n = selected ? notes.map(x => x.id === selected ? item : x) : [item, ...notes];
    setNotes(n);
    localStorage.setItem("pocket-hub-notes", JSON.stringify(n));
    reset();
  };
  const reset = () => { setSelected(null); setTitle(""); setBody(""); };
  const load = (n: Note) => { setSelected(n.id); setTitle(n.title); setBody(n.body); };

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">个人空间</h2>
      <div className="space-y-1.5">
        {notes.length === 0 && <p className="text-xs text-text-tertiary">还没有笔记</p>}
        {notes.map(n => (
          <button key={n.id} onClick={() => load(n)}
            className={`w-full rounded-lg border border-border px-3 py-2 text-left ${selected === n.id ? "bg-primary/10 border-primary" : "bg-background-elevated"}`}>
            <span className="block text-sm">{n.title}</span>
            <span className="block text-[10px] text-text-tertiary">{n.body.slice(0, 50)}{n.body.length > 50 ? "..." : ""}</span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="mt-2 rounded-xl border border-border bg-background-elevated p-3 space-y-2">
          <input value={title} onChange={e => setTitle(e.target.value)} className="w-full rounded border border-border bg-background-surface px-2 py-1.5 text-sm outline-none" placeholder="标题" />
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} className="w-full resize-none rounded border border-border bg-background-surface px-2 py-1.5 text-sm outline-none" placeholder="内容" />
          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="rounded border border-border px-3 py-1.5 text-xs">取消</button>
            <button onClick={save} className="rounded bg-primary px-3 py-1.5 text-xs text-background-base">保存</button>
          </div>
        </div>
      )}
    </div>
  );
}
