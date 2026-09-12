import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPluginDefaultUi,
  getEffectivePluginState,
  getPluginDefaultUi,
  isPluginMcpEnabled,
  isPluginMcpServerEnabled,
  isPluginUiEnabled,
  registerPluginDefaultUi,
  usePluginStore,
} from './pluginStore'
import { loadPluginStates, savePluginStates } from '../services/pluginStateService'

vi.mock('../services/pluginStateService', () => ({
  loadPluginStates: vi.fn(),
  savePluginStates: vi.fn().mockResolvedValue(undefined),
}))

const pluginId = 'polaris.todo'
const mockedLoadPluginStates = vi.mocked(loadPluginStates)
const mockedSavePluginStates = vi.mocked(savePluginStates)

describe('pluginStore', () => {
  beforeEach(() => {
    localStorage.clear()
    mockedLoadPluginStates.mockReset()
    mockedSavePluginStates.mockReset()
    mockedSavePluginStates.mockResolvedValue(undefined)
    usePluginStore.setState({
      pluginStates: {},
      isLoading: false,
      error: null,
      hydratedFromBackend: false,
    })
  })

  it('uses enabled defaults for plugins without explicit state', () => {
    expect(usePluginStore.getState().getPluginState(pluginId)).toEqual({
      enabled: true,
      uiEnabled: true,
      mcpEnabled: true,
    })
    expect(usePluginStore.getState().isPluginUiEnabled(pluginId)).toBe(true)
    expect(usePluginStore.getState().isPluginMcpEnabled(pluginId)).toBe(true)
  })

  // ==========================================================================
  // 可见性单一权威源（plans/plugin-visibility-plan.md）：enabledByDefault 仅作
  // 无用户记录时的初始 uiEnabled 默认值，运行时唯一门 = isPluginUiEnabled
  // ==========================================================================

  describe('manifest visibility defaults', () => {
    const hiddenPlugin = 'polaris.agnes'

    beforeEach(() => {
      clearPluginDefaultUi(pluginId)
      clearPluginDefaultUi(hiddenPlugin)
    })

    it('unregistered plugin falls back to visible default', () => {
      expect(getPluginDefaultUi(hiddenPlugin)).toBe(true)
      expect(isPluginUiEnabled(usePluginStore.getState().pluginStates, hiddenPlugin)).toBe(true)
    })

    it('enabledByDefault=false hides UI by default but keeps MCP enabled', () => {
      registerPluginDefaultUi(hiddenPlugin, false)

      const state = getEffectivePluginState(usePluginStore.getState().pluginStates, hiddenPlugin)
      expect(state).toEqual({ enabled: true, uiEnabled: false, mcpEnabled: true })
      expect(isPluginUiEnabled(usePluginStore.getState().pluginStates, hiddenPlugin)).toBe(false)
      expect(isPluginMcpEnabled(usePluginStore.getState().pluginStates, hiddenPlugin)).toBe(true)
    })

    it('user record overrides manifest default (switch becomes effective)', () => {
      registerPluginDefaultUi(hiddenPlugin, false)
      usePluginStore.getState().setPluginUiEnabled(hiddenPlugin, true)

      // 有用户记录 → 记录决定（含与默认相反的值）
      expect(isPluginUiEnabled(usePluginStore.getState().pluginStates, hiddenPlugin)).toBe(true)

      usePluginStore.getState().setPluginUiEnabled(hiddenPlugin, false)
      expect(isPluginUiEnabled(usePluginStore.getState().pluginStates, hiddenPlugin)).toBe(false)
    })

    it('user record keeps default-visible plugin hidden after toggle off', () => {
      registerPluginDefaultUi(pluginId, true)
      usePluginStore.getState().setPluginUiEnabled(pluginId, false)
      expect(isPluginUiEnabled(usePluginStore.getState().pluginStates, pluginId)).toBe(false)
    })

    it('clearPluginDefaultUi removes the registered default', () => {
      registerPluginDefaultUi(hiddenPlugin, false)
      expect(getPluginDefaultUi(hiddenPlugin)).toBe(false)
      clearPluginDefaultUi(hiddenPlugin)
      expect(getPluginDefaultUi(hiddenPlugin)).toBe(true)
    })
  })

  it('can disable only the plugin UI surface', async () => {
    usePluginStore.getState().setPluginUiEnabled(pluginId, false)
    await Promise.resolve()

    const states = usePluginStore.getState().pluginStates
    expect(isPluginUiEnabled(states, pluginId)).toBe(false)
    expect(isPluginMcpEnabled(states, pluginId)).toBe(true)
    expect(mockedSavePluginStates).toHaveBeenCalledWith(states)
  })

  it('can disable one MCP server while keeping the plugin MCP surface enabled', async () => {
    usePluginStore.getState().setPluginMcpServerEnabled(pluginId, 'polaris-requirements', false)
    await Promise.resolve()

    const states = usePluginStore.getState().pluginStates
    expect(isPluginMcpEnabled(states, pluginId)).toBe(true)
    expect(isPluginMcpServerEnabled(states, pluginId, 'polaris-requirements')).toBe(false)
    expect(mockedSavePluginStates).toHaveBeenCalledWith(states)
  })

  it('disabling the plugin disables both UI and MCP effective access', () => {
    usePluginStore.getState().setPluginEnabled(pluginId, false)

    const states = usePluginStore.getState().pluginStates
    expect(isPluginUiEnabled(states, pluginId)).toBe(false)
    expect(isPluginMcpEnabled(states, pluginId)).toBe(false)
  })

  it('resetPluginState restores default behavior', () => {
    usePluginStore.getState().setPluginUiEnabled(pluginId, false)
    expect(usePluginStore.getState().isPluginUiEnabled(pluginId)).toBe(false)

    usePluginStore.getState().resetPluginState(pluginId)

    expect(usePluginStore.getState().isPluginUiEnabled(pluginId)).toBe(true)
  })

  it('loads plugin state from backend', async () => {
    mockedLoadPluginStates.mockResolvedValue({
      [pluginId]: {
        enabled: true,
        uiEnabled: false,
        mcpEnabled: true,
      },
    })

    await usePluginStore.getState().loadPluginStates()

    expect(usePluginStore.getState().hydratedFromBackend).toBe(true)
    expect(usePluginStore.getState().isPluginUiEnabled(pluginId)).toBe(false)
  })

  it('keeps local state when backend loading fails', async () => {
    mockedLoadPluginStates.mockRejectedValue(new Error('backend unavailable'))
    usePluginStore.getState().setPluginMcpEnabled(pluginId, false)
    mockedSavePluginStates.mockClear()

    await usePluginStore.getState().loadPluginStates()

    expect(usePluginStore.getState().error).toBe('backend unavailable')
    expect(usePluginStore.getState().isPluginMcpEnabled(pluginId)).toBe(false)
  })
})

