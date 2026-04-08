/**
 * 状态管理统一导出
 */

export { useConfigStore } from './configStore';

export { useCommandStore } from './commandStore';
export { useWorkspaceStore } from './workspaceStore';
export { useFileExplorerStore } from './fileExplorerStore';
export { useFileEditorStore } from './fileEditorStore';
export { useViewStore } from './viewStore';
export { useGitStore } from './gitStore';
export { useTabStore } from './tabStore';
export { useEditorBufferStore } from './editorBufferStore';
export { useEditorSettingsStore } from './editorSettingsStore';
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
