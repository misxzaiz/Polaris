/**
 * 命令状态管理
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Command } from '../types/command';
import { builtinCommands } from '../types/command';
import { createLogger } from '../utils/logger';

const log = createLogger('CommandStore');

interface CommandFile {
  name: string;
  description?: string;
  params?: Array<{ name: string; description?: string; required?: boolean }>;
  content: string;
  file_path: string;
}

interface CommandState {
  commands: Command[];
  isLoading: boolean;
  error: string | null;

  // 加载自定义命令
  loadCustomCommands: (workDir: string | null) => Promise<void>;

  // 获取命令列表
  getCommands: () => Command[];

  // 根据名称查找命令
  getCommandByName: (name: string) => Command | undefined;

  // 搜索命令
  searchCommands: (query: string) => Command[];
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: builtinCommands,
  isLoading: false,
  error: null,

  loadCustomCommands: async (workDir: string | null) => {
    if (!workDir) {
      set({ commands: builtinCommands, error: null });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      const customCommands = await invoke<CommandFile[]>('read_commands', { workDir });

      const commands: Command[] = [
        ...builtinCommands,
        ...customCommands.map(cmd => ({
          name: cmd.name,
          type: 'custom' as const,
          description: cmd.description || '自定义命令',
          params: cmd.params,
          content: cmd.content,
          filePath: cmd.file_path,
        })),
      ];

      set({ commands, isLoading: false, error: null });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('加载自定义命令失败', err instanceof Error ? err : new Error(errorMsg));
      // 不阻断，使用内置命令
      set({ commands: builtinCommands, isLoading: false, error: null });
    }
  },

  getCommands: () => {
    return get().commands;
  },

  getCommandByName: (name: string) => {
    return get().commands.find(cmd => cmd.name === name);
  },

  searchCommands: (query: string) => {
    const commands = get().commands;
    if (!query) return commands;

    const lowerQuery = query.toLowerCase();
    return commands.filter(cmd =>
      cmd.name.toLowerCase().includes(lowerQuery) ||
      cmd.description.toLowerCase().includes(lowerQuery)
    );
  },
}));
