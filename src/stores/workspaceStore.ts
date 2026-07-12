/**
 * 工作区状态管理
 *
 * 工作区列表同时存储在：
 * 1. 服务端 Config（source of truth，跨桌面/Web 共享）
 * 2. 客户端 localStorage（离线缓存、快速加载）
 *
 * 初始化时从服务端同步，变更时双向写入。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Workspace, WorkspaceStore } from '@/types';
import type { WorkspaceEntry } from '@/types/config';
import * as tauri from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import { generateUUID } from '@/utils/uuid';

const log = createLogger('WorkspaceStore');

/** 将本地 Workspace 映射为服务端 WorkspaceEntry */
function toEntry(w: Workspace): WorkspaceEntry {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    createdAt: w.createdAt,
    lastAccessed: w.lastAccessed,
  };
}

/** 将服务端 WorkspaceEntry 映射为本地 Workspace */
function fromEntry(e: WorkspaceEntry): Workspace {
  return {
    id: e.id,
    name: e.name,
    path: e.path,
    createdAt: e.createdAt ?? new Date().toISOString(),
    lastAccessed: e.lastAccessed ?? new Date().toISOString(),
  };
}

/** 将当前工作区列表持久化到服务端 Config */
async function persistToServer(
  workspaces: Workspace[],
  currentWorkspaceId: string | null,
): Promise<void> {
  try {
    await tauri.updateConfigPatch({
      workspaces: workspaces.map(toEntry),
      currentWorkspaceId: currentWorkspaceId ?? null,
    });
  } catch (e) {
    log.warn('Failed to persist workspaces to server config', { error: String(e) });
  }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      // 初始状态
      workspaces: [],
      currentWorkspaceId: null,
      contextWorkspaceIds: [],
      viewingWorkspaceId: null,
      isLoading: false,
      error: null,

      /** 从服务端 Config 同步工作区列表（应用初始化时调用） */
      syncFromServer: async () => {
        try {
          const config = await tauri.getConfig();
          const serverWorkspaces = config?.workspaces;
          if (serverWorkspaces && serverWorkspaces.length > 0) {
            const local = get().workspaces;
            // 合并策略：服务端为主，补充本地独有的工作区
            const serverIds = new Set(serverWorkspaces.map((w) => w.id));
            const localOnly = local.filter((w) => !serverIds.has(w.id));
            const merged = [...serverWorkspaces.map(fromEntry), ...localOnly];

            const serverCurrentId = config.currentWorkspaceId ?? null;
            set({
              workspaces: merged,
              currentWorkspaceId: serverCurrentId ?? get().currentWorkspaceId,
            });

            // 如果本地有独有的工作区，回写服务端
            if (localOnly.length > 0) {
              await persistToServer(merged, get().currentWorkspaceId);
            }

            log.info('Synced workspaces from server', {
              server: serverWorkspaces.length,
              localOnly: localOnly.length,
              total: merged.length,
            });
          } else if (get().workspaces.length > 0) {
            // 服务端没有但本地有 → 推送到服务端
            await persistToServer(get().workspaces, get().currentWorkspaceId);
            log.info('Pushed local workspaces to server');
          }
        } catch (e) {
          log.warn('Failed to sync workspaces from server', { error: String(e) });
        }
      },

      // 创建工作区
      createWorkspace: async (name: string, path: string, switchAfterCreate: boolean = true) => {
        set({ isLoading: true, error: null });

        try {
          // 验证路径
          const isValid = await get().validateWorkspacePath(path);
          if (!isValid) {
            throw new Error('无效的工作区路径');
          }

          // 检查路径是否已存在
          const existingWorkspace = get().workspaces.find(w => w.path === path);
          if (existingWorkspace) {
            throw new Error('该路径已被其他工作区使用');
          }

          const workspace: Workspace = {
            id: generateUUID(),
            name,
            path,
            createdAt: new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
          };

          const newCurrentId = switchAfterCreate ? workspace.id : get().currentWorkspaceId;

          set((state) => ({
            workspaces: [...state.workspaces, workspace],
            currentWorkspaceId: newCurrentId,
            isLoading: false,
          }));

          // 持久化到服务端
          await persistToServer(get().workspaces, newCurrentId);

          if (switchAfterCreate) {
            await get().switchWorkspace(workspace.id);
          } else {
            get().addContextWorkspace(workspace.id);
          }
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : '创建工作区失败',
            isLoading: false,
          });
          throw error;
        }
      },

      // 切换工作区
      switchWorkspace: async (id: string) => {
        const workspace = get().workspaces.find(w => w.id === id);
        if (!workspace) {
          throw new Error('工作区不存在');
        }

        try {
          await tauri.setWorkDir(workspace.path);
        } catch (error) {
          log.error('更新工作目录失败', error instanceof Error ? error : new Error(String(error)));
          throw new Error(`切换工作区失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }

        set((state) => ({
          workspaces: state.workspaces.map(w =>
            w.id === id
              ? { ...w, lastAccessed: new Date().toISOString() }
              : w
          ),
          currentWorkspaceId: id,
        }));

        // 同步 currentWorkspaceId 到服务端
        await persistToServer(get().workspaces, id);

        window.dispatchEvent(new CustomEvent('workspace-changed', {
          detail: { workspaceId: id, path: workspace.path }
        }));
        window.dispatchEvent(new CustomEvent('workspace-switched'));
      },

      // 删除工作区
      deleteWorkspace: async (id: string) => {
        const { workspaces, currentWorkspaceId, contextWorkspaceIds } = get();

        if (workspaces.length <= 1) {
          throw new Error('至少需要保留一个工作区');
        }

        const workspaceToDelete = workspaces.find(w => w.id === id);
        if (!workspaceToDelete) {
          throw new Error('工作区不存在');
        }

        const newWorkspaces = workspaces.filter(w => w.id !== id);
        const newCurrentId = currentWorkspaceId === id
          ? newWorkspaces[0]?.id || null
          : currentWorkspaceId;
        const newContextIds = contextWorkspaceIds.filter(contextId => contextId !== id);

        set({
          workspaces: newWorkspaces,
          contextWorkspaceIds: newContextIds,
        });

        // 持久化到服务端
        await persistToServer(newWorkspaces, newCurrentId);

        if (currentWorkspaceId === id && newCurrentId) {
          await get().switchWorkspace(newCurrentId);
        } else {
          set({ currentWorkspaceId: newCurrentId });
        }
      },

      // 更新工作区
      updateWorkspace: async (id: string, updates: Partial<Workspace>) => {
        set((state) => ({
          workspaces: state.workspaces.map(w =>
            w.id === id ? { ...w, ...updates } : w
          ),
        }));
        // 同步到服务端
        await persistToServer(get().workspaces, get().currentWorkspaceId);
      },

      // 获取当前工作区
      getCurrentWorkspace: () => {
        const { workspaces, currentWorkspaceId } = get();
        return workspaces.find(w => w.id === currentWorkspaceId) || null;
      },

      // 验证工作区路径
      validateWorkspacePath: async (path: string): Promise<boolean> => {
        try {
          return await tauri.validateWorkspacePath(path);
        } catch {
          return false;
        }
      },

      // 清除错误
      clearError: () => {
        set({ error: null });
      },

      // ========== 关联工作区操作 ==========

      setContextWorkspaces: (ids: string[]) => {
        set({ contextWorkspaceIds: ids });
      },

      addContextWorkspace: (id: string) => {
        set(state => {
          if (state.contextWorkspaceIds.includes(id)) return state;
          return { contextWorkspaceIds: [...state.contextWorkspaceIds, id] };
        });
      },

      removeContextWorkspace: (id: string) => {
        set(state => ({
          contextWorkspaceIds: state.contextWorkspaceIds.filter(x => x !== id)
        }));
      },

      toggleContextWorkspace: (id: string) => {
        const state = get();
        if (state.contextWorkspaceIds.includes(id)) {
          get().removeContextWorkspace(id);
        } else {
          get().addContextWorkspace(id);
        }
      },

      clearContextWorkspaces: () => {
        set({ contextWorkspaceIds: [] });
      },

      getContextWorkspaces: () => {
        const state = get();
        return state.workspaces.filter(w => state.contextWorkspaceIds.includes(w.id));
      },

      getAllAccessibleWorkspaces: () => {
        return get().workspaces;
      },

      // ========== FileExplorer 浏览工作区操作 ==========

      setViewingWorkspace: (id: string | null) => {
        set({ viewingWorkspaceId: id });
      },

      getViewingWorkspace: () => {
        const state = get();
        if (!state.viewingWorkspaceId) {
          return state.workspaces.find(w => w.id === state.currentWorkspaceId) || null;
        }
        return state.workspaces.find(w => w.id === state.viewingWorkspaceId) || null;
      },

      getSortedWorkspaces: () => {
        return [...get().workspaces].sort((a, b) =>
          new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
        );
      },
    }),
    {
      name: 'workspace-store',
      partialize: (state) => ({
        workspaces: state.workspaces,
        currentWorkspaceId: state.currentWorkspaceId,
        contextWorkspaceIds: state.contextWorkspaceIds,
      }),
    }
  )
);
