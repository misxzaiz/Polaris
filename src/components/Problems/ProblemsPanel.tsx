/**
 * Problems 面板：聚合全工作区的 LSP 诊断。
 *
 * 数据来自 `diagnosticsStore`。点击条目会通过 `fileEditorStore.openFileAtPosition`
 * 跳转到对应文件的对应行列。
 */

import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Lightbulb, ChevronRight, ChevronDown } from 'lucide-react';
import { useDiagnosticsStore, type DiagnosticItem } from '@/stores/diagnosticsStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';

/** LSP URI → 本地路径 */
function uriToPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file:///')) p = p.slice(8);
  else if (p.startsWith('file://')) p = p.slice(7);
  try { p = decodeURIComponent(p); } catch { /* ignore */ }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p.replace(/\//g, '\\');
}

function fileNameOf(path: string): string {
  const m = path.split(/[\\/]/).pop();
  return m || path;
}

/** LSP severity → 图标 + 颜色 + 排序权重（error 靠前） */
function severityMeta(sev: number | undefined) {
  switch (sev) {
    case 1: return { Icon: AlertCircle, color: 'text-red-400', weight: 0, label: 'Error' };
    case 2: return { Icon: AlertTriangle, color: 'text-yellow-400', weight: 1, label: 'Warning' };
    case 3: return { Icon: Info, color: 'text-blue-400', weight: 2, label: 'Info' };
    case 4: return { Icon: Lightbulb, color: 'text-text-tertiary', weight: 3, label: 'Hint' };
    default: return { Icon: AlertCircle, color: 'text-red-400', weight: 0, label: 'Error' };
  }
}

export function ProblemsPanel() {
  // 订阅 version 以便诊断变化时重渲染（Map 本身是同引用，直接订阅 byUri 不会触发）
  useDiagnosticsStore((s) => s.version);
  const byUri = useDiagnosticsStore((s) => s.byUri);
  const summary = useDiagnosticsStore((s) => s.summary);

  // 默认展开所有文件
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const list: Array<{ uri: string; path: string; items: DiagnosticItem[] }> = [];
    for (const [uri, items] of byUri.entries()) {
      if (items.length === 0) continue;
      list.push({ uri, path: uriToPath(uri), items });
    }
    // 按路径字母序
    list.sort((a, b) => a.path.localeCompare(b.path));
    return list;
  }, [byUri]);

  const toggleCollapsed = (uri: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  };

  const handleJump = async (uri: string, item: DiagnosticItem) => {
    const path = uriToPath(uri);
    const name = fileNameOf(path);
    const line = item.range.start.line + 1; // LSP 0-indexed → 1-indexed
    const col = item.range.start.character;
    try {
      await useFileEditorStore.getState().openFileAtPosition(path, name, line, col);
    } catch {
      /* 打开失败静默忽略 */
    }
  };

  return (
    <div className="flex flex-col h-full bg-background-elevated">
      {/* 头部：汇总 */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border text-xs">
        <span className="text-text-tertiary uppercase tracking-wide">Problems</span>
        <span className="flex items-center gap-1 text-red-400">
          <AlertCircle className="w-3 h-3" /> {summary.errors}
        </span>
        <span className="flex items-center gap-1 text-yellow-400">
          <AlertTriangle className="w-3 h-3" /> {summary.warnings}
        </span>
        {summary.infos > 0 && (
          <span className="flex items-center gap-1 text-blue-400">
            <Info className="w-3 h-3" /> {summary.infos}
          </span>
        )}
        {summary.hints > 0 && (
          <span className="flex items-center gap-1 text-text-tertiary">
            <Lightbulb className="w-3 h-3" /> {summary.hints}
          </span>
        )}
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary text-sm">
            <AlertCircle className="w-5 h-5 mb-2 opacity-50" />
            暂无诊断
          </div>
        ) : (
          groups.map((g) => {
            const isCollapsed = collapsed.has(g.uri);
            const ChevIcon = isCollapsed ? ChevronRight : ChevronDown;
            return (
              <div key={g.uri} className="border-b border-border/50 last:border-b-0">
                <button
                  className="w-full flex items-center gap-1 px-3 py-1.5 hover:bg-background-hover text-left text-xs"
                  onClick={() => toggleCollapsed(g.uri)}
                >
                  <ChevIcon className="w-3 h-3 text-text-tertiary flex-shrink-0" />
                  <span className="text-text-primary font-medium truncate">{fileNameOf(g.path)}</span>
                  <span className="text-text-tertiary truncate min-w-0 flex-1">{g.path}</span>
                  <span className="text-text-tertiary">{g.items.length}</span>
                </button>
                {!isCollapsed && (
                  <div>
                    {g.items.map((item, idx) => {
                      const meta = severityMeta(item.severity);
                      const Icon = meta.Icon;
                      return (
                        <button
                          key={`${g.uri}-${idx}`}
                          className="w-full flex items-start gap-2 px-6 py-1 hover:bg-background-hover text-left"
                          onClick={() => handleJump(g.uri, item)}
                        >
                          <Icon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${meta.color}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-text-primary truncate">{item.message}</div>
                            <div className="text-[10px] text-text-tertiary flex items-center gap-2 mt-0.5">
                              <span>Ln {item.range.start.line + 1}, Col {item.range.start.character + 1}</span>
                              {item.source && <span>· {item.source}</span>}
                              {item.code != null && <span>· {String(item.code)}</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
