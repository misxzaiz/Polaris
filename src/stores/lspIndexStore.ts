/**
 * 索引引擎状态管理 + 工作区生命周期。
 *
 * 职责：
 * - 监听 workspaceStore 切换 → 自动 lsp_index_open（首次创建/打开 DB）
 * - 暴露：当前 workspace 的 IndexStatus、触发重建、订阅状态变更
 * - 接收后端 push 的 'lsp_index:status' 事件 → 更新 lspUiStore.indexStatuses
 *
 * 注：实际的 watcher 由后端 IndexService 在 open_workspace 内启动。
 */

import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  lspIndexOpen,
  lspIndexClose,
  lspIndexRebuild,
  lspIndexStatus,
  type IndexStatus,
} from '@/services/tauri/lspService';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLspUiStore } from '@/stores/lspUiStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('LspIndexStore');

interface LspIndexState {
  /** 当前活跃 workspace 的 status 快照（聚合从 lspUiStore.indexStatuses 拿） */
  currentStatus: IndexStatus | null;
  /** 已打开过的 workspace 集合（避免重复 open） */
  openedWorkspaces: Set<string>;
  /** 事件订阅句柄 */
  unlisten: UnlistenFn | null;

  /** 应用启动时调一次：注册事件监听 + 处理当前 workspace */
  init: () => Promise<void>;
  /** 切换/打开 workspace 时调用 */
  ensureOpen: (workspace: string) => Promise<void>;
  /** 关闭 workspace（用户切走或清理） */
  ensureClose: (workspace: string) => Promise<void>;
  /** 触发后台重建 */
  rebuild: (workspace: string) => Promise<void>;
  /** 主动拉一次状态（兜底） */
  refresh: (workspace: string) => Promise<void>;
}

export const useLspIndexStore = create<LspIndexState>((set, get) => ({
  currentStatus: null,
  openedWorkspaces: new Set(),
  unlisten: null,

  init: async () => {
    if (get().unlisten) return; // 已初始化

    try {
      const un = await listen<IndexStatus>('lsp_index:status', (event) => {
        const status = event.payload;
        useLspUiStore.getState().setIndexStatus(status);
        // 同步 currentStatus（仅当 workspace 与当前活跃 workspace 相同）
        const cur = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
        if (cur && status.workspace === normalizePath(cur)) {
          set({ currentStatus: status });
        }
      });
      set({ unlisten: un });
    } catch (err) {
      log.warn('failed to listen lsp_index:status', { error: String(err) });
    }

    // 当前 workspace 自动打开
    const ws = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
    if (ws) {
      await get().ensureOpen(ws);
    }

    // 监听 workspace 变更（zustand v5：(state, prevState) => void）
    let prevWorkspace: string | null =
      useWorkspaceStore.getState().getCurrentWorkspace?.()?.path ?? null;
    useWorkspaceStore.subscribe((state) => {
      const cur = state.getCurrentWorkspace?.()?.path ?? null;
      if (cur === prevWorkspace) return;
      const old = prevWorkspace;
      prevWorkspace = cur;
      if (old) void get().ensureClose(old);
      if (cur) void get().ensureOpen(cur);
    });
  },

  ensureOpen: async (workspace: string) => {
    if (get().openedWorkspaces.has(workspace)) {
      // 仍刷一次状态（DB 可能是上一次会话留下的）
      void get().refresh(workspace);
      return;
    }
    try {
      const status = await lspIndexOpen(workspace);
      set((s) => ({
        openedWorkspaces: new Set([...s.openedWorkspaces, workspace]),
        currentStatus: status,
      }));
      useLspUiStore.getState().setIndexStatus(status);
      // 没数据 → 自动后台构建
      if (status.files === 0) {
        log.debug('索引为空，触发首次后台构建', { workspace });
        await lspIndexRebuild(workspace);
      }
    } catch (err) {
      log.warn('lspIndexOpen failed', { workspace, error: String(err) });
    }
  },

  ensureClose: async (workspace: string) => {
    if (!get().openedWorkspaces.has(workspace)) return;
    try {
      await lspIndexClose(workspace);
    } catch (err) {
      log.warn('lspIndexClose failed', { workspace, error: String(err) });
    }
    set((s) => {
      const next = new Set(s.openedWorkspaces);
      next.delete(workspace);
      return { openedWorkspaces: next };
    });
    useLspUiStore.getState().clearIndexStatus(normalizePath(workspace));
  },

  rebuild: async (workspace: string) => {
    try {
      await lspIndexRebuild(workspace);
    } catch (err) {
      log.warn('lspIndexRebuild failed', { workspace, error: String(err) });
    }
  },

  refresh: async (workspace: string) => {
    try {
      const s = await lspIndexStatus(workspace);
      useLspUiStore.getState().setIndexStatus(s);
      set({ currentStatus: s });
    } catch (err) {
      log.warn('lspIndexStatus failed', { workspace, error: String(err) });
    }
  },
}));

/** 后端 canonicalize 后路径会把斜杠规整化；前端要保持比较一致 */
function normalizePath(p: string): string {
  return p;
}
