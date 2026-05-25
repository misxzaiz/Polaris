import { beforeEach, describe, expect, it } from 'vitest'
import { useTabStore } from './tabStore'

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
    })
    window.localStorage.clear()
  })

  it('opens Git workbench with an initial Git sub-tab', () => {
    const tabId = useTabStore.getState().openGitTab({ initialGitTab: 'history' })

    const tab = useTabStore.getState().getTabById(tabId)
    expect(tab?.type).toBe('git')
    expect(tab?.metadata?.initialGitTab).toBe('history')
    expect(typeof tab?.metadata?.gitFocusToken).toBe('number')
    expect(useTabStore.getState().activeTabId).toBe(tabId)
  })

  it('reuses the Git workbench tab and refreshes its intent metadata', () => {
    const tabId = useTabStore.getState().openGitTab({ initialGitTab: 'history' })
    const reusedTabId = useTabStore.getState().openGitTab({ initialGitTab: 'branch' })

    const state = useTabStore.getState()
    expect(reusedTabId).toBe(tabId)
    expect(state.tabs.filter((tab) => tab.type === 'git')).toHaveLength(1)
    expect(state.getTabById(tabId)?.metadata?.initialGitTab).toBe('branch')
    expect(state.activeTabId).toBe(tabId)
  })
})
