/**
 * TerminalSlotEmpty —— terminal.panel 席位空态引导卡（H5）
 *
 * 内置终端已出仓为 terminal-desk 插件（PTY 仍由宿主 cap.terminal 提供）。
 * 插件未安装/被禁用时本席位渲染此占位；**不含任何终端功能**——
 * 这不是隐藏兜底，而是插件生态标准空态（对齐 PluginSlotPlaceholder）。
 */
import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'

export function TerminalSlotEmpty() {
  const { t } = useTranslation('common')
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
      <Terminal size={32} className="text-text-tertiary" />
      <div className="text-sm text-text-primary">
        {t('terminalSlot.title', { defaultValue: '终端已迁移为插件' })}
      </div>
      <div className="text-xs text-text-muted leading-relaxed max-w-xs">
        {t('terminalSlot.hint', {
          defaultValue:
            '安装并启用 terminal-desk 插件后，此席位由插件面板接管（脚本中心、分屏、搜索、右键菜单；PTY 由宿主 cap.terminal 提供）。插件管理：设置 → 插件。',
        })}
      </div>
    </div>
  )
}
