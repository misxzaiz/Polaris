import { beforeEach, describe, expect, it } from 'vitest'
import {
  isPluginMcpEnabled,
  isPluginUiEnabled,
  usePluginStore,
} from './pluginStore'

const pluginId = 'polaris.todo'

describe('pluginStore', () => {
  beforeEach(() => {
    localStorage.clear()
    usePluginStore.setState({ pluginStates: {} })
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

  it('can disable only the plugin UI surface', () => {
    usePluginStore.getState().setPluginUiEnabled(pluginId, false)

    const states = usePluginStore.getState().pluginStates
    expect(isPluginUiEnabled(states, pluginId)).toBe(false)
    expect(isPluginMcpEnabled(states, pluginId)).toBe(true)
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
})

