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
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import * as useActiveSession from '@/stores/conversationStore/useActiveSession'
import * as conversationStoreUtils from '@/stores/conversationStore/conversationStoreUtils'
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
import { useCompactHandoffStore } from '@/stores/compactHandoffStore'
import { useDispatchStore } from '@/stores/dispatchStore'
import { getEventRouter } from '@/services/eventRouter'
import { dialogStorageService, maybeAutoMigrateOpfs } from '@/services/dialogStorage'
import { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'
import * as chatService from '@/services/tauri/chatService'
import * as sessionRestore from '@/services/sessionRestore'
import * as sessionHandoff from '@/services/sessionHandoff'
import * as contextCompactHandoff from '@/services/contextCompactHandoff'
import * as promptOptimizeService from '@/services/promptOptimizeService'
import * as promptHistoryService from '@/services/promptHistoryService'
import * as dispatchTaskService from '@/services/dispatchTaskService'
import * as webReconnectResync from '@/services/webReconnectResync'
import { remoteSessionFollower } from '@/services/remoteSessionFollower'
import * as streamRateTracker from '@/services/streamRateTracker'
import * as uiDispatchService from '@/services/uiDispatchService'
import * as capSlashCommand from '@/services/capSlashCommand'
import * as cliSlashCommands from '@/services/cliSlashCommands'
import * as agentSlashCommand from '@/services/agentSlashCommand'
import * as conversationPackager from '@/services/conversationPackager'
import * as newSessionPrefsService from '@/services/newSessionPrefsService'
import * as fileSearch from '@/services/fileSearch'
import * as claudeSettingsService from '@/services/claudeSettingsService'
import { eventBus } from '@/services/eventBus'
import * as imageSaveService from '@/services/imageSaveService'
import * as linkExternal from '@/services/linkExternal'
import { invoke, listen, currentMode, emit } from '@/services/transport'
import { getKernel } from '@/session-v2/kernel/registry'
import { useKernelSessionState, subscribeKernelSessionState } from '@/session-v2/hooks/useKernelSessionState'
import * as aiRuntime from '@/ai-runtime'
import { pluginRegistry, chatCardRegistry, listEnabledPluginMcpServers } from '@/plugin-system'
import { Button } from '@/components/Common/Button'
import { JsonTreeView } from '@/components/Common/JsonTreeView'
import { OverlayGuard } from '@/components/Common/OverlayGuard'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import { Modal } from '@/components/Common/Modal'
import { DropdownMenu } from '@/components/Common/DropdownMenu'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import { WorkspaceBadge } from '@/components/Session/WorkspaceBadge'
import { WorkspaceMenu } from '@/components/Session/WorkspaceMenu'
import { WorkspaceSearchInput, useWorkspaceFilter } from '@/components/Workspace/WorkspaceSearchInput'
import { CreateWorkspaceModal } from '@/components/Workspace/CreateWorkspaceModal'
import * as Icons from '@/components/Common/Icons'
import { convertFileSrc } from '@tauri-apps/api/core'

/** 惰性挂载（main.tsx import 后立即执行） */
export function installAppCoreBridge(): void {
  ;(window as unknown as { __POLARIS_APP_CORE__: unknown }).__POLARIS_APP_CORE__ = {
    stores: {
      sessionStoreManager,
      useActiveSession,
      conversationStoreUtils,
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
      useCompactHandoffStore,
      useDispatchStore,
    },
    services: {
      getEventRouter,
      dialogStorageService,
      maybeAutoMigrateOpfs,
      aiChatDispatch,
      aiChatDispatchStream,
      chatService,
      sessionRestore,
      sessionHandoff,
      contextCompactHandoff,
      promptOptimizeService,
      promptHistoryService,
      dispatchTaskService,
      webReconnectResync,
      remoteSessionFollower,
      streamRateTracker,
      uiDispatchService,
      capSlashCommand,
      cliSlashCommands,
      agentSlashCommand,
      conversationPackager,
      newSessionPrefsService,
      fileSearch,
      claudeSettingsService,
      eventBus,
      imageSaveService,
      linkExternal,
      transport: { invoke, listen, currentMode, emit },
    },
    sessionV2: { getKernel, useKernelSessionState, subscribeKernelSessionState },
    aiRuntime,
    pluginSystem: { pluginRegistry, chatCardRegistry, listEnabledPluginMcpServers },
    components: {
      Button,
      JsonTreeView,
      OverlayGuard,
      ConfirmDialog,
      Modal,
      DropdownMenu,
      DiffViewer,
      WorkspaceBadge,
      WorkspaceMenu,
      WorkspaceSearchInput,
      useWorkspaceFilter,
      CreateWorkspaceModal,
      Icons,
    },
    tauri: { convertFileSrc },
  }
}
