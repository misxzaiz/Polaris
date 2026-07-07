import { beforeEach, describe, expect, it } from 'vitest'
import { useTabStore } from './tabStore'
import type { GitDiffEntry } from '@/types/git'

const diffFor = (filePath: string, newContent: string): GitDiffEntry => ({
  file_path: filePath,
  change_type: 'modified',
  old_content: 'old',
  new_content: newContent,
  additions: 1,
  deletions: 1,
  is_binary: false,
})

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

  it('keeps history diffs for the same file separate by identity', () => {
    const firstTabId = useTabStore.getState().openDiffTab(
      diffFor('src/App.tsx', 'commit one'),
      { identity: 'history:commit-1:src/App.tsx', titleContext: 'commit1' }
    )
    const secondTabId = useTabStore.getState().openDiffTab(
      diffFor('src/App.tsx', 'commit two'),
      { identity: 'history:commit-2:src/App.tsx', titleContext: 'commit2' }
    )

    const state = useTabStore.getState()
    expect(secondTabId).not.toBe(firstTabId)
    expect(state.tabs.filter((tab) => tab.type === 'diff')).toHaveLength(2)
    expect(state.getTabById(firstTabId)?.title).toBe('App.tsx @ commit1 (Diff)')
    expect(state.getTabById(secondTabId)?.title).toBe('App.tsx @ commit2 (Diff)')
  })

  it('still reuses working-tree diff tabs by file path', () => {
    const firstTabId = useTabStore.getState().openDiffTab(diffFor('src/App.tsx', 'first'))
    const reusedTabId = useTabStore.getState().openDiffTab(diffFor('src/App.tsx', 'second'))

    const state = useTabStore.getState()
    expect(reusedTabId).toBe(firstTabId)
    expect(state.tabs.filter((tab) => tab.type === 'diff')).toHaveLength(1)
    expect(state.getTabById(firstTabId)?.diffData?.new_content).toBe('second')
  })

  it('keeps browser session updates separate from navigation requests', () => {
    const tabId = useTabStore.getState().openBrowserTab('https://www.bing.com', 'Browser')

    let tab = useTabStore.getState().getTabById(tabId)
    const firstRequestId = tab?.metadata?.navigationRequestId
    expect(tab?.type).toBe('browser')
    expect(tab?.metadata?.initialUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.currentUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.requestedUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.navigationRequestPending).toBe(true)
    expect(typeof firstRequestId).toBe('number')

    useTabStore.getState().markBrowserNavigationHandled(tabId, firstRequestId)

    useTabStore.getState().updateBrowserTab(tabId, {
      url: 'https://learn.example/page',
      title: 'Learning',
    })

    tab = useTabStore.getState().getTabById(tabId)
    expect(tab?.title).toBe('Learning')
    expect(tab?.metadata?.initialUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.currentUrl).toBe('https://learn.example/page')
    expect(tab?.metadata?.requestedUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.navigationRequestPending).toBe(false)
    expect(tab?.metadata?.navigationRequestHandledId).toBe(firstRequestId)
    expect(tab?.metadata?.url).toBeUndefined()

    const reusedTabId = useTabStore.getState().openBrowserTab('https://developer.mozilla.org', 'Browser')
    tab = useTabStore.getState().getTabById(tabId)

    expect(reusedTabId).toBe(tabId)
    expect(tab?.metadata?.initialUrl).toBe('https://www.bing.com')
    expect(tab?.metadata?.currentUrl).toBe('https://learn.example/page')
    expect(tab?.metadata?.requestedUrl).toBe('https://developer.mozilla.org')
    expect(tab?.metadata?.navigationRequestPending).toBe(true)
    expect(tab?.metadata?.navigationRequestId).toBeGreaterThan(firstRequestId)
  })

  it('can create a dedicated browser tab when reuse is disabled', () => {
    const firstTabId = useTabStore.getState().openBrowserTab('https://www.bing.com', 'Browser')
    const agentTabId = useTabStore.getState().openBrowserTab('https://example.com', 'Agent Browser', {
      reuseExisting: false,
      metadata: {
        browserAcquireRequestId: 'request-1',
        browserAgentKey: 'agent-1',
      },
    })

    const state = useTabStore.getState()
    const agentTab = state.getTabById(agentTabId)

    expect(agentTabId).not.toBe(firstTabId)
    expect(state.tabs.filter((tab) => tab.type === 'browser')).toHaveLength(2)
    expect(agentTab?.title).toBe('Agent Browser')
    expect(agentTab?.metadata?.initialUrl).toBe('https://example.com')
    expect(agentTab?.metadata?.browserAcquireRequestId).toBe('request-1')
    expect(agentTab?.metadata?.browserAgentKey).toBe('agent-1')
    expect(state.activeTabId).toBe(agentTabId)
  })
})
