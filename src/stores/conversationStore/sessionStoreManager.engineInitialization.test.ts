import { beforeEach, describe, expect, it } from 'vitest'
import { useConfigStore } from '../configStore'
import { sessionStoreManager } from './sessionStoreManager'
import type { Config } from '../../types'

function resetSessionManager() {
  const state = sessionStoreManager.getState()
  Array.from(state.stores.keys()).forEach((id) => state.deleteSession(id))
  sessionStoreManager.setState({
    activeSessionId: null,
    backgroundSessionIds: [],
    completedNotifications: [],
    isInitialized: false,
  })
}

describe('SessionStoreManager engine initialization', () => {
  beforeEach(() => {
    resetSessionManager()
    useConfigStore.setState({ config: null })
  })

  it('uses the loaded default engine when creating the default session', async () => {
    useConfigStore.setState({
      config: { defaultEngine: 'simple-ai' } as Config,
    })

    await sessionStoreManager.getState().initialize()

    const state = sessionStoreManager.getState()
    const activeSessionId = state.activeSessionId
    expect(activeSessionId).toBeTruthy()
    expect(state.sessionMetadata.get(activeSessionId!)?.engineId).toBe('simple-ai')
  })

  it('falls back to Claude Code when config is not loaded', async () => {
    await sessionStoreManager.getState().initialize()

    const state = sessionStoreManager.getState()
    const activeSessionId = state.activeSessionId
    expect(activeSessionId).toBeTruthy()
    expect(state.sessionMetadata.get(activeSessionId!)?.engineId).toBe('claude-code')
  })

  it('uses the explicit engine when creating a session', () => {
    useConfigStore.setState({
      config: { defaultEngine: 'claude-code' } as Config,
    })

    const sessionId = sessionStoreManager.getState().createSession({
      type: 'free',
      title: 'Simple AI window',
      engineId: 'simple-ai',
    })

    expect(sessionStoreManager.getState().sessionMetadata.get(sessionId)?.engineId).toBe('simple-ai')
  })

  it('only allows changing engine before a session has content', () => {
    const sessionId = sessionStoreManager.getState().createSession({
      type: 'free',
      title: 'Empty session',
    })

    expect(sessionStoreManager.getState().updateSessionEngine(sessionId, 'simple-ai')).toBe(true)
    expect(sessionStoreManager.getState().sessionMetadata.get(sessionId)?.engineId).toBe('simple-ai')

    const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
    store?.addMessage({
      id: 'message-1',
      type: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    })

    expect(sessionStoreManager.getState().updateSessionEngine(sessionId, 'claude-code')).toBe(false)
    expect(sessionStoreManager.getState().sessionMetadata.get(sessionId)?.engineId).toBe('simple-ai')
  })
})
