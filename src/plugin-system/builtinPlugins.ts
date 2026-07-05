import type { PolarisPluginManifest } from './types'
import { pluginRegistry } from './registry'
import { pluginPanelRegistry } from './panelRegistry'
import { computerPluginManifest } from '@/plugins/computer/manifest'
import { requirementPluginManifest } from '@/plugins/requirement/manifest'
import { schedulerPluginManifest } from '@/plugins/scheduler/manifest'
import { todoPluginManifest } from '@/plugins/todo/manifest'
import { personalHubPluginManifest } from '@/plugins/personal-hub/manifest'
import { prdPreviewPluginManifest } from '@/plugins/prd-preview/manifest'
import { agnesPluginManifest } from '@/plugins/agnes/manifest'

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
      },
      {
        id: 'git.panel',
        area: 'activityBar',
        panelType: 'git',
        icon: 'GitPullRequest',
        labelKey: 'labels.gitPanel',
        labelDefault: 'Git',
        order: 20,
      },
      {
        id: 'translate.panel',
        area: 'activityBar',
        panelType: 'translate',
        icon: 'Languages',
        labelKey: 'labels.translatePanel',
        labelDefault: 'Translate',
        order: 40,
      },
      {
        id: 'terminal.panel',
        area: 'activityBar',
        panelType: 'terminal',
        icon: 'Terminal',
        labelKey: 'labels.terminalPanel',
        labelDefault: 'Terminal',
        order: 70,
      },
      {
        id: 'springBoot.panel',
        area: 'activityBar',
        panelType: 'springBoot',
        icon: 'Coffee',
        labelKey: 'labels.springBootPanel',
        labelDefault: 'Spring Boot',
        order: 75,
      },
      {
        id: 'developer.panel',
        area: 'activityBar',
        panelType: 'developer',
        icon: 'Code2',
        labelKey: 'labels.developerPanel',
        labelDefault: 'Developer',
        order: 80,
      },
      {
        id: 'integration.panel',
        area: 'activityBar',
        panelType: 'integration',
        icon: 'Bot',
        labelKey: 'labels.integrationPanel',
        labelDefault: 'Integration',
        order: 90,
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
      {
        id: 'problems.panel',
        area: 'activityBar',
        panelType: 'problems',
        icon: 'AlertCircle',
        labelKey: 'labels.problemsPanel',
        labelDefault: 'Problems',
        order: 110,
        badge: 'problems',
      },
    ],
  },
  permissions: {},
}

export function registerBuiltinPlugins(): void {
  pluginRegistry.register(corePluginManifest)
  pluginRegistry.register(schedulerPluginManifest)
  pluginRegistry.register(todoPluginManifest)
  pluginRegistry.register(requirementPluginManifest)
  pluginRegistry.register(prdPreviewPluginManifest)
  pluginRegistry.register(computerPluginManifest)
  pluginRegistry.register(personalHubPluginManifest)
  pluginRegistry.register(agnesPluginManifest)

  // builtin 插件无 installPath，registry 不会自动注册 panel，需手动注册懒加载入口
  pluginPanelRegistry.register('personalHub', 'polaris.personal-hub', () =>
    import('@/components/PersonalHub/PersonalHubPanel').then((m) => ({ default: m.PersonalHubPanel })),
  )
  pluginPanelRegistry.register('agnes', 'polaris.agnes', () =>
    import('@/plugins/agnes/AgnesPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('springBoot', 'polaris.core', () =>
    import('@/components/SpringBoot/SpringBootPanel').then((m) => ({ default: m.SpringBootPanel })),
  )
}

registerBuiltinPlugins()
