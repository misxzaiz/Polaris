/**
 * 状态管理统一导出
 */

export { useConfigStore } from './configStore';
export { useThemeStore } from './themeStore';
// 兼容旧导出：Theme 类型仍可被引用，但已迁移到 types/theme
export type { Theme } from '../types/config';

export { useCommandStore } from './commandStore';
export { useWorkspaceStore } from './workspaceStore';
export { useFileExplorerStore } from './fileExplorerStore';
export { useFileEditorStore } from './fileEditorStore';
export { useViewStore } from './viewStore';
export { useGitStore } from './gitStore/index';
export { useTabStore } from './tabStore';
export { useEditorSettingsStore } from './editorSettingsStore';
export { useEditorContextStore } from './editorContextStore';
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
export { useToastStore, type Toast, type ToastType, type NotificationRecord } from './toastStore';
export { useSchedulerStore } from './schedulerStore';
export { useTerminalStore } from './terminalStore';
export { useRequirementStore } from './requirementStore';
export { useVoiceInputStore } from './voiceInputStore';
export { useModelProfileStore, getActiveModelProfile } from './modelProfileStore';
export { usePluginStore } from './pluginStore';
export type { PluginState, PluginStateMap, PluginStore } from './pluginStore';

export { useEngineMetadataStore, initEngineMetadata } from './engineMetadataStore';

export { useTokenAnalyticsStore } from './tokenAnalyticsStore';
export type {
  UsageSummary,
  ModelUsageStats,
  DailyUsageStats,
  UsageLogEntry,
  TimeRange,
} from './tokenAnalyticsStore';
