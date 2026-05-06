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
  runScript: (scriptId: string) => Promise<string>;
  stopScript: (scriptId: string) => Promise<void>;
  runAutoScripts: (trigger: TerminalScriptAutoRunTrigger, workspacePath?: string | null) => Promise<void>;
  initEventListeners: () => () => void;
  clearError: () => void;
}

function getWorkspaceScriptsConfig(workspacePath: string | null): WorkspaceTerminalScripts {
  if (!workspacePath) return { scripts: [] };
  const config = useConfigStore.getState().config;
  return config?.terminalScripts?.[workspacePath] ?? { scripts: [] };
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

function mergeScripts(discovered: DiscoveredTerminalScript[], saved: TerminalScript[]): TerminalScript[] {
  const byId = new Map<string, TerminalScript>();

  for (const item of discovered) {
    byId.set(item.id, toScriptFromDiscovery(item));
  }

  for (const item of saved) {
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

async function persistWorkspaceScripts(workspacePath: string, scripts: TerminalScript[]) {
  const config = useConfigStore.getState().config;
  const terminalScripts = {
    ...(config?.terminalScripts ?? {}),
    [workspacePath]: { scripts },
  };

  await useConfigStore.getState().updateConfigPatch({ terminalScripts });
}

export const useTerminalScriptStore = create<TerminalScriptState>((set, get) => ({
  workspacePath: null,
  scripts: [],
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
      const saved = getWorkspaceScriptsConfig(workspacePath).scripts ?? [];
      set({ scripts: mergeScripts(discovered, saved), loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.error('加载终端脚本失败', e instanceof Error ? e : new Error(error));
      const saved = getWorkspaceScriptsConfig(workspacePath).scripts ?? [];
      set({ scripts: saved, loading: false, error });
    }
  },

  saveScript: async (script) => {
    const { workspacePath, scripts } = get();
    if (!workspacePath) throw new Error('未选择工作区');

    const nextScripts = scripts.some((item) => item.id === script.id)
      ? scripts.map((item) => item.id === script.id ? { ...item, ...script } : item)
      : [...scripts, script];

    await persistWorkspaceScripts(workspacePath, nextScripts);
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
    const { workspacePath, scripts } = get();
    if (!workspacePath) throw new Error('未选择工作区');
    const nextScripts = scripts.filter((item) => item.id !== scriptId);
    await persistWorkspaceScripts(workspacePath, nextScripts);
    set({ scripts: nextScripts });
  },

  runScript: async (scriptId) => {
    const script = get().scripts.find((item) => item.id === scriptId);
    if (!script) throw new Error('脚本不存在');
    if (!script.enabled) throw new Error('脚本已禁用');
    if (!script.command.trim()) throw new Error('脚本命令不能为空');

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
      if (script.confirmBeforeAutoRun && !window.confirm(`是否自动执行脚本：${script.name}?`)) {
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
