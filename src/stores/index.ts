/**
 * 状态管理统一导出
 */

export { useConfigStore } from './configStore';

// 统一的 Chat Store（基于 Tauri chat-event，支持历史管理）
export { useEventChatStore, type UnifiedHistoryItem } from './eventChatStore';

export { useCommandStore } from './commandStore';
export { useToolPanelStore, updateToolByName, updateToolByToolUseId } from './toolPanelStore';
export { useWorkspaceStore } from './workspaceStore';
export { useFileExplorerStore } from './fileExplorerStore';
export { useFileEditorStore } from './fileEditorStore';
export { useViewStore } from './viewStore';
export { useGitStore } from './gitStore';
export { useTabStore } from './tabStore';
export { useTranslateStore } from './translateStore';
export {
  useIntegrationStore,
  useIntegrationStatus,
  useIntegrationMessages,
  useIntegrationSessions,
  useIntegrationLoading,
  useIntegrationError,
  // 实例管理选择器
  useIntegrationInstances,
  useActiveIntegrationInstance,
  useHasActiveInstance,
} from './integrationStore';
export { useToastStore, type Toast, type ToastType } from './toastStore';
export { useSchedulerStore } from './schedulerStore';
export { useTerminalStore } from './terminalStore';
export { useChatInputStore } from './chatInputStore';
export { useRequirementStore } from './requirementStore';
export { useSessionStore, getSessionEffectiveWorkspace } from './sessionStore';
