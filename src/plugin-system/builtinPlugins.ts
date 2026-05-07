import type { PolarisPluginManifest } from './types'
import { pluginRegistry } from './registry'
import { todoPluginManifest } from '@/plugins/todo/manifest'

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
        id: 'scheduler.panel',
        area: 'activityBar',
        panelType: 'scheduler',
        icon: 'Clock',
        labelKey: 'labels.schedulerPanel',
        labelDefault: 'Scheduler',
        order: 50,
      },
      {
        id: 'requirement.panel',
        area: 'activityBar',
        panelType: 'requirement',
        icon: 'ClipboardList',
        labelKey: 'labels.requirementPanel',
        labelDefault: 'Requirements',
        order: 60,
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
        id: 'knowledge.panel',
        area: 'activityBar',
        panelType: 'knowledge',
        icon: 'BookOpen',
        labelKey: 'labels.knowledgePanel',
        labelDefault: 'Knowledge',
        order: 100,
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
  pluginRegistry.register(todoPluginManifest)
}

registerBuiltinPlugins()
