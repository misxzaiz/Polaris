import { useCallback, useEffect, useMemo, useState } from 'react';
import { EyeOff, Play, Plus, RefreshCw, RotateCcw, Save, Square, Trash2 } from 'lucide-react';
import { useTerminalScriptStore } from '@/stores/terminalScriptStore';
import type { TerminalScript, TerminalScriptAutoRunTrigger } from '@/types/terminalScript';
import { createLogger } from '@/utils/logger';

const log = createLogger('TerminalScriptPanel');

type ScriptTab = 'project' | 'custom';

interface TerminalScriptPanelProps {
  workspacePath: string | null;
}

function isCustomScript(script: TerminalScript): boolean {
  return script.source === 'user' || script.id.startsWith('user:');
}

function parseEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function formatEnv(env?: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
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

export function TerminalScriptPanel({ workspacePath }: TerminalScriptPanelProps) {
  const scripts = useTerminalScriptStore((state) => state.scripts);
  const runtimes = useTerminalScriptStore((state) => state.runtimes);
  const hiddenDiscoveredScriptIds = useTerminalScriptStore((state) => state.hiddenDiscoveredScriptIds);
  const loading = useTerminalScriptStore((state) => state.loading);
  const error = useTerminalScriptStore((state) => state.error);
  const clearError = useTerminalScriptStore((state) => state.clearError);
  const setWorkspace = useTerminalScriptStore((state) => state.setWorkspace);
  const refresh = useTerminalScriptStore((state) => state.refresh);
  const runScript = useTerminalScriptStore((state) => state.runScript);
  const stopScript = useTerminalScriptStore((state) => state.stopScript);
  const saveScript = useTerminalScriptStore((state) => state.saveScript);
  const createCustomScript = useTerminalScriptStore((state) => state.createCustomScript);
  const deleteScript = useTerminalScriptStore((state) => state.deleteScript);
  const restoreHiddenProjectScripts = useTerminalScriptStore((state) => state.restoreHiddenProjectScripts);
  const runAutoScripts = useTerminalScriptStore((state) => state.runAutoScripts);

  const [tab, setTab] = useState<ScriptTab>('project');
  const [query, setQuery] = useState('');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [draft, setDraft] = useState<TerminalScript | null>(null);
  const [draftEnv, setDraftEnv] = useState('');

  useEffect(() => {
    setWorkspace(workspacePath).catch((e) => log.error('Failed to load terminal scripts', e instanceof Error ? e : new Error(String(e))));
  }, [setWorkspace, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    runAutoScripts('terminal_open', workspacePath).catch((e) => log.error('Failed to run terminal auto scripts', e instanceof Error ? e : new Error(String(e))));
  }, [runAutoScripts, workspacePath]);

  const visibleScripts = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return scripts
      .filter((script) => tab === 'custom' ? isCustomScript(script) : !isCustomScript(script))
      .filter((script) => {
        if (!lower) return true;
        return script.name.toLowerCase().includes(lower)
          || script.command.toLowerCase().includes(lower)
          || script.source.toLowerCase().includes(lower);
      });
  }, [query, scripts, tab]);

  const selectedScript = scripts.find((script) => script.id === selectedScriptId)
    ?? visibleScripts[0]
    ?? null;

  useEffect(() => {
    if (visibleScripts.length === 0) {
      setSelectedScriptId('');
      return;
    }
    if (!selectedScriptId || !visibleScripts.some((script) => script.id === selectedScriptId)) {
      setSelectedScriptId(visibleScripts[0].id);
    }
  }, [selectedScriptId, visibleScripts]);

  useEffect(() => {
    if (!selectedScript) {
      setDraft(null);
      setDraftEnv('');
      return;
    }
    setDraft({ ...selectedScript, env: selectedScript.env ?? {} });
    setDraftEnv(formatEnv(selectedScript.env));
  }, [selectedScript]);

  const selectedRuntime = selectedScript ? runtimes[selectedScript.id] : undefined;
  const selectedIsCustom = selectedScript ? isCustomScript(selectedScript) : false;

  const handleRun = useCallback(() => {
    if (!selectedScript) return;
    runScript(selectedScript.id).catch((e) => log.error('Failed to run script', e instanceof Error ? e : new Error(String(e))));
  }, [runScript, selectedScript]);

  const handleStop = useCallback(() => {
    if (!selectedScript) return;
    stopScript(selectedScript.id).catch((e) => log.error('Failed to stop script', e instanceof Error ? e : new Error(String(e))));
  }, [selectedScript, stopScript]);

  const handleCreateCustom = useCallback(() => {
    const name = window.prompt('自定义命令名称');
    if (!name) return;
    const command = window.prompt('执行命令');
    if (!command) return;
    createCustomScript({ name, command, cwd: workspacePath || undefined })
      .then(() => setTab('custom'))
      .catch((e) => log.error('Failed to create custom script', e instanceof Error ? e : new Error(String(e))));
  }, [createCustomScript, workspacePath]);

  const handleSave = useCallback(() => {
    if (!draft) return;
    const next = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
      cwd: draft.cwd?.trim() || workspacePath || undefined,
      env: parseEnv(draftEnv),
    };
    saveScript(next).catch((e) => log.error('Failed to save script', e instanceof Error ? e : new Error(String(e))));
  }, [draft, draftEnv, saveScript, workspacePath]);

  const handleDelete = useCallback(() => {
    if (!selectedScript) return;
    const message = selectedIsCustom
      ? `删除自定义命令：${selectedScript.name}?`
      : `项目脚本来自 ${selectedScript.source}，不会修改源文件。是否从脚本库隐藏：${selectedScript.name}?`;
    if (!window.confirm(message)) return;
    deleteScript(selectedScript.id).catch((e) => log.error('Failed to delete script', e instanceof Error ? e : new Error(String(e))));
  }, [deleteScript, selectedIsCustom, selectedScript]);

  return (
    <div className="h-64 shrink-0 border-b border-[#3c3c3c] bg-[#202020] flex flex-col">
      <div className="h-10 px-2 flex items-center gap-2 border-b border-[#3c3c3c] bg-[#252526]">
        <div className="flex rounded border border-[#3c3c3c] overflow-hidden">
          <button
            className={`h-7 px-3 text-xs ${tab === 'project' ? 'bg-[#1e1e1e] text-text-primary' : 'text-text-secondary hover:bg-[#333]'}`}
            onClick={() => setTab('project')}
          >
            项目脚本
          </button>
          <button
            className={`h-7 px-3 text-xs border-l border-[#3c3c3c] ${tab === 'custom' ? 'bg-[#1e1e1e] text-text-primary' : 'text-text-secondary hover:bg-[#333]'}`}
            onClick={() => setTab('custom')}
          >
            自定义命令
          </button>
        </div>
        <input
          className="h-7 flex-1 min-w-0 bg-[#1f1f1f] border border-[#3c3c3c] rounded px-2 text-xs text-text-primary"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索脚本或命令"
        />
        <button className="h-7 w-7 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded" onClick={() => refresh()} title="重新发现">
          <RefreshCw size={14} />
        </button>
        <button className="h-7 w-7 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded" onClick={handleCreateCustom} title="新增自定义命令">
          <Plus size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[44%] min-w-[180px] border-r border-[#3c3c3c] overflow-y-auto">
          {visibleScripts.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-text-tertiary px-3 text-center">
              {loading ? '发现脚本中...' : tab === 'project' ? '未发现项目脚本' : '暂无自定义命令'}
            </div>
          ) : visibleScripts.map((script) => {
            const runtime = runtimes[script.id];
            const active = selectedScript?.id === script.id;
            return (
              <button
                key={script.id}
                onClick={() => setSelectedScriptId(script.id)}
                className={`w-full text-left px-3 py-2 border-b border-[#303030] ${active ? 'bg-[#263347]' : 'hover:bg-[#2d2d2d]'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-text-primary truncate">{script.name}</span>
                  <span className="text-[10px] text-text-tertiary shrink-0">{statusLabel(runtime?.status)}</span>
                </div>
                <div className="mt-1 text-[11px] text-text-tertiary font-mono truncate">{script.command}</div>
              </button>
            );
          })}
        </div>

        <div className="flex-1 min-w-0 p-3 overflow-y-auto">
          {!draft ? (
            <div className="h-full flex items-center justify-center text-xs text-text-tertiary">选择一个脚本</div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-text-tertiary truncate">
                  {selectedIsCustom ? '自定义命令' : draft.source}
                  {draft.sourcePath ? ` · ${draft.sourcePath}` : ''}
                </div>
                <div className="flex items-center gap-1">
                  <button className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded" onClick={handleRun} disabled={selectedRuntime?.status === 'running'}>
                    <Play size={13} />运行
                  </button>
                  <button className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded disabled:opacity-50" onClick={handleStop} disabled={selectedRuntime?.status !== 'running'}>
                    <Square size={13} />停止
                  </button>
                  <button className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] rounded" onClick={handleSave}>
                    <Save size={13} />保存
                  </button>
                  <button className="h-7 px-2 flex items-center gap-1 text-xs text-text-secondary hover:text-red-300 hover:bg-[#3c3c3c] rounded" onClick={handleDelete}>
                    {selectedIsCustom ? <Trash2 size={13} /> : <EyeOff size={13} />}
                    {selectedIsCustom ? '删除' : '隐藏'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-text-tertiary">
                  名称
                  <input
                    className="mt-1 h-7 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 text-xs text-text-primary"
                    value={draft.name}
                    readOnly={!selectedIsCustom}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="text-[11px] text-text-tertiary">
                  状态
                  <input className="mt-1 h-7 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 text-xs text-text-secondary" value={statusLabel(selectedRuntime?.status)} readOnly />
                </label>
              </div>

              <label className="block text-[11px] text-text-tertiary">
                命令
                <textarea
                  className="mt-1 h-14 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-text-primary font-mono resize-none"
                  value={draft.command}
                  readOnly={!selectedIsCustom}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-text-tertiary">
                  工作目录
                  <input
                    className="mt-1 h-7 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 text-xs text-text-primary"
                    value={draft.cwd ?? ''}
                    onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  />
                </label>
                <label className="text-[11px] text-text-tertiary">
                  自动执行时机
                  <select
                    className="mt-1 h-7 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 text-xs text-text-primary"
                    value={draft.autoRunTrigger || 'workspace_open'}
                    disabled={!draft.autoRun}
                    onChange={(e) => setDraft({ ...draft, autoRunTrigger: e.target.value as TerminalScriptAutoRunTrigger })}
                  >
                    <option value="app_start">应用启动</option>
                    <option value="workspace_open">打开工作区</option>
                    <option value="terminal_open">打开终端</option>
                  </select>
                </label>
              </div>

              <div className="flex items-center gap-4 text-xs text-text-secondary">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                  启用
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.autoRun} onChange={(e) => setDraft({ ...draft, autoRun: e.target.checked, autoRunTrigger: draft.autoRunTrigger || 'workspace_open' })} />
                  自动执行
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.confirmBeforeAutoRun} onChange={(e) => setDraft({ ...draft, confirmBeforeAutoRun: e.target.checked })} />
                  执行前确认
                </label>
              </div>

              <label className="block text-[11px] text-text-tertiary">
                环境变量
                <textarea
                  className="mt-1 h-12 w-full bg-[#151515] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-text-primary font-mono resize-none"
                  value={draftEnv}
                  onChange={(e) => setDraftEnv(e.target.value)}
                  placeholder="KEY=value"
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {hiddenDiscoveredScriptIds.length > 0 && (
        <div className="h-8 px-2 border-t border-[#3c3c3c] flex items-center justify-between text-xs text-text-tertiary">
          <span>已隐藏 {hiddenDiscoveredScriptIds.length} 个项目脚本</span>
          <button className="h-6 px-2 flex items-center gap-1 hover:text-text-primary hover:bg-[#3c3c3c] rounded" onClick={() => restoreHiddenProjectScripts()}>
            <RotateCcw size={12} />恢复隐藏
          </button>
        </div>
      )}

      {error && (
        <div className="h-8 px-2 border-t border-red-900/40 bg-red-950/30 flex items-center justify-between gap-2 text-xs text-red-200">
          <span className="truncate">{error}</span>
          <button className="h-6 px-2 hover:bg-red-900/40 rounded" onClick={clearError}>关闭</button>
        </div>
      )}
    </div>
  );
}
