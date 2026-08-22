import type { PolarisPluginManifest } from './types'
import { pluginRegistry } from './registry'
import { pluginPanelRegistry } from './panelRegistry'
import { chatCardRegistry } from './chatCardRegistry'
import { fileExplorerToolbarSlot } from './fileExplorerToolbarSlot'
import { GitStatusIndicator } from '@/components/FileExplorer/GitStatusIndicator'
import { registerGitEditorExtensions } from './editor'
import { computerPluginManifest } from '@/plugins/computer/manifest'
import { requirementPluginManifest } from '@/plugins/requirement/manifest'
import { schedulerPluginManifest } from '@/plugins/scheduler/manifest'
import { todoPluginManifest } from '@/plugins/todo/manifest'
import { personalHubPluginManifest } from '@/plugins/personal-hub/manifest'
import { prdPreviewPluginManifest } from '@/plugins/prd-preview/manifest'
import { agnesPluginManifest } from '@/plugins/agnes/manifest'
import { agentGalleryPluginManifest } from '@/plugins/agent-gallery/manifest'
import { askPluginManifest } from '@/plugins/ask/manifest'
import { dispatchPluginManifest } from '@/plugins/dispatch/manifest'
import { browserPluginManifest } from '@/plugins/browser/manifest'
import { engineTestPluginManifest } from '@/plugins/engine-test/manifest'
import { companionPluginManifest } from '@/plugins/companion/manifest'

const corePluginManifest: PolarisPluginManifest = {
  id: 'polaris.core',
  name: 'Polaris Core',
  version: '0.1.0',
  description: 'Polaris 内置基础面板入口。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'files.panel',
        area: 'activityBar',
        panelType: 'files',
        icon: 'Files',
        labelKey: 'labels.fileExplorer',
        labelDefault: 'File Explorer',
        order: 10,
        slot: 'files',
      },
      {
        id: 'git.panel',
        area: 'activityBar',
        panelType: 'git',
        icon: 'GitPullRequest',
        labelKey: 'labels.gitPanel',
        labelDefault: 'Git',
        order: 20,
        slot: 'git',
      },
      {
        id: 'browser.panel',
        area: 'activityBar',
        panelType: 'browser',
        icon: 'Globe2',
        labelKey: 'labels.browserPanel',
        labelDefault: 'Browser',
        order: 30,
        slot: 'browser',
      },
      {
        id: 'translate.panel',
        area: 'activityBar',
        panelType: 'translate',
        icon: 'Languages',
        labelKey: 'labels.translatePanel',
        labelDefault: 'Translate',
        order: 40,
        slot: 'translate',
      },
      {
        id: 'terminal.panel',
        area: 'activityBar',
        panelType: 'terminal',
        icon: 'Terminal',
        labelKey: 'labels.terminalPanel',
        labelDefault: 'Terminal',
        order: 70,
        slot: 'terminal',
      },
      {
        id: 'developer.panel',
        area: 'activityBar',
        panelType: 'developer',
        icon: 'Code2',
        labelKey: 'labels.developerPanel',
        labelDefault: 'Developer',
        order: 80,
        slot: 'developer',
      },
      {
        id: 'integration.panel',
        area: 'activityBar',
        panelType: 'integration',
        icon: 'Bot',
        labelKey: 'labels.integrationPanel',
        labelDefault: 'Integration',
        order: 90,
        slot: 'integration',
      },
      {
        id: 'aiConsole.panel',
        area: 'activityBar',
        panelType: 'aiConsole',
        icon: 'Activity',
        labelKey: 'labels.aiConsolePanel',
        labelDefault: 'AI Console',
        order: 95,
      },
    ],
  },
  permissions: {},
}

export function registerBuiltinPlugins(): void {
  pluginRegistry.register(corePluginManifest)
  // Git 编辑器集成（gutter / blame / 改动导航）注册到 editor extension slot
  registerGitEditorExtensions()
  pluginRegistry.register(schedulerPluginManifest)
  pluginRegistry.register(todoPluginManifest)
  pluginRegistry.register(requirementPluginManifest)
  pluginRegistry.register(prdPreviewPluginManifest)
  pluginRegistry.register(computerPluginManifest)
  pluginRegistry.register(personalHubPluginManifest)
  pluginRegistry.register(agnesPluginManifest)
  pluginRegistry.register(agentGalleryPluginManifest)
  pluginRegistry.register(askPluginManifest)
  pluginRegistry.register(dispatchPluginManifest)
  pluginRegistry.register(browserPluginManifest)
  pluginRegistry.register(engineTestPluginManifest)
  pluginRegistry.register(companionPluginManifest)

  // builtin 插件无 installPath，registry 不会自动注册 panel，需手动注册懒加载入口
  pluginPanelRegistry.register('agentGallery', 'polaris.agent-gallery', () =>
    import('@/components/Agent/AgentGalleryPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('engineTest', 'polaris.engine-test', () =>
    import('@/plugins/engine-test/EngineTestPanel').then((m) => ({ default: m.EngineTestPanel })),
  )
  pluginPanelRegistry.register('personalHub', 'polaris.personal-hub', () =>
    import('@/components/PersonalHub/PersonalHubPanel').then((m) => ({ default: m.PersonalHubPanel })),
  )
  pluginPanelRegistry.register('agnes', 'polaris.agnes', () =>
    import('@/plugins/agnes/AgnesPanel').then((m) => ({ default: m.default })),
  )
  // AI 主动陪伴助手：panelType='companion'
  pluginPanelRegistry.register('companion', 'polaris.companion', () =>
    import('@/components/Companion/CompanionPanel').then((m) => ({ default: m.CompanionPanel })),
  )
  // Git 状态指示器挂到文件树工具栏 slot（P0-5）
  fileExplorerToolbarSlot.register(
    'git-status',
    'polaris.core',
    GitStatusIndicator,
    10,
  )
  // builtin 插件聊天卡片 loader 手动注册（无 installPath）
  // PRD 预览：mcp__polaris-prd-preview__preview_html / read_preview
  chatCardRegistry.registerBuiltin(
    'polaris.prd-preview',
    {
      id: 'preview-card',
      mcpServerId: 'polaris-prd-preview',
      tools: ['preview_html', 'read_preview'],
      mode: 'result',
    },
    () => import('@/plugins/prd-preview/PrdPreviewCard').then((m) => ({ default: m.PrdPreviewCard })),
  )
  // Agnes 多模态：mcp__polaris-agnes__generate_image / generate_video / query_video
  chatCardRegistry.registerBuiltin(
    'polaris.agnes',
    {
      id: 'media-card',
      mcpServerId: 'polaris-agnes',
      tools: ['generate_image', 'generate_video', 'query_video'],
      mode: 'result',
    },
    () => import('@/plugins/agnes/AgnesMediaCard').then((m) => ({ default: m.AgnesMediaCard })),
  )
}

registerBuiltinPlugins()
