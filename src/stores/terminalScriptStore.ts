/**
 * 终端脚本状态管理
 */

import { create } from 'zustand';
import { invoke, listen } from '@/services/transport';
import { useConfigStore } from './configStore';
import { useTerminalStore } from './terminalStore';
import type {
  DiscoveredTerminalScript,
  TerminalScript,
  TerminalScriptAutoRunTrigger,
  TerminalScriptRuntime,
  WorkspaceTerminalScripts,
} from '@/types/terminalScript';
import type { TerminalExitEvent } from '@/types/terminal';
import { createLogger } from '@/utils/logger';
import { generateUUID } from '@/utils/uuid';

const log = createLogger('TerminalScriptStore');

interface TerminalScriptState {
  workspacePath: string | null;
  scripts: TerminalScript[];
  hiddenDiscoveredScriptIds: string[];
  runtimes: Record<string, TerminalScriptRuntime>;
  loading: boolean;
  error: string | null;
  autoRunKeys: string[];

  setWorkspace: (workspacePath: string | null) => Promise<void>;
  discoverScripts: (workspacePath?: string | null) => Promise<DiscoveredTerminalScript[]>;
  refresh: () => Promise<void>;
  saveScript: (script: TerminalScript) => Promise<void>;
  createCustomScript: (params: Pick<TerminalScript, 'name' | 'command'> & Partial<TerminalScript>) => Promise<void>;
  deleteScript: (scriptId: string) => Promise<void>;
  hideProjectScript: (scriptId: string) => Promise<void>;
  restoreHiddenProjectScripts: () => Promise<void>;
  runScript: (scriptId: string) => Promise<string>;
  stopScript: (scriptId: string) => Promise<void>;
  runInExternalTerminal: (scriptId: string) => Promise<void>;
  runAutoScripts: (trigger: TerminalScriptAutoRunTrigger, workspacePath?: string | null) => Promise<void>;
  initEventListeners: () => () => void;
  clearError: () => void;
}

function getWorkspaceScriptsConfig(workspacePath: string | null): WorkspaceTerminalScripts {
  if (!workspacePath) return { scripts: [] };
  const config = useConfigStore.getState().config;
  return config?.terminalScripts?.[workspacePath] ?? { scripts: [] };
}

function isCustomScript(script: TerminalScript): boolean {
  return script.source === 'user' || script.id.startsWith('user:');
}

function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return [
    'rm -rf',
    'del /s',
    'rmdir /s',
    'git clean -fd',
    'git clean -fdx',
    'format ',
  ].some((pattern) => normalized.includes(pattern));
}

function toScriptFromDiscovery(item: DiscoveredTerminalScript): TerminalScript {
  return {
    id: item.id,
    name: item.name,
    command: item.command,
    cwd: item.cwd,
    env: {},
    tags: item.tags,
    source: item.source,
    sourcePath: item.sourcePath,
    enabled: item.enabled,
    autoRun: false,
    autoRunTrigger: undefined,
    confirmBeforeAutoRun: false,
  };
}

function mergeScripts(
  discovered: DiscoveredTerminalScript[],
  saved: TerminalScript[],
  hiddenDiscoveredScriptIds: string[],
): TerminalScript[] {
  const byId = new Map<string, TerminalScript>();
  const hidden = new Set(hiddenDiscoveredScriptIds);

  for (const item of discovered) {
    if (hidden.has(item.id)) continue;
    byId.set(item.id, toScriptFromDiscovery(item));
  }

  for (const item of saved) {
    if (!isCustomScript(item) && hidden.has(item.id)) continue;
    byId.set(item.id, {
      ...byId.get(item.id),
      ...item,
      env: item.env ?? {},
      tags: item.tags ?? byId.get(item.id)?.tags ?? [],
      enabled: item.enabled !== false,
      autoRun: item.autoRun === true,
      confirmBeforeAutoRun: item.confirmBeforeAutoRun === true,
    });
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function persistWorkspaceScripts(
  workspacePath: string,
  scripts: TerminalScript[],
  hiddenDiscoveredScriptIds: string[],
) {
  const config = useConfigStore.getState().config;
  const terminalScripts = {
    ...(config?.terminalScripts ?? {}),
    [workspacePath]: { scripts, hiddenDiscoveredScriptIds },
  };

  await useConfigStore.getState().updateConfigPatch({ terminalScripts });
}

export const useTerminalScriptStore = create<TerminalScriptState>((set, get) => ({
  workspacePath: null,
  scripts: [],
  hiddenDiscoveredScriptIds: [],
  runtimes: {},
  loading: false,
  error: null,
  autoRunKeys: [],

  setWorkspace: async (workspacePath) => {
    set({ workspacePath });
    await get().refresh();
  },

  discoverScripts: async (workspacePath = get().workspacePath) => {
    if (!workspacePath) return [];
    return invoke<DiscoveredTerminalScript[]>('terminal_discover_scripts', { workspacePath });
  },

  refresh: async () => {
    const { workspacePath } = get();
    if (!workspacePath) {
      set({ scripts: [], error: null });
      return;
    }

    set({ loading: true, error: null });
    try {
      const [discovered] = await Promise.all([
        get().discoverScripts(workspacePath),
        useConfigStore.getState().config ? Promise.resolve() : useConfigStore.getState().loadConfig(),
      ]);
      const workspaceConfig = getWorkspaceScriptsConfig(workspacePath);
      const saved = workspaceConfig.scripts ?? [];
      const hiddenDiscoveredScriptIds = workspaceConfig.hiddenDiscoveredScriptIds ?? [];
      set({
        scripts: mergeScripts(discovered, saved, hiddenDiscoveredScriptIds),
        hiddenDiscoveredScriptIds,
        loading: false,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.error('加载终端脚本失败', e instanceof Error ? e : new Error(error));
      const workspaceConfig = getWorkspaceScriptsConfig(workspacePath);
      const saved = workspaceConfig.scripts ?? [];
      const hiddenDiscoveredScriptIds = workspaceConfig.hiddenDiscoveredScriptIds ?? [];
      set({ scripts: saved, hiddenDiscoveredScriptIds, loading: false, error });
    }
  },

  saveScript: async (script) => {
    const { workspacePath, scripts, hiddenDiscoveredScriptIds } = get();
    if (!workspacePath) throw new Error('未选择工作区');

    const nextScripts = scripts.some((item) => item.id === script.id)
      ? scripts.map((item) => item.id === script.id ? { ...item, ...script } : item)
      : [...scripts, script];

    await persistWorkspaceScripts(workspacePath, nextScripts, hiddenDiscoveredScriptIds);
    set({ scripts: nextScripts.sort((a, b) => a.name.localeCompare(b.name)) });
  },

  createCustomScript: async (params) => {
    const workspacePath = get().workspacePath;
    if (!workspacePath) throw new Error('未选择工作区');
    const script: TerminalScript = {
      id: `user:${generateUUID()}`,
      name: params.name.trim(),
      command: params.command.trim(),
      cwd: params.cwd || workspacePath,
      env: params.env ?? {},
      tags: params.tags ?? ['custom'],
      source: 'user',
      sourcePath: undefined,
      enabled: params.enabled ?? true,
      autoRun: params.autoRun ?? false,
      autoRunTrigger: params.autoRunTrigger,
      confirmBeforeAutoRun: params.confirmBeforeAutoRun ?? false,
    };
    if (!script.name || !script.command) {
      throw new Error('脚本名称和命令不能为空');
    }
    await get().saveScript(script);
  },

  deleteScript: async (scriptId) => {
    const { workspacePath, scripts, hiddenDiscoveredScriptIds } = get();
    if (!workspacePath) throw new Error('未选择工作区');

    const script = scripts.find((item) => item.id === scriptId);
    if (script && !isCustomScript(script)) {
      await get().hideProjectScript(scriptId);
      return;
    }

    const nextScripts = scripts.filter((item) => item.id !== scriptId);
    await persistWorkspaceScripts(workspacePath, nextScripts, hiddenDiscoveredScriptIds);
    set({ scripts: nextScripts });
  },

  hideProjectScript: async (scriptId) => {
    const { workspacePath, scripts, hiddenDiscoveredScriptIds } = get();
    if (!workspacePath) throw new Error('未选择工作区');
    const nextHidden = Array.from(new Set([...hiddenDiscoveredScriptIds, scriptId]));
    const nextScripts = scripts.filter((item) => item.id !== scriptId);
    await persistWorkspaceScripts(workspacePath, nextScripts, nextHidden);
    set({ scripts: nextScripts, hiddenDiscoveredScriptIds: nextHidden });
  },

  restoreHiddenProjectScripts: async () => {
    const { workspacePath, scripts } = get();
    if (!workspacePath) throw new Error('未选择工作区');
    await persistWorkspaceScripts(workspacePath, scripts, []);
    set({ hiddenDiscoveredScriptIds: [] });
    await get().refresh();
  },

  runScript: async (scriptId) => {
    const script = get().scripts.find((item) => item.id === scriptId);
    if (!script) throw new Error('脚本不存在');
    if (!script.enabled) throw new Error('脚本已禁用');
    if (!script.command.trim()) throw new Error('脚本命令不能为空');
    if (isDangerousCommand(script.command) && !window.confirm(`命令可能具有破坏性，确认执行：${script.command}?`)) {
      throw new Error('用户取消执行');
    }

    set((state) => ({
      runtimes: {
        ...state.runtimes,
        [scriptId]: { status: 'running', lastRunAt: Date.now() },
      },
    }));

    try {
      const session = await useTerminalStore.getState().createSession({
        name: script.name,
        cwd: script.cwd || get().workspacePath || undefined,
        initialCommand: script.command,
        env: script.env,
        purpose: 'script',
        scriptId,
      });
      set((state) => ({
        runtimes: {
          ...state.runtimes,
          [scriptId]: {
            ...state.runtimes[scriptId],
            status: 'running',
            terminalSessionId: session.id,
            lastRunAt: Date.now(),
          },
        },
      }));
      return session.id;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set((state) => ({
        error,
        runtimes: {
          ...state.runtimes,
          [scriptId]: { status: 'failed', error, lastRunAt: Date.now() },
        },
      }));
      throw e;
    }
  },

  stopScript: async (scriptId) => {
    const runtime = get().runtimes[scriptId];
    if (!runtime?.terminalSessionId) return;
    await useTerminalStore.getState().closeSession(runtime.terminalSessionId);
    set((state) => ({
      runtimes: {
        ...state.runtimes,
        [scriptId]: { ...runtime, status: 'stopped' },
      },
    }));
  },

  runInExternalTerminal: async (scriptId) => {
    const script = get().scripts.find((item) => item.id === scriptId);
    if (!script) throw new Error('脚本不存在');
    if (!script.enabled) throw new Error('脚本已禁用');
    if (!script.command.trim()) throw new Error('脚本命令不能为空');
    if (isDangerousCommand(script.command) && !window.confirm(`命令可能具有破坏性，确认在外部终端执行：${script.command}?`)) {
      throw new Error('用户取消执行');
    }

    await invoke('terminal_open_in_external', {
      command: script.command,
      cwd: script.cwd || get().workspacePath || undefined,
      env: script.env && Object.keys(script.env).length > 0 ? script.env : undefined,
    });
  },

  runAutoScripts: async (trigger, workspacePath = get().workspacePath) => {
    if (!workspacePath) return;
    if (workspacePath !== get().workspacePath) {
      await get().setWorkspace(workspacePath);
    } else if (get().scripts.length === 0) {
      await get().refresh();
    }

    for (const script of get().scripts) {
      if (!script.enabled || !script.autoRun || script.autoRunTrigger !== trigger) continue;
      const key = `${workspacePath}:${trigger}:${script.id}`;
      if (get().autoRunKeys.includes(key)) continue;
      if (script.confirmBeforeAutoRun && !window.confirm(`是否自动执行脚本：${script.name}?\n${script.command}`)) {
        continue;
      }
      set((state) => ({ autoRunKeys: [...state.autoRunKeys, key] }));
      await get().runScript(script.id);
    }
  },

  initEventListeners: () => {
    const unlistenExit = listen<TerminalExitEvent>('terminal:exit', (event) => {
      const { sessionId, exitCode } = event;
      const entry = Object.entries(get().runtimes)
        .find(([, runtime]) => runtime.terminalSessionId === sessionId);
      if (!entry) return;
      const [scriptId, runtime] = entry;
      set((state) => ({
        runtimes: {
          ...state.runtimes,
          [scriptId]: {
            ...runtime,
            status: exitCode === 0 ? 'success' : 'failed',
            exitCode,
          },
        },
      }));
    });

    return () => {
      unlistenExit.then((fn) => fn());
    };
  },

  clearError: () => set({ error: null }),
}));
