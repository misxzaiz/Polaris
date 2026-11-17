/**
 * App Core 桥（ai-chat-plugin-extraction-spec P3 重构定案）
 *
 * chat-desk 面板要求「样式交互与旧版完全不变」——唯一可靠做法是把真实 Chat UI
 * 组件树搬进插件，而组件依赖的 stores/services 必须与宿主**同一实例**（否则
 * QuickSwitch/通知中心/设置页看到的会话状态与插件面板分裂）。
 *
 * 本桥在 main.tsx 装配一次，把宿主真实模块挂到 window.__POLARIS_APP_CORE__。
 * 插件侧经 src/core.ts 读取；插件内 `@/stores/...` 等导入路径由 esbuild alias
 * 指到插件内的 shim 文件，shim 再从这里取宿主实例。
 *
 * 安全边界：仅 core:true 插件（chat-desk，不可卸载）消费；与宿主同 window
 * 同源加载，无越权面扩大（这些能力本就在主窗口 Realm 内）。
 */
import { useConfigStore } from '@/stores/configStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/viewStore'
import { useToastStore } from '@/stores/toastStore'
import { useInputUIStore } from '@/stores/inputUIStore'
import { useUiSlotStore } from '@/stores/uiSlotStore'
import { useThemeStore } from '@/stores/themeStore'
import { useModelProfileStore } from '@/stores/modelProfileStore'
import { useSessionConfig } from '@/stores/sessionConfigStore'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { useCliInfoStore } from '@/stores/cliInfoStore'
import { useAgentStore } from '@/stores/agentStore'
import { useCapCatalogStore } from '@/stores/capCatalogStore'
import { usePluginStore } from '@/stores/pluginStore'
import { useOverlayStore } from '@/stores/overlayStore'
import { useSnippetStore } from '@/stores/snippetStore'
import { useSkillStore } from '@/stores/skillStore'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import { useFileExplorerStore } from '@/stores/fileExplorerStore'
import { useDispatchStore } from '@/stores/dispatchStore'
import { useCommandStore } from '@/stores/commandStore'
import { useNarrowTabStore } from '@/stores/narrowTabStore'
import { usePluginServiceStore } from '@/stores/pluginServiceStore'
import { useFocusModeStore } from '@/stores/focusModeStore'
import {
  dialogStorageService,
  maybeAutoMigrateOpfs,
  isOpfsMigrated,
  probeOpfsDialogCount,
  migrateOpfsToTauri,
  clearOpfsDialogs,
} from '@/services/dialogStorage'
import * as chatService from '@/services/tauri/chatService'
import * as tauriFileService from '@/services/tauri/fileService'
import * as promptHistoryService from '@/services/promptHistoryService'
import * as streamRateTracker from '@/services/streamRateTracker'
import * as uiDispatchService from '@/services/uiDispatchService'
import * as capSlashCommand from '@/services/capSlashCommand'
import * as cliSlashCommands from '@/services/cliSlashCommands'
import * as agentSlashCommand from '@/services/agentSlashCommand'
import * as conversationPackager from '@/services/conversationPackager'
import * as newSessionPrefsService from '@/services/newSessionPrefsService'
import * as fileSearch from '@/services/fileSearch'
import * as claudeSettingsService from '@/services/claudeSettingsService'
import * as workspaceReference from '@/services/workspaceReference'
import * as detector from '@/services/transport/detector'
import * as aiHistoryDispatch from '@/services/aiHistoryDispatch'
import * as schedulerStoreUtils from '@/stores/schedulerStoreUtils'
import { eventBus } from '@/services/eventBus'
import { getEventBus as getHostAiEventBus } from '@/services/aiEventBus'
import { useTransitionState } from '@/hooks/useTransitionState'
import { useContainerWidth } from '@/hooks/useContainerWidth'
import * as imageSaveService from '@/services/imageSaveService'
import * as linkExternal from '@/services/linkExternal'
import { invoke, listen, currentMode, emit } from '@/services/transport'
import { pluginRegistry, chatCardRegistry, pluginTabRendererRegistry, listEnabledPluginMcpServers, listPluginMcpServerStatuses } from '@/plugin-system'
import { getPluginIconComponent } from '@/plugin-system/iconResolver'
import * as pluginConfigApi from '@/plugin-system/pluginConfig'
import * as pluginDiscoveryService from '@/services/pluginDiscoveryService'
import * as pluginToolService from '@/services/pluginToolService'
import * as mcpHealthService from '@/services/mcpHealthService'
import { pluginServiceManager } from '@/services/pluginServiceManager'
import * as dataRootService from '@/services/dataRootService'
import * as autolaunchService from '@/services/autolaunchService'
import * as appUpdateService from '@/services/appUpdateService'
import * as updateService from '@/services/updateService'
import { useSystemPromptStore, getSystemPromptConfigDirect } from '@/services/systemPromptStore'
import * as windowService from '@/services/tauri/windowService'
import * as configService from '@/services/tauri/configService'
import { Button } from '@/components/Common/Button'
import { ExternalLink } from '@/components/Common/ExternalLink'
import { JsonTreeView } from '@/components/Common/JsonTreeView'
import { OverlayGuard } from '@/components/Common/OverlayGuard'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import { Modal } from '@/components/Common/Modal'
import { DropdownMenu } from '@/components/Common/DropdownMenu'
import { WorkspaceSearchInput, useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import * as Icons from '@/components/Common/Icons'
import { convertFileSrc } from '@tauri-apps/api/core'
import i18n from '@/i18n'

/** 惰性挂载（main.tsx import 后立即执行） */
export function installAppCoreBridge(): void {
  ;(window as unknown as { __POLARIS_APP_CORE__: unknown }).__POLARIS_APP_CORE__ = {
    stores: {
      useConfigStore,
      useWorkspaceStore,
      useViewStore,
      useToastStore,
      useInputUIStore,
      useUiSlotStore,
      useThemeStore,
      useModelProfileStore,
      useSessionConfig,
      useEngineMetadataStore,
      useCliInfoStore,
      useAgentStore,
      useCapCatalogStore,
      usePluginStore,
      useOverlayStore,
      useSnippetStore,
      useSkillStore,
      useFileEditorStore,
      useFileExplorerStore,
      useDispatchStore,
      useCommandStore,
      useNarrowTabStore,
      usePluginServiceStore,
      useFocusModeStore,
      useSystemPromptStore,
      sessionDirectoryStore: (window as any).__POLARIS_APP_CORE__?.stores?.sessionDirectoryStore,
    },
    services: {
      dialogStorageService,
      opfsHelpers: { isOpfsMigrated, probeOpfsDialogCount, migrateOpfsToTauri, clearOpfsDialogs },
      maybeAutoMigrateOpfs,
      chatService,
      promptHistoryService,
      streamRateTracker,
      uiDispatchService,
      capSlashCommand,
      cliSlashCommands,
      agentSlashCommand,
      conversationPackager,
      newSessionPrefsService,
      fileSearch,
      claudeSettingsService,
      workspaceReference,
      detector,
      aiHistoryDispatch,
      schedulerStoreUtils,
      eventBus,
      // 宿主 AIEvent 总线（services/aiEventBus 单例）：chat-desk sessionStoreManager
      // 补发 chat-event 时经此桥转发到宿主，pluginToolUsageObserver 的
      // tool_call_end 观测才能收到（插件内 ai-runtime/event-bus 是另一实例，互不相通）。
      hostAiEventBus: getHostAiEventBus(),
      imageSaveService,
      linkExternal,
      transport: { invoke, listen, currentMode, emit },
      // K-R5 批B：files-desk deps.tauri 的数据源（readDirectory/fsWatchStart 等全量 fileService）
      tauri: tauriFileService,
      // settings-desk 桥面（plans/settings-desk-extraction-spec.md）：插件管理/健康/
      // 数据根/自启/更新/系统提示词等服务，全部走总线或既有 service 单例
      pluginDiscoveryService,
      pluginToolService,
      // settings-desk PluginTab 的插件视图图标解析（deps.ts 走 services 命名空间取）
      getPluginIconComponent,
      mcpHealthService,
      pluginServiceManager,
      dataRootService,
      autolaunchService,
      appUpdateService,
      updateService,
      systemPromptStore: { useSystemPromptStore, getSystemPromptConfigDirect },
      windowService,
      configService,
    },
    // hooks 桥：files-desk deps.ts 的 useTransitionState 转发经 core().hooks 取宿主
    // 同名 hook（宿主 ConfirmDialog/Modal 等共享件内部也用它，保证过渡时序一致）。
    hooks: { useTransitionState, useContainerWidth },
    i18n,
    pluginSystem: { pluginRegistry, chatCardRegistry, pluginTabRendererRegistry, listEnabledPluginMcpServers, listPluginMcpServerStatuses },
    // settings-desk 桥面：图标解析 + 插件配置读写（PluginTab/PluginConfigForm 消费）
    getPluginIconComponent,
    pluginConfig: pluginConfigApi,
    components: {
      Button,
      JsonTreeView,
      OverlayGuard,
      ConfirmDialog,
      Modal,
      DropdownMenu,
      WorkspaceSearchInput,
      useWorkspaceFilter,
      CreateWorkspaceModal,
      Icons,
      // settings-desk 桥面：外链组件（AppUpdateTab 发布链接）
      ExternalLink,
    },
    tauri: { convertFileSrc },
  }
}
