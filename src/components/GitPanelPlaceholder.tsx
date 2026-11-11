/**
 * Git 席位占位（2026-11-12 Git 面板插件化）：
 * 内置 GitPanel 已随 git-panel-to-plugin 迁出主仓（插件仓 plugins/polaris-git 承接，
 * 数据走 cap.git）。本组件仅作为 git.panel 席位的内置兜底渲染——插件
 * polaris-git 以 slotMode:'shadow' 接管本席位（LeftPanel shadowByBuiltinType），
 * 插件未安装/被禁用时席位显示本占位而非空白。
 * 保留共享资产：cap.git、gitStore（FileExplorer 徽章/CenterStage diff 消费）、
 * gitEditorService（编辑器 gutter/blame）、DiffViewer（Chat/中央 diff 复用）。
 */

import { useTranslation } from 'react-i18next'

export function GitPanelPlaceholder() {
  const { t } = useTranslation('common')
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
      <div className="text-sm text-text-primary">{t('gitPanelPlaceholder.title', { defaultValue: 'Git 面板已迁移为插件' })}</div>
      <div className="text-xs text-text-muted leading-relaxed">
        {t('gitPanelPlaceholder.hint', {
          defaultValue:
            '安装并启用 polaris-git 插件后，此席位由插件面板接管（状态/差异/历史/分支查询与暂存提交）。插件管理：设置 → 插件。',
        })}
      </div>
    </div>
  )
}
