/** Todo — 离线待办管理 */
import { useState } from "react";

interface Todo { id: string; text: string; done: boolean; ts: number; }

export function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try { return JSON.parse(localStorage.getItem("pocket-todos") || "[]"); } catch { return []; }
  });
  const [text, setText] = useState("");

  const sync = (items: Todo[]) => {
    setTodos(items);
    localStorage.setItem("pocket-todos", JSON.stringify(items));
  };

  const add = () => {
    const t = text.trim(); if (!t) return;
    sync([{ id: Date.now().toString(), text: t, done: false, ts: Date.now() }, ...todos]);
    setText("");
  };

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">待办</h2>
      <div className="flex gap-1.5">
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          className="flex-1 rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" placeholder="新待办..." />
        <button onClick={add} className="rounded bg-primary px-3 py-2 text-sm text-background-base">+</button>
      </div>
      <div className="space-y-1.5">
        {todos.length === 0 && <p className="text-xs text-text-tertiary">暂无待办</p>}
        {todos.map(t => (
          <div key={t.id} className="flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-3 py-2">
            <button className="shrink-0" onClick={() => sync(todos.map(x => x.id === t.id ? { ...x, done: !x.done } : x))}
              style={t.done ? { color: "var(--success, #a6e3a1)" } : undefined}>
              {t.done ? "✓" : "○"}
            </button>
            <span className={`flex-1 text-sm ${t.done ? "line-through text-text-tertiary" : ""}`}>{t.text}</span>
            <button className="text-text-tertiary hover:text-danger" onClick={() => sync(todos.filter(x => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
