/**
 * Spring Boot 运行状态管理
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// Types
// ============================================================================

export type BuildTool = 'maven' | 'gradle';

export type AppStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface SpringBootProject {
  path: string;
  name: string;
  buildTool: BuildTool;
  springBootVersion?: string;
  javaVersion?: string;
  mainClass?: string;
  hasDevtools: boolean;
  port?: number;
}

export interface SpringBootApp {
  id: string;
  sessionId?: string;
  project: SpringBootProject;
  status: AppStatus;
  pid?: number;
  port?: number;
  startedAt?: string;
  error?: string;
  debugEnabled: boolean;
  debugPort?: number;
}

export interface StartConfig {
  projectPath: string;
  debug?: boolean;
  debugPort?: number;
  appPort?: number;
  jvmArgs?: string[];
  buildArgs?: string[];
  env?: Record<string, string>;
}

// ============================================================================
// Store
// ============================================================================

interface SpringBootState {
  // 状态
  apps: SpringBootApp[];
  loading: boolean;
  error: string | null;

  // 操作
  detectProject: (path: string) => Promise<SpringBootProject>;
  startApp: (config: StartConfig) => Promise<SpringBootApp>;
  stopApp: (appId: string) => Promise<void>;
  listApps: () => Promise<void>;
  getApp: (appId: string) => Promise<SpringBootApp | null>;
  checkPort: (port: number) => Promise<boolean>;
  findAvailablePort: (start?: number) => Promise<number>;
  clearError: () => void;
}

export const useSpringBootStore = create<SpringBootState>((set) => ({
  // 初始状态
  apps: [],
  loading: false,
  error: null,

  // 检测项目
  detectProject: async (path: string) => {
    try {
      set({ loading: true, error: null });
      const project = await invoke<SpringBootProject>('spring_boot_detect_project', { path });
      return project;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ loading: false });
    }
  },

  // 启动应用
  startApp: async (config: StartConfig) => {
    try {
      set({ loading: true, error: null });
      const app = await invoke<SpringBootApp>('spring_boot_start', { config });
      set((state) => ({
        apps: [...state.apps, app],
      }));
      return app;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ loading: false });
    }
  },

  // 停止应用
  stopApp: async (appId: string) => {
    try {
      set({ loading: true, error: null });
      await invoke('spring_boot_stop', { appId });
      set((state) => ({
        apps: state.apps.filter((app) => app.id !== appId),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ loading: false });
    }
  },

  // 获取应用列表
  listApps: async () => {
    try {
      set({ loading: true, error: null });
      const apps = await invoke<SpringBootApp[]>('spring_boot_list_apps');
      set({ apps });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    } finally {
      set({ loading: false });
    }
  },

  // 获取单个应用
  getApp: async (appId: string) => {
    try {
      const app = await invoke<SpringBootApp | null>('spring_boot_get_app', { appId });
      return app;
    } catch (error) {
      console.error('Failed to get app:', error);
      return null;
    }
  },

  // 检查端口
  checkPort: async (port: number) => {
    try {
      const occupied = await invoke<boolean>('spring_boot_check_port', { port });
      return occupied;
    } catch (error) {
      console.error('Failed to check port:', error);
      return true;
    }
  },

  // 查找可用端口
  findAvailablePort: async (start?: number) => {
    try {
      const port = await invoke<number>('spring_boot_find_available_port', { start });
      return port;
    } catch (error) {
      console.error('Failed to find available port:', error);
      return start || 8080;
    }
  },

  // 清除错误
  clearError: () => set({ error: null }),
}));
