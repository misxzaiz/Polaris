import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn(async () => undefined)
vi.mock('@/services/tauri', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { AIEvent } from '../../ai-runtime'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'simple-ai' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({ initialize: async () => undefined }) as unknown as ReturnType<StoreDeps['getEventRouter']>,
    contextId: 'session-stable-1',
  }
}

beforeEach(() => {
  mockInvoke.mockClear()
})

describe('SimpleAI context compaction actions', () => {
  it('uses stable visible ID while keeping the existing runtime session ID', async () => {
    const store = createConversationStore('stable-1', createDeps())
    store.getState().setConversationId('runtime-1')

    await store.getState().compactContext()

    expect(store.getState().isCompacting).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('compact_chat', expect.objectContaining({
      sessionId: 'runtime-1',
      options: expect.objectContaining({
        stableConversationId: 'stable-1',
        engineId: 'simple-ai',
      }),
    }))
  })

  it('enables undo only after a completed generation and closes both operation states via events', async () => {
    const store = createConversationStore('stable-1', createDeps())
    store.getState().setConversationId('runtime-1')
    await store.getState().compactContext()

    store.getState().handleAIEvent({
      type: 'context_compacted',
      sessionId: 'runtime-1',
      trigger: 'manual',
      generation: 7,
      archivedTurns: 3,
      retainedTurns: 2,
    } satisfies AIEvent)
    expect(store.getState().isCompacting).toBe(false)
    expect(store.getState().canRestoreCompaction).toBe(true)

    await store.getState().restoreCompactedContext()
    expect(mockInvoke).toHaveBeenLastCalledWith('restore_compacted_context', expect.objectContaining({
      sessionId: 'runtime-1',
      options: expect.objectContaining({ stableConversationId: 'stable-1' }),
    }))

    store.getState().handleAIEvent({
      type: 'context_restored',
      sessionId: 'runtime-1',
      generation: 7,
      reason: 'undo_compaction',
    } satisfies AIEvent)
    expect(store.getState().isCompacting).toBe(false)
    expect(store.getState().canRestoreCompaction).toBe(false)
    expect(store.getState().currentMessage).toBeNull()
  })

  it('does not append or send a user message while checkpoint generation is active', async () => {
    const store = createConversationStore('stable-1', createDeps())
    store.getState().setConversationId('runtime-1')
    await store.getState().compactContext()
    mockInvoke.mockClear()

    await store.getState().sendMessage('must wait')

    expect(store.getState().messages).toHaveLength(0)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
