/**
 * LayoutSwitcherMenu — 顶栏布局切换菜单
 *
 * 在 TopMenuBar 中提供一个 LayoutGrid 按钮,点击后弹出菜单:
 * - 5 套内置预设 (当前激活打勾)
 * - 用户自定义布局 (有则列出,无则显示空提示)
 * - 「保存当前为...」 (InputDialog,activePresetId === 'custom' 时强调)
 * - 「打开布局设置」 (走 navigate-to-settings 事件,跳到 layout tab)
 *
 * 设计要点:
 * - 不在 TopMenuBar 加新 prop,通过 window 自定义事件触发设置打开
 * - 'custom' 哨兵在 trigger 按钮上显示 ring 高亮提示
 * - InputDialog 校验空名称 / 重名
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, Check, Save, Settings as SettingsIcon, Bookmark, PanelLeft } from 'lucide-react'
import { DropdownMenu, InputDialog } from '@/components/Common'
import type { DropdownMenuItem } from '@/components/Common/DropdownMenu'
import { useLayoutStore, CUSTOM_PRESET_ID, LAYOUT_SLOT_IDS } from '@/stores/layoutStore'
import { BUILTIN_PRESETS } from '@/config/layoutPresets'
import { pluginRegistry } from '@/plugin-system'
import { useToastStore } from '@/stores/toastStore'
import type { ModuleId, SlotId } from '@/types/layout'

const SETTINGS_TAB_LAYOUT = 'layout' as const

export function LayoutSwitcherMenu() {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const activePresetId = useLayoutStore((s) => s.activePresetId)
  const customLayouts = useLayoutStore((s) => s.customLayouts)
  const slots = useLayoutStore((s) => s.slots)
  const applyPreset = useLayoutStore((s) => s.applyPreset)
  const saveAsCustomLayout = useLayoutStore((s) => s.saveAsCustomLayout)
  const setSlotActive = useLayoutStore((s) => s.setSlotActive)
  const toast = useToastStore()

  const [showSaveDialog, setShowSaveDialog] = useState(false)

  const isCustomActive = activePresetId === CUSTOM_PRESET_ID

  // 收集"折叠槽位": 有 modules 但 activeModule=null, 且该槽位至少有 1 个模块.
  // center 不在此列, 因为它由 tabStore 自动管理.
  type CollapsedSlot = { slot: Exclude<SlotId, 'center'>; firstModule: ModuleId }
  const collapsedSlots: CollapsedSlot[] = (
    LAYOUT_SLOT_IDS.filter((s) => s !== 'center') as Exclude<SlotId, 'center'>[]
  )
    .filter((slot) => slots[slot].activeModule === null && slots[slot].modules.length > 0)
    .map((slot) => ({ slot, firstModule: slots[slot].modules[0] as ModuleId }))

  const slotLabel = (slot: SlotId): string => t(`slot.${slot}`)
  const moduleLabel = (moduleId: ModuleId): string => {
    const contribution = pluginRegistry
      .listViewContributions('activityBar')
      .find((c) => c.moduleId === moduleId)
    if (!contribution) return moduleId
    return tCommon(contribution.labelKey, {
      defaultValue: contribution.labelDefault ?? moduleId,
    })
  }

  const handleExpandCollapsedSlot = (slot: SlotId, moduleId: ModuleId) => {
    setSlotActive(slot, moduleId)
    toast.success(t('toast.applied', { name: slotLabel(slot) }))
  }

  const presetLabel = (id: string): string => {
    const preset = BUILTIN_PRESETS.find((p) => p.id === id)
    if (!preset) return id
    if (preset.nameKey) {
      return t(preset.nameKey.replace(/^layout:/, ''))
    }
    return preset.name ?? preset.id
  }

  const handleApply = (id: string, displayName: string) => {
    applyPreset(id)
    toast.success(t('toast.applied', { name: displayName }))
  }

  const handleSaveAs = (name: string) => {
    try {
      saveAsCustomLayout(name)
      toast.success(t('toast.saved'), t('toast.savedDesc', { name }))
      setShowSaveDialog(false)
    } catch (e) {
      toast.error(t('toast.saveFailed'), e instanceof Error ? e.message : String(e))
    }
  }

  const validateLayoutName = (value: string): string | null => {
    const trimmed = value.trim()
    if (!trimmed) return t('saveDialog.errorEmpty')
    if (customLayouts.some((l) => l.name === trimmed)) {
      return t('saveDialog.errorDuplicate')
    }
    return null
  }

  // ============================================================
  // 构造菜单项
  // ============================================================
  const items: DropdownMenuItem[] = []

  // 内置预设
  BUILTIN_PRESETS.forEach((preset, index) => {
    const isActive = activePresetId === preset.id
    const displayName = presetLabel(preset.id)
    items.push({
      key: `preset-${preset.id}`,
      label: displayName,
      icon: <LayoutGrid size={14} className={isActive ? 'text-primary' : 'text-text-tertiary'} />,
      trailing: isActive ? <Check size={14} className="text-primary" /> : null,
      divider: index === 0, // 第一项前画分隔线作为分组标题感
      onClick: () => handleApply(preset.id, displayName),
    })
  })

  // 自定义布局
  if (customLayouts.length === 0) {
    items.push({
      key: 'custom-empty',
      label: t('menu.customEmpty'),
      icon: <Bookmark size={14} className="text-text-tertiary" />,
      disabled: true,
      divider: true,
      onClick: () => {},
    })
  } else {
    customLayouts.forEach((layout, idx) => {
      const isActive = activePresetId === layout.id
      items.push({
        key: `custom-${layout.id}`,
        label: layout.name,
        icon: <Bookmark size={14} className={isActive ? 'text-primary' : 'text-text-tertiary'} />,
        trailing: isActive ? <Check size={14} className="text-primary" /> : null,
        divider: idx === 0,
        onClick: () => handleApply(layout.id, layout.name),
      })
    })
  }

  // 折叠槽位恢复入口
  // - 有折叠槽位: 列出每个槽位 → 点击恢复首个模块为 active
  // - 无折叠槽位: 隐藏整组 (不显示空提示, 避免菜单噪音)
  if (collapsedSlots.length > 0) {
    collapsedSlots.forEach((entry, idx) => {
      const labelText = t('menu.expandCollapsedItem', {
        slot: slotLabel(entry.slot),
        module: moduleLabel(entry.firstModule),
      })
      items.push({
        key: `expand-${entry.slot}`,
        label: labelText,
        icon: <PanelLeft size={14} className="text-text-tertiary" />,
        divider: idx === 0,
        onClick: () => handleExpandCollapsedSlot(entry.slot, entry.firstModule),
      })
    })
  }

  // 操作组
  items.push({
    key: 'save-as',
    label: t('menu.saveAs'),
    icon: <Save size={14} />,
    variant: isCustomActive ? 'warning' : 'default',
    divider: true,
    onClick: () => setShowSaveDialog(true),
  })
  items.push({
    key: 'open-settings',
    label: t('menu.openSettings'),
    icon: <SettingsIcon size={14} />,
    onClick: () => {
      window.dispatchEvent(
        new CustomEvent('navigate-to-settings', { detail: { tab: SETTINGS_TAB_LAYOUT } })
      )
    },
  })

  // ============================================================
  // 触发按钮
  // ============================================================
  const trigger = (
    <button
      type="button"
      title={t('menu.buttonTitle')}
      className={`p-1.5 rounded-md transition-colors ${
        isCustomActive
          ? 'text-warning bg-warning/10 hover:bg-warning/20'
          : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
      }`}
      data-tauri-drag-region={false}
    >
      <LayoutGrid className="w-4 h-4" />
    </button>
  )

  return (
    <>
      <DropdownMenu trigger={trigger} items={items} align="right" />
      {showSaveDialog && (
        <InputDialog
          title={t('saveDialog.title')}
          message={t('saveDialog.message')}
          placeholder={t('saveDialog.placeholder')}
          validate={validateLayoutName}
          onConfirm={handleSaveAs}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}
    </>
  )
}
