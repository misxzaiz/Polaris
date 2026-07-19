/**
 * Agent Gallery 面板(P1-3)
 *
 * 浏览/搜索/筛选 Agency Agents corpus(267 位专家),动作:
 * - 「设为当前专家」→ sessionConfigStore.setAgent(slug)(L0 用户显式指定)
 * - 「复制派发命令」→ 剪贴板写入 `/dispatch <slug> ` 模板
 */

import { useEffect, useMemo, useState } from 'react';
import { VirtuosoGrid } from 'react-virtuoso';
import { Check, Copy, Search, UserCheck } from 'lucide-react';
import { useAgentStore } from '@/stores/agentStore';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import type { AgentCatalogEntry } from '@/types/agent';

function AgentCard({ agent }: { agent: AgentCatalogEntry }) {
  const setAgent = useSessionConfig((s) => s.setAgent);
  const currentAgent = useSessionConfig((s) => s.config.agent);
  const divisions = useAgentStore((s) => s.divisions);
  const [copied, setCopied] = useState(false);
  const isCurrent = currentAgent === agent.slug;
  const divisionLabel = divisions[agent.division]?.label ?? agent.division;

  const copyDispatch = async () => {
    try {
      await navigator.clipboard.writeText(`/dispatch ${agent.slug} `);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默
    }
  };

  return (
    <div
      className={`flex h-full flex-col rounded-lg border p-3 transition-colors ${
        isCurrent ? 'border-primary/60 bg-primary/5' : 'border-border-subtle hover:border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">{agent.emoji || '🤖'}</span>
        <span className="truncate text-sm font-medium" title={agent.name}>
          {agent.name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-text-muted">{divisionLabel}</span>
      </div>
      <p className="mt-2 line-clamp-2 flex-1 text-xs leading-relaxed text-text-muted" title={agent.description}>
        {agent.description}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setAgent(isCurrent ? '' : agent.slug)}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
            isCurrent
              ? 'border-primary/60 text-primary'
              : 'border-border-subtle text-text-secondary hover:border-border hover:text-text-primary'
          }`}
        >
          <UserCheck size={12} />
          {isCurrent ? '取消当前' : '设为当前'}
        </button>
        <button
          type="button"
          onClick={copyDispatch}
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-secondary transition-colors hover:border-border hover:text-text-primary"
          title={`复制 /dispatch ${agent.slug}`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '派发'}
        </button>
      </div>
    </div>
  );
}

export default function AgentGalleryPanel() {
  const { loaded, loading, error, load, search, setSearch, division, setDivision, divisions, catalog } =
    useAgentStore();
  // 不能用 useAgentStore((s) => s.filtered()):每次返回新数组引用会触发无限重渲染。
  // 从原始状态 useMemo 派生。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter(
      (a) =>
        (!division || a.division === division) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)),
    );
  }, [catalog, search, division]);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const divisionEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of catalog) counts.set(a.division, (counts.get(a.division) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [catalog]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
        <div className="flex items-center gap-2 rounded-md border border-border-subtle px-2 py-1.5">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`搜索 ${catalog.length} 位专家…`}
            className="w-full bg-transparent text-xs outline-none placeholder:text-text-muted"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setDivision(null)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              division === null ? 'border-primary/60 text-primary' : 'border-border-subtle text-text-muted'
            }`}
          >
            全部 {catalog.length}
          </button>
          {divisionEntries.map(([key, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDivision(division === key ? null : key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                division === key ? 'border-primary/60 text-primary' : 'border-border-subtle text-text-muted'
              }`}
            >
              {divisions[key]?.label ?? key} {count}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-warning">
          catalog 加载失败:{error}
        </div>
      )}
      {loading && !loaded && <div className="px-3 py-2 text-xs text-text-muted">加载中…</div>}

      <div className="flex-1 overflow-hidden">
        <VirtuosoGrid
          totalCount={filtered.length}
          listClassName="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2"
          itemContent={(index) => <AgentCard agent={filtered[index]} />}
        />
      </div>
    </div>
  );
}
