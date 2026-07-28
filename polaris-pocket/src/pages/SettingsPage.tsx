/** Settings — Pocket 配置页 */
import { useState } from "react";

interface Cfg {
  apiBase: string; apiKey: string; model: string;
  agnesApiBase: string; agnesApiKey: string;
}

export function SettingsPage() {
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return JSON.parse(localStorage.getItem("pocket-config") || "{}"); } catch { return {} as Cfg; }
  });
  const [saved, setSaved] = useState(false);

  const save = () => {
    localStorage.setItem("pocket-config", JSON.stringify(cfg));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const clear = () => {
    localStorage.removeItem("pocket-config");
    setCfg({} as Cfg);
  };

  const update = (k: keyof Cfg, v: string) => setCfg(p => ({ ...p, [k]: v }));

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">设置</h2>

      <section className="rounded-xl border border-border bg-background-elevated p-3 space-y-2">
        <h3 className="text-xs font-semibold text-text-secondary">AI 聊天</h3>
        <label className="block text-xs text-text-tertiary">API 地址</label>
        <input value={cfg.apiBase || ""} onChange={e => update("apiBase", e.target.value)}
          placeholder="https://api.openai.com/v1"
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
        <label className="block text-xs text-text-tertiary">API Key</label>
        <input value={cfg.apiKey || ""} onChange={e => update("apiKey", e.target.value)}
          type="password" placeholder="sk-..."
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
        <label className="block text-xs text-text-tertiary">模型</label>
        <input value={cfg.model || ""} onChange={e => update("model", e.target.value)}
          placeholder="gpt-4o"
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
      </section>

      <section className="rounded-xl border border-border bg-background-elevated p-3 space-y-2">
        <h3 className="text-xs font-semibold text-text-secondary">Agnes 文生图</h3>
        <label className="block text-xs text-text-tertiary">API 地址</label>
        <input value={cfg.agnesApiBase || ""} onChange={e => update("agnesApiBase", e.target.value)}
          placeholder="https://api.example.com/v1"
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
        <label className="block text-xs text-text-tertiary">API Key</label>
        <input value={cfg.agnesApiKey || ""} onChange={e => update("agnesApiKey", e.target.value)}
          type="password" placeholder="api-key..."
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
      </section>

      <div className="flex gap-2">
        <button onClick={save} className="flex-1 rounded bg-primary px-3 py-2 text-sm text-background-base">
          {saved ? "✓ 已保存" : "保存配置"}
        </button>
        <button onClick={clear} className="rounded border border-border px-3 py-2 text-sm text-text-secondary">清除</button>
      </div>
    </div>
  );
}