/**
 * cap.ui 暴露门控测试：`getDisabledPluginMcpServers` 按 `config.uiControlEnabled`
 * 决定是否禁用 bus MCP（polaris-bus）。
 *
 * 门控语义（spec §4 约定）：
 * - `uiControlEnabled` 缺省 / false（默认）→ bus MCP 被禁，AI 工具集不含 bus_dispatch，无 cap.ui.*
 * - `uiControlEnabled` 为 true → bus MCP 正常暴露，AI 可经 bus_dispatch 调 cap.ui.theme / cap.ui.chat
 *
 * 与后端 `policy_permission.rs` 的内置 Remote-deny 双保险互补：此处管「本地 AI 工具暴露」，
 * 后端管「远程来源统一拒绝」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDisabledPluginMcpServers } from './conversationStoreUtils'

// mock listPluginMcpServerStatuses：默认全部启用（聚焦 gate 本身的判断，
// 不引入 pluginRegistry 单例噪声）
const listStatusesMock = vi.fn(() => [
  { id: 'polaris-bus', enabled: true },
  { id: 'other-server', enabled: true },
])
vi.mock('@/plugin-system', () => ({
  listPluginMcpServerStatuses: (...args: unknown[]) => listStatusesMock(...args),
}))

// mock configStore：可控 uiControlEnabled
const getStateMock = vi.fn()
vi.mock('../configStore', () => ({
  useConfigStore: { getState: () => getStateMock() },
}))

import { usePluginStore } from '../pluginStore'

describe('getDisabledPluginMcpServers uiControlEnabled gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // pluginStates 不参与（listStatuses 已 mock 返回 enabled:true），传空对象即可
    usePluginStore.setState({ pluginStates: {} })
  })

  it('默认（缺省）时禁用 polaris-bus', () => {
    getStateMock.mockReturnValue({ config: {} })
    const disabled = getDisabledPluginMcpServers()
    expect(disabled).toContain('polaris-bus')
  })

  it('显式 false 时禁用 polaris-bus', () => {
    getStateMock.mockReturnValue({ config: { uiControlEnabled: false } })
    expect(getDisabledPluginMcpServers()).toContain('polaris-bus')
  })

  it('开启后不再禁用 polaris-bus（仅服务端自己禁用的残留）', () => {
    getStateMock.mockReturnValue({ config: { uiControlEnabled: true } })
    const disabled = getDisabledPluginMcpServers()
    expect(disabled).not.toContain('polaris-bus')
  })

  it('状态为 disabled 的其它 server 照常进入禁用列表（不误伤原逻辑）', () => {
    listStatusesMock.mockReturnValueOnce([
      { id: 'polaris-bus', enabled: true },
      { id: 'other-server', enabled: false },
    ])
    getStateMock.mockReturnValue({ config: { uiControlEnabled: true } })
    const disabled = getDisabledPluginMcpServers()
    expect(disabled).toContain('other-server')
    expect(disabled).not.toContain('polaris-bus')
  })
})