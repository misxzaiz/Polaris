import { useMemo } from 'react'
import { Settings, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDiagnosticsStore } from '@/stores/diagnosticsStore'
import { useViewStore } from '@/stores/viewStore'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { getToolGroup, type ToolSwitcherItem } from './ToolSwitcher'

interface UseToolSwitcherItemsOptions {
  onOpenSettings?: () => void
  onToggleRightPanel?: () => void
  rightPanelCollapsed?: boolean
}

export function ProblemsCountBadge({ floating = true }: { floating?: boolean }) {
  useDiagnosticsStore((s) => s.version)
  const { errors, warnings } = useDiagnosticsStore.getState().summary
  const total = errors + warnings
  if (total === 0) return null

  return (
    <span
      className={`${floating ? 'absolute -right-0.5 -bottom-0.5' : ''} min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white ${
        errors > 0 ? 'bg-red-500' : 'bg-yellow-500'
      }`}
    >
      {total > 99 ? '99+' : total}
    </span>
  )
}

function getToolDescription(panelType: string): string | undefined {
  switch (panelType) {
    case 'files':
      return '工作区文件、目录与引用'
    case 'git':
      return '变更、提交、分支与审查'
    case 'todo':
      return '工作区待办与任务拆解'
    case 'translate':
      return '选中文本与消息翻译'
    case 'scheduler':
      return '定时任务和执行控制'
    case 'requirement':
      return '需求库、生成与追踪'
    case 'personalHub':
      return '个人链接与知识收藏'
    case 'terminal':
      return '命令、脚本与运行环境'
    case 'springBoot':
      return 'Spring Boot 运行、调试与热部署'
    case 'developer':
      return '开发者调试工具'
    case 'integration':
      return '外部平台与机器人接入'
    case 'aiConsole':
      return 'AI 执行记录与来源概览'
    case 'problems':
      return '诊断、错误和警告'
    case 'demoPlugin':
      return '示例插件面板'
    default:
      return undefined
  }
}

export function useToolSwitcherItems({
  onOpenSettings,
  onToggleRightPanel,
  rightPanelCollapsed,
}: UseToolSwitcherItemsOptions) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const closeLeftPanel = useViewStore((state) => state.closeLeftPanel)
  const pluginStates = usePluginStore((state) => state.pluginStates)

  const panelButtons = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))

  const activePanel = panelButtons.find((btn) => btn.panelType === leftPanelType)
  const activePanelLabel = leftPanelType !== 'none' && activePanel
    ? t(activePanel.labelKey, { defaultValue: activePanel.labelDefault ?? activePanel.panelType })
    : undefined

  const toolSwitcherItems: ToolSwitcherItem[] = useMemo(() => {
    const panelItems: ToolSwitcherItem[] = panelButtons.map((btn) => {
      const Icon = pluginIconMap[btn.icon]
      return {
        id: btn.id,
        icon: Icon,
        label: t(btn.labelKey, { defaultValue: btn.labelDefault ?? btn.panelType }),
        description: getToolDescription(btn.panelType),
        group: getToolGroup(btn.panelType),
        active: leftPanelType === btn.panelType,
        badge: btn.badge === 'problems' ? <ProblemsCountBadge floating={false} /> : undefined,
        onSelect: () => toggleLeftPanel(btn.panelType),
      }
    })

    return [
      ...panelItems,
      {
        id: 'rightPanel',
        icon: PanelRight,
        label: rightPanelCollapsed ? t('labels.showAIPanel') : t('labels.hideAIPanel'),
        description: '显示或隐藏右侧 AI 工作区',
        group: 'system',
        active: !rightPanelCollapsed,
        onSelect: onToggleRightPanel || (() => {}),
      },
      {
        id: 'settings',
        icon: Settings,
        label: t('labels.settings'),
        description: '应用设置、模型和插件配置',
        group: 'system',
        active: false,
        onSelect: onOpenSettings || (() => {}),
      },
    ]
  }, [leftPanelType, onOpenSettings, onToggleRightPanel, panelButtons, rightPanelCollapsed, t, toggleLeftPanel])

  return { panelButtons, toolSwitcherItems, activePanelLabel, closeLeftPanel }
}
