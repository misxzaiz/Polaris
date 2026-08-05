import { useMemo } from 'react'
import { Settings, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useViewStore } from '@/stores/viewStore'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { getToolGroup, type ToolSwitcherItem } from './ToolSwitcher'

interface UseToolSwitcherItemsOptions {
  onOpenSettings?: () => void
  onToggleRightPanel?: () => void
  rightPanelCollapsed?: boolean
}

function getToolDescription(panelType: string): string | undefined {
  switch (panelType) {
    case 'files':
      return '工作区文件、目录与引用'
    case 'git':
      return '变更、提交、分支与审查'
    case 'browser':
      return '学习网页、本地预览与 AI 页面上下文'
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
    case 'developer':
      return '开发者调试工具'
    case 'integration':
      return '外部平台与机器人接入'
    case 'aiConsole':
      return 'AI 执行记录与来源概览'
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
  const panelOrder = useViewStore((state) => state.panelOrder)

  // 获取所有面板，按自定义顺序或默认 order 排序
  const allPanels = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))

  const panelButtons = useMemo(() => {
    if (!panelOrder || panelOrder.length === 0) {
      return allPanels.sort((a, b) => a.order - b.order)
    }
    const orderMap = new Map(panelOrder.map((id, idx) => [id, idx]))
    return [...allPanels].sort((a, b) => {
      const oa = orderMap.get(a.id)
      const ob = orderMap.get(b.id)
      if (oa !== undefined && ob !== undefined) return oa - ob
      if (oa !== undefined) return -1
      if (ob !== undefined) return 1
      return a.order - b.order
    })
  }, [allPanels, panelOrder])

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
