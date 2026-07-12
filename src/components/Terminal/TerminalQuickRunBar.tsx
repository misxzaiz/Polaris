import { ChevronDown, ChevronUp, Play, Search, Square } from 'lucide-react';
import { useTerminalScriptStore } from '@/stores/terminalScriptStore';
import type { TerminalScript } from '@/types/terminalScript';

interface TerminalQuickRunBarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenRunner: () => void;
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'success':
      return '成功';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已停止';
    default:
      return '未运行';
  }
}

function selectRecentScript(scripts: TerminalScript[], runtimes: ReturnType<typeof useTerminalScriptStore.getState>['runtimes']) {
  const running = scripts.find((script) => runtimes[script.id]?.status === 'running');
  if (running) return running;
  return [...scripts].sort((a, b) => (runtimes[b.id]?.lastRunAt ?? 0) - (runtimes[a.id]?.lastRunAt ?? 0))[0] ?? null;
}

export function TerminalQuickRunBar({ collapsed, onToggleCollapsed, onOpenRunner }: TerminalQuickRunBarProps) {
  const scripts = useTerminalScriptStore((state) => state.scripts);
  const runtimes = useTerminalScriptStore((state) => state.runtimes);
  const runScript = useTerminalScriptStore((state) => state.runScript);
  const stopScript = useTerminalScriptStore((state) => state.stopScript);
  const script = selectRecentScript(scripts, runtimes);
  const runtime = script ? runtimes[script.id] : undefined;

  return (
    <div className="h-9 px-2 shrink-0 border-b border-[#3c3c3c] bg-[#252526] flex items-center gap-2">
      <button
        className="h-7 w-7 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded"
        onClick={onToggleCollapsed}
        title={collapsed ? '展开脚本中心' : '折叠脚本中心'}
      >
        {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-primary truncate">{script ? script.name : '无可运行脚本'}</div>
        <div className="text-[10px] text-text-tertiary font-mono truncate">{script ? script.command : '按 Ctrl+Shift+R 输入临时命令'}</div>
      </div>
      <span className="w-12 text-xs text-text-tertiary text-right">{statusLabel(runtime?.status)}</span>
      <button
        className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded disabled:opacity-50"
        disabled={!script || runtime?.status === 'running'}
        onClick={() => script && runScript(script.id)}
        title="运行最近脚本"
      >
        <Play size={13} />运行
      </button>
      <button
        className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded disabled:opacity-50"
        disabled={!script || runtime?.status !== 'running'}
        onClick={() => script && stopScript(script.id)}
        title="停止脚本"
      >
        <Square size={13} />停止
      </button>
      <button
        className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded"
        onClick={onOpenRunner}
        title="快速运行 Ctrl+Shift+R"
      >
        <Search size={13} />快速运行
      </button>
    </div>
  );
}
