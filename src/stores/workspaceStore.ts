/**
 * 工作区状态管理
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Workspace, WorkspaceStore } from '../types';
import * as tauri from '../services/tauri';
import { createLogger } from '../utils/logger';

const log = createLogger('WorkspaceStore');

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      // 初始状态
      workspaces: [],
      currentWorkspaceId: null,
      contextWorkspaceIds: [],
      viewingWorkspaceId: null,  // 不持久化
      isLoading: false,
      error: null,

      // 创建工作区 - 添加 switchAfterCreate 参数，允许选择是否切换到新工作区
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

          // 创建工作区
          const workspace: Workspace = {
            id: crypto.randomUUID(),
            name,
            path,
            createdAt: new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
          };

          // 更新状态
          set((state) => ({
            workspaces: [...state.workspaces, workspace],
            currentWorkspaceId: switchAfterCreate ? workspace.id : state.currentWorkspaceId,
            isLoading: false,
          }));

          // 根据参数决定是否切换工作区
          if (switchAfterCreate) {
            // 切换到新工作区
            await get().switchWorkspace(workspace.id);
          } else {
            // 添加到关联工作区但不切换
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

        // 先更新全局配置的工作目录，成功后才更新前端状态
        // 这样确保前端显示的工作区与后端配置始终一致
        try {
          await tauri.setWorkDir(workspace.path);
        } catch (error) {
          log.error('更新工作目录失败', error instanceof Error ? error : new Error(String(error)));
          throw new Error(`切换工作区失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }

        // 后端配置更新成功后，更新前端状态
        set((state) => ({
          workspaces: state.workspaces.map(w =>
            w.id === id
              ? { ...w, lastAccessed: new Date().toISOString() }
              : w
          ),
          currentWorkspaceId: id,
        }));

        // 通知其他组件工作区已切换
        window.dispatchEvent(new CustomEvent('workspace-changed', {
          detail: { workspaceId: id, path: workspace.path }
        }));

        // 清除聊天错误提示
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

        // 同时从上下文中移除被删除的工作区
        const newContextIds = contextWorkspaceIds.filter(contextId => contextId !== id);

        // 先更新工作区列表（移除要删除的）
        set({
          workspaces: newWorkspaces,
          contextWorkspaceIds: newContextIds,
        });

        // 如果删除的是当前工作区，需要切换到剩余的工作区
        if (currentWorkspaceId === id && newCurrentId) {
          // 使用 switchWorkspace 确保后端配置同步更新
          // switchWorkspace 会更新 currentWorkspaceId 并同步到后端
          await get().switchWorkspace(newCurrentId);
        } else {
          // 删除的不是当前工作区，只需更新 currentWorkspaceId
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

      // 设置关联工作区列表
      setContextWorkspaces: (ids: string[]) => {
        set({ contextWorkspaceIds: ids });
      },

      // 添加到关联
      addContextWorkspace: (id: string) => {
        set(state => {
          // 不能重复添加
          if (state.contextWorkspaceIds.includes(id)) return state;
          return { contextWorkspaceIds: [...state.contextWorkspaceIds, id] };
        });
      },

      // 从关联移除
      removeContextWorkspace: (id: string) => {
        set(state => ({
          contextWorkspaceIds: state.contextWorkspaceIds.filter(x => x !== id)
        }));
      },

      // 切换关联状态
      toggleContextWorkspace: (id: string) => {
        const state = get();

        if (state.contextWorkspaceIds.includes(id)) {
          get().removeContextWorkspace(id);
        } else {
          get().addContextWorkspace(id);
        }
      },

      // 清空关联
      clearContextWorkspaces: () => {
        set({ contextWorkspaceIds: [] });
      },

      // 获取关联工作区列表
      getContextWorkspaces: () => {
        const state = get();
        return state.workspaces.filter(w => state.contextWorkspaceIds.includes(w.id));
      },

      // 获取所有已保存的工作区（用于文件浏览器切换）
      getAllAccessibleWorkspaces: () => {
        return get().workspaces;
      },

      // ========== FileExplorer 浏览工作区操作 ==========

      // 设置 FileExplorer 当前浏览的工作区
      setViewingWorkspace: (id: string | null) => {
        set({ viewingWorkspaceId: id });
      },

      // 获取 FileExplorer 当前浏览的工作区
      getViewingWorkspace: () => {
        const state = get();
        // 如果没有设置浏览工作区，返回当前工作区
        if (!state.viewingWorkspaceId) {
          return state.workspaces.find(w => w.id === state.currentWorkspaceId) || null;
        }
        return state.workspaces.find(w => w.id === state.viewingWorkspaceId) || null;
      },

      // 获取按最近访问时间排序的工作区列表
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