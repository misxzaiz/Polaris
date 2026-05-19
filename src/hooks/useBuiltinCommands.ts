/**
 * useBuiltinCommands — 注册一组 V2 内置命令到 commandRegistry
 *
 * 在 App 顶层调用一次, 注册:
 *   - Layout: 应用每个内置预设 (5 个) + 重置 + 保存当前为我的布局
 *   - Navigate: 激活每个已绑定的模块
 *   - Action: 切换 ActivityBar 位置 + 切换 dock 模式
 *
 * 设计:
 *   - 全部命令在 mount 时 register, unmount 时 unregister
 *   - 命令的 perform 直接调 layoutStore action, 不经其他副作用
 *   - i18n key 已存在的从 layout namespace 取, 否则用 defaultValue
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  commandRegistry,
  type Command,
  type CommandCategory,
} from '@/services/commandRegistry'
import { useLayoutStore } from '@/stores/layoutStore'
import { useDetachedWindowStore } from '@/stores/detachedWindowStore'
import { BUILTIN_PRESETS } from '@/config/layoutPresets'
import { pluginRegistry, pluginIconMap } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import type { SlotId } from '@/types/layout'

export function useBuiltinCommands(): void {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const pluginStates = usePluginStore((s) => s.pluginStates)

  useEffect(() => {
    const commands: Command[] = []

    // ============================================================
    // Layout 类: 应用预设 / 重置 / 保存
    // ============================================================
    for (const preset of BUILTIN_PRESETS) {
      const presetName = preset.nameKey
        ? t(preset.nameKey, { defaultValue: preset.id })
        : preset.id
      commands.push({
        id: `layout.applyPreset.${preset.id}`,
        title: `${t('command.applyPreset', { defaultValue: '应用预设' })}: ${presetName}`,
        category: 'layout' as CommandCategory,
        description: preset.descriptionKey
          ? t(preset.descriptionKey, { defaultValue: '' })
          : undefined,
        icon: '📐',
        keywords: ['preset', 'layout', preset.id, presetName],
        perform: () => useLayoutStore.getState().applyPreset(preset.id),
      })
    }

    commands.push({
      id: 'layout.resetToDefault',
      title: t('command.resetLayout', { defaultValue: '重置布局为默认' }),
      category: 'layout',
      icon: '↺',
      keywords: ['reset', 'default', '重置'],
      perform: () => useLayoutStore.getState().resetToDefault(),
    })

    commands.push({
      id: 'layout.resetAppearance',
      title: t('command.resetAppearance', { defaultValue: '重置外观为默认' }),
      category: 'layout',
      icon: '🎨',
      keywords: ['appearance', 'default', '外观'],
      perform: () => useLayoutStore.getState().resetAppearance(),
    })

    // ============================================================
    // Layout 类: 外观切换 (density)
    // ============================================================
    for (const density of ['compact', 'standard', 'spacious'] as const) {
      commands.push({
        id: `layout.density.${density}`,
        title: `${t('command.setDensity', { defaultValue: '密度' })}: ${density}`,
        category: 'layout',
        icon: '☷',
        keywords: ['density', '密度', density],
        perform: () => useLayoutStore.getState().setAppearance({ density }),
      })
    }

    // ============================================================
    // Layout 类: 动效强度
    // ============================================================
    for (const lvl of ['off', 'minimal', 'standard', 'lively'] as const) {
      commands.push({
        id: `layout.motion.${lvl}`,
        title: `${t('command.setMotion', { defaultValue: '动效' })}: ${lvl}`,
        category: 'layout',
        icon: '✨',
        keywords: ['motion', '动效', lvl],
        perform: () =>
          useLayoutStore.getState().setAppearance({ transitionLevel: lvl }),
      })
    }

    // ============================================================
    // Action 类: ActivityBar 位置
    // ============================================================
    for (const pos of ['left', 'right', 'hidden'] as const) {
      commands.push({
        id: `layout.activityBar.${pos}`,
        title: `${t('command.activityBar', { defaultValue: 'ActivityBar 位置' })}: ${pos}`,
        category: 'action',
        icon: pos === 'left' ? '←' : pos === 'right' ? '→' : '·',
        keywords: ['activityBar', 'dock', pos],
        perform: () => useLayoutStore.getState().setActivityBarPosition(pos),
      })
    }

    // ============================================================
    // Navigate 类: 激活每个已注册的模块 (来自 plugin-system)
    // ============================================================
    const viewContributions = pluginRegistry
      .listViewContributions('activityBar')
      .filter((v) => isPluginUiEnabled(pluginStates, v.pluginId))

    for (const view of viewContributions) {
      const label = tCommon(view.labelKey, {
        defaultValue: view.labelDefault ?? view.moduleId,
      })
      commands.push({
        id: `navigate.open.${view.moduleId}`,
        title: `${tCommon('command.open', { defaultValue: '打开' })}: ${label}`,
        category: 'navigate',
        icon: pluginIconMap[view.icon] ? '◧' : undefined,
        keywords: [view.moduleId, label, 'open', 'goto'],
        perform: () => useLayoutStore.getState().activateModule(view.moduleId),
      })
    }

    // ============================================================
    // V2 Phase 5: Action 类 — Detach 模块到浮动窗口
    // chat 是 bareRender 模块, detach 后体验未充分验证, 暂不暴露
    // ============================================================
    for (const view of viewContributions) {
      if (view.moduleId === 'chat') continue
      const label = tCommon(view.labelKey, {
        defaultValue: view.labelDefault ?? view.moduleId,
      })
      commands.push({
        id: `window.detach.${view.moduleId}`,
        title: `${t('command.detach', { defaultValue: '分离到浮窗' })}: ${label}`,
        category: 'action',
        icon: '⤴',
        keywords: ['detach', 'float', 'window', view.moduleId, label],
        perform: () => {
          const slots = useLayoutStore.getState().slots
          // 找模块所在 slot, 移除
          for (const [slotId, slotState] of Object.entries(slots)) {
            if (slotState.modules.includes(view.moduleId)) {
              useLayoutStore
                .getState()
                .removeModuleFromSlot(view.moduleId, slotId as SlotId)
              break
            }
          }
          useDetachedWindowStore.getState().detach(view.moduleId)
        },
      })
    }

    // 全部注册, 返回单个 unregister all
    const off = commandRegistry.registerAll(commands)
    return off
    // 重新注册的触发因素: i18n 切换语言 / plugin 启用状态变化 → 命令文字与可用性都会变
  }, [t, tCommon, pluginStates])
}
