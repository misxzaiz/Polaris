/**
 * UI 域分发服务（cap.ui.*）
 *
 * 职责：把 AI 经 bus_dispatch 调用的 cap.ui 参数映射为前端 store 动作。
 *
 * 架构位（对齐 AGENTS.md §3.1 service 层 + 迁移样板 dataRootService.ts 的「业务签名
 * 不变、内部走统一通道」思路）：本服务不 invoke 后端 RouterBus（cap 执行在 MCP 侧已完成，
 * 经引擎 tool_call 事件回到前端），只做「事件参数 → store 动作」的纯前端映射。
 *
 * 状态真相仍在前端 store（themeStore / configStore / inputUIStore / uiSlotStore）：
 * - cap.ui.theme   → themeStore（主题 DOM 写入 + localStorage 持久化 + 服务端 config 同步）
 * - cap.ui.chat    → configStore.updateConfigPatch({ chatDisplay })（现有 ChatDisplay 链路）
 * - cap.ui.input   → inputUIStore（悬浮层/上下文条/横幅）
 * - cap.self.mutate → uiSlotStore（具名组件插槽注入/替换/移除）
 *
 * 效果链路：AI 工具调用 → MCP bus_dispatch → RouterBus cap 校验+审计 → 引擎 tool_call_start
 * 事件 → eventHandler → 本服务 applyCapUi → store 动作 → DOM 即时生效。三端同一 React 入口。
 */

import { createLogger } from '@/utils/logger'
import { applyInputUiConfig } from '@/stores/inputUIStore'
import { applySelfMutateAction } from '@/stores/uiSlotStore'
import { useThemeStore } from '@/stores/themeStore'
import { useConfigStore } from '@/stores/configStore'
import { BUILT_IN_THEME_IDS } from '@/types/theme'
import type { ThemeDefinition } from '@/types/theme'
import { invoke } from '@/services/transport'

const log = createLogger('UiDispatchService')

/** AI palette patch 的语义色键 → ThemeDefinition.colors 深层路径 */
const SEMANTIC_COLOR_PATHS: Record<string, string[]> = {
  // 语义键（AI 输入的扁平键）→ colors 内的点分路径
  'primary.base': ['primary', 'base'],
  'primary.hover': ['primary', 'hover'],
  'primary.50': ['primary', '50'],
  'primary.100': ['primary', '100'],
  'primary.200': ['primary', '200'],
  'primary.300': ['primary', '300'],
  'primary.400': ['primary', '400'],
  'primary.500': ['primary', '500'],
  'primary.600': ['primary', '600'],
  'primary.700': ['primary', '700'],
  'background.base': ['background', 'base'],
  'background.elevated': ['background', 'elevated'],
  'background.surface': ['background', 'surface'],
  'background.hover': ['background', 'hover'],
  'background.active': ['background', 'active'],
  'background.tertiary': ['background', 'tertiary'],
  'background.secondary': ['background', 'secondary'],
  'border.base': ['border', 'base'],
  'text.primary': ['text', 'primary'],
  'text.secondary': ['text', 'secondary'],
  'text.tertiary': ['text', 'tertiary'],
  'text.muted': ['text', 'muted'],
  'status.warning': ['status', 'warning'],
  'status.success': ['status', 'success'],
  'status.danger': ['status', 'danger'],
  'status.info': ['status', 'info'],
  'status.done': ['status', 'done'],
  'status.failed': ['status', 'failed'],
  'status.neutral': ['status', 'neutral'],
  'priority.low': ['priority', 'low'],
  'priority.normal': ['priority', 'normal'],
  'priority.high': ['priority', 'high'],
  'priority.urgent': ['priority', 'urgent'],
  'accent.ai': ['accent', 'ai'],
  'accent.prototype': ['accent', 'prototype'],
  'accent.workspace': ['accent', 'workspace'],
  'overlay': ['misc', 'overlay'],
  'onPrimary': ['misc', 'onPrimary'],
  'canvas': ['misc', 'canvas'],
  'tagBg': ['misc', 'tagBg'],
  'shadow': ['misc', 'shadow'],
}

/** 顶层关键字段（非 colors 语义色，AI 可 patch 的子集） */
const SEMANTIC_TOP_KEYS = new Set([
  'chatFontSize', 'chatLineHeight', 'chatCodeFontSize', 'chatInputFontSize',
  'radiusSm', 'radiusMd', 'radiusLg', 'radiusXl', 'radiusFull', 'chatBubbleRadius',
])

/**
 * 应用 cap.ui.theme 动作到 themeStore。
 * 返回 { ok, message } 供工具结果回显（前端不替代后端返回，仅消费记录）。
 */
export function applyUiThemeAction(action: string, payload: Record<string, unknown>): { ok: boolean; message: string } {
  const themeStore = useThemeStore.getState()
  try {
    switch (action) {
      case 'get': {
        const { activeThemeId } = themeStore
        return { ok: true, message: `activeThemeId=${activeThemeId}` }
      }
      case 'applyPreset': {
        const preset = String(payload.preset ?? '')
        const presetIds: Record<string, string> = {
          dark: BUILT_IN_THEME_IDS.DARK,
          light: BUILT_IN_THEME_IDS.LIGHT,
          spiderman: BUILT_IN_THEME_IDS.SPIDERMAN,
        }
        const id = presetIds[preset]
        if (!id) return { ok: false, message: `未知内置主题 preset: ${preset}` }
        useThemeStore.getState().setThemeById(id)
        return { ok: true, message: `已切换内置主题 ${preset}` }
      }
      case 'patch': {
        const palette = (payload.palette ?? {}) as Record<string, unknown>
        const keys = Object.keys(palette)
        if (keys.length === 0) return { ok: false, message: 'palette 为空' }
        // 基于当前激活主题克隆为新用户主题（saveTheme 拒绝 builtIn，必须克隆）
        const state = useThemeStore.getState()
        const base = state.activeTheme ?? state.themes.find(t => t.id === state.activeThemeId)
        if (!base) return { ok: false, message: '无激活主题可 patch' }
        const now = new Date().toISOString()
        const patched: ThemeDefinition = {
          ...base,
          id: crypto.randomUUID(),
          name: `AI 调色 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
          builtIn: false,
          createdAt: now,
          updatedAt: now,
          colors: deepClone(base.colors),
        }
        let changed = 0
        for (const key of keys) {
          const value = String(palette[key])
          const path = SEMANTIC_COLOR_PATHS[key]
          if (path) {
            setNested(patched.colors as unknown as Record<string, unknown>, path, value)
            changed++
          } else if (SEMANTIC_TOP_KEYS.has(key)) {
            ;(patched as unknown as Record<string, unknown>)[key] = value
            changed++
          }
        }
        if (changed === 0) {
          return { ok: false, message: `palette 无可用语义键: ${keys.join(',')}` }
        }
        useThemeStore.getState().saveTheme(patched)
        useThemeStore.getState().setThemeById(patched.id)
        return { ok: true, message: `已应用 ${changed} 个配色变更，新主题 ${patched.name}` }
      }
      case 'setActive': {
        const id = String(payload.id ?? '')
        if (!id) return { ok: false, message: '缺少 id' }
        const exists = useThemeStore.getState().themes.some(t => t.id === id)
        if (!exists) return { ok: false, message: `主题不存在: ${id}` }
        useThemeStore.getState().setThemeById(id)
        return { ok: true, message: `已切换到主题 ${id}` }
      }
      case 'listThemes': {
        const themes = useThemeStore.getState().themes.map(t => ({ id: t.id, name: t.name, builtIn: !!t.builtIn }))
        return { ok: true, message: `主题列表(${themes.length}): ${themes.map(t => `${t.name}(${t.id.slice(0, 8)})`).join(', ')}` }
      }
      case 'export': {
        const theme = themeStore.activeTheme
        return theme
          ? { ok: true, message: JSON.stringify(theme) }
          : { ok: false, message: '无激活主题' }
      }
      case 'import': {
        const theme = payload.theme as ThemeDefinition
        if (!theme || typeof theme !== 'object') return { ok: false, message: '缺少 theme 对象' }
        const now = new Date().toISOString()
        const imported: ThemeDefinition = {
          ...theme,
          id: crypto.randomUUID(),
          builtIn: false,
          createdAt: now,
          updatedAt: now,
        }
        useThemeStore.getState().saveTheme(imported)
        useThemeStore.getState().setThemeById(imported.id)
        return { ok: true, message: `已导入主题 ${imported.name ?? '(未命名)'}` }
      }
      default:
        return { ok: false, message: `cap.ui.theme 未知动作: ${action}` }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('applyUiThemeAction failed', err, { action: String(action) })
    return { ok: false, message: `应用主题失败: ${err.message}` }
  }
}

/**
 * 应用 cap.ui.chat 动作到 configStore（复用现有 chatDisplay 链路）。
 */
export function applyUiChatAction(action: string, payload: Record<string, unknown>): { ok: boolean; message: string } {
  try {
    switch (action) {
      case 'get': {
        const config = useConfigStore.getState().config
        return { ok: true, message: JSON.stringify(config?.chatDisplay ?? null) }
      }
      case 'patch': {
        const patch = (payload.config ?? {}) as Record<string, unknown>
        const keys = Object.keys(patch)
        if (keys.length === 0) return { ok: false, message: 'config 为空' }
        const configStore = useConfigStore.getState()
        const current = configStore.config?.chatDisplay ?? {}
        // 异步持久化（经 cap.config → 服务端，跨端同步）；DOM 由 getChatDisplayStyleVars 消费
        void configStore.updateConfigPatch({ chatDisplay: { ...current, ...patch } as never })
        return { ok: true, message: `已应用对话渲染配置: ${keys.join(', ')}` }
      }
      case 'reset': {
        void useConfigStore.getState().updateConfigPatch({ chatDisplay: null as never })
        return { ok: true, message: '已重置对话渲染配置为默认' }
      }
      default:
        return { ok: false, message: `cap.ui.chat 未知动作: ${action}` }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('applyUiChatAction failed', err, { action: String(action) })
    return { ok: false, message: `应用对话渲染配置失败: ${err.message}` }
  }
}

/**
 * 解析 bus_dispatch 的 args，命中 cap.ui / cap.self 时应用。
 * @returns 是否命中（true = 已消费）
 */
export function consumeCapUiDispatch(
  args: Record<string, unknown> | undefined,
): { consumed: boolean; message?: string } {
  if (!args || typeof args !== 'object') return { consumed: false }
  const target = args.target as string | undefined
  if (!target || !['cap.ui.theme', 'cap.ui.chat', 'cap.ui.input', 'cap.self.mutate'].includes(target)) {
    return { consumed: false }
  }
  const payload = (args.payload ?? {}) as Record<string, unknown>
  const action = payload.action as string | undefined
  if (!action) return { consumed: true, message: `${target} 缺 action` }
  let result
  if (target === 'cap.self.mutate') {
    result = applySelfMutateAction(action, payload)
  } else {
    result = target === 'cap.ui.theme'
      ? applyUiThemeAction(action, payload)
      : target === 'cap.ui.chat'
        ? applyUiChatAction(action, payload)
        : applyInputUiConfig(action, payload)
  }
  return { consumed: true, message: result.message }
}

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

/**
 * 经 RouterBus dispatch 调用任意 cap（前端 → 后端总线）。
 * 供动态横幅动作等场景使用：AI 注入横幅 → 用户点击 → 前端直接调目标 cap。
 */
export async function dispatchCapUiAction(
  target: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: { target, payload },
  })
  if (!res.ok) {
    throw new Error(res.error || `${target} 调用失败`)
  }
  return res.result || {}
}

// ============ 工具函数 ============

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T
}

/** 按路径写入嵌套值（path 为字符串数组） */
function setNested(obj: Record<string, unknown>, path: string[], value: string): void {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const next = cur[key]
    if (!next || typeof next !== 'object') {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}
