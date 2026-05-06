import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import { useTerminalScriptStore } from '@/stores/terminalScriptStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('TerminalRunCommandModal');

interface TerminalRunCommandModalProps {
  workspacePath: string | null;
  onClose: () => void;
}

export function TerminalRunCommandModal({ workspacePath, onClose }: TerminalRunCommandModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scripts = useTerminalScriptStore((state) => state.scripts);
  const runScript = useTerminalScriptStore((state) => state.runScript);
  const createCustomScript = useTerminalScriptStore((state) => state.createCustomScript);
  const createSession = useTerminalStore((state) => state.createSession);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const lower = query.trim().toLowerCase();
    if (!lower) return scripts.slice(0, 20);
    return scripts
      .filter((script) => script.name.toLowerCase().includes(lower) || script.command.toLowerCase().includes(lower))
      .slice(0, 20);
  }, [query, scripts]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const runTemporaryCommand = async (save: boolean) => {
    const command = query.trim();
    if (!command) return;
    if (save) {
      const name = window.prompt('保存为自定义命令名称', command.split(/\s+/).slice(0, 3).join(' '));
      if (!name) return;
      await createCustomScript({ name, command, cwd: workspacePath || undefined });
      const created = useTerminalScriptStore.getState().scripts.find((script) => script.name === name && script.command === command);
      if (created) await runScript(created.id);
    } else {
      await createSession({
        name: `临时命令 ${new Date().toLocaleTimeString()}`,
        cwd: workspacePath || undefined,
        initialCommand: command,
        purpose: 'script',
      });
    }
    onClose();
  };

  const runSelected = async (saveTemporary: boolean) => {
    const selected = matches[selectedIndex];
    try {
      if (selected) {
        await runScript(selected.id);
        onClose();
        return;
      }
      await runTemporaryCommand(saveTemporary);
    } catch (e) {
      log.error('Failed to run command', e instanceof Error ? e : new Error(String(e)));
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center pt-[12vh]" onMouseDown={onClose}>
      <div
        className="w-[min(720px,92vw)] bg-background-elevated border border-border rounded-lg shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="h-11 px-3 border-b border-border flex items-center gap-2">
          <Play size={16} className="text-text-secondary" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-sm text-text-primary"
            value={query}
            placeholder="搜索脚本，或输入临时命令"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex((index) => Math.max(index - 1, 0));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                runSelected(e.ctrlKey || e.metaKey).catch(() => {});
              }
            }}
          />
          <button className="h-8 w-8 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover rounded" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {matches.length > 0 ? matches.map((script, index) => (
            <button
              key={script.id}
              className={`w-full px-3 py-2 text-left ${index === selectedIndex ? 'bg-background-hover' : 'hover:bg-background-hover'}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => runScript(script.id).then(onClose).catch((e) => log.error('Failed to run script', e instanceof Error ? e : new Error(String(e))))}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-text-primary truncate">{script.name}</span>
                <span className="text-xs text-text-tertiary shrink-0">{script.source === 'user' ? '自定义' : script.source}</span>
              </div>
              <div className="mt-1 text-xs text-text-tertiary font-mono truncate">{script.command}</div>
            </button>
          )) : (
            <div className="px-3 py-6 text-sm text-text-secondary">
              按 Enter 直接运行临时命令，按 Ctrl/Cmd+Enter 保存为自定义命令并运行。
            </div>
          )}
        </div>

        <div className="h-9 px-3 border-t border-border flex items-center justify-between text-xs text-text-tertiary">
          <span>Enter 运行 · Ctrl/Cmd+Enter 保存并运行 · Esc 关闭</span>
          {query.trim() && matches.length === 0 && (
            <button className="h-7 px-2 flex items-center gap-1 text-text-secondary hover:text-text-primary hover:bg-background-hover rounded" onClick={() => runTemporaryCommand(true).catch(() => {})}>
              <Plus size={13} />保存并运行
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
