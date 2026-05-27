/**
 * 工作区路径同步 Hook
 *
 * 负责将当前工作区路径同步到后端配置
 */

import { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import * as tauri from '@/services/tauri';
import { createLogger } from '@/utils/logger';

const log = createLogger('WorkspaceSync');

export function useWorkspaceSync(isAppInitialized: boolean) {
  const currentWorkspacePath = useWorkspaceStore(
    state => {
      const ws = state.workspaces.find(w => w.id === state.currentWorkspaceId);
      return ws?.path ?? null;
    }
  );

  useEffect(() => {
    if (!currentWorkspacePath || !isAppInitialized) return;

    const syncWorkspace = async () => {
      try {
        await tauri.setWorkDir(currentWorkspacePath);
        log.info('Workspace path synced', { path: currentWorkspacePath });
      } catch (error) {
        log.error('Failed to sync workspace path', error instanceof Error ? error : new Error(String(error)));
      }
    };

    syncWorkspace();
  }, [currentWorkspacePath, isAppInitialized]);
}
