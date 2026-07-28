/** Images — Agnes 文生图页（直连 API） */
import { useState } from "react";

export function ImagesPage() {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [size, setSize] = useState("1024x1024");

  const _generate = async () => {
    const cfg = (() => {
      try { return JSON.parse(localStorage.getItem("pocket-config") || "{}"); } catch { return {}; }
    })();
    if (!prompt.trim() || !cfg.agnesApiBase || !cfg.agnesApiKey) return;
    setGenerating(true);
    try {
      const res = await fetch((cfg.agnesApiBase + "/images/generations").replace(/\/+$/, ""), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.agnesApiKey}` },
        body: JSON.stringify({ prompt: prompt.trim(), size }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
      setResult(data.data?.[0]?.url || data.url || "");
    } catch { /* error */ } finally { setGenerating(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Agnes 文生图</h2>
      <p className="text-[10px] text-text-tertiary">在设置中配置 Agnes API 即可使用</p>
      <div className="rounded-xl border border-border bg-background-elevated p-3 space-y-2">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
          className="w-full resize-none rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none"
          placeholder="描述你想画的内容..." />
        <div className="flex gap-2 items-center">
          <select value={size} onChange={e => setSize(e.target.value)} className="flex-1 rounded border border-border bg-background-surface px-2 py-1.5 text-sm">
            <option value="1024x1024">1024×1024</option>
            <option value="1024x768">1024×768</option>
            <option value="768x1024">768×1024</option>
          </select>
          <button onClick={_generate} disabled={generating || !prompt.trim()}
            className="rounded bg-primary px-4 py-2 text-sm text-background-base disabled:opacity-40">
            {generating ? "生成中..." : "生成"}
          </button>
        </div>
      </div>
      {result && <img src={result} alt="result" className="rounded-xl max-w-full border border-border" />}
    </div>
  );
}
