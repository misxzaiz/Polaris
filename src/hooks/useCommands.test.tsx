import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commandRegistry, type Command } from '@/services/commandRegistry'
import { useCommands } from './useCommands'

const makeCmd = (id: string, title = id): Command => ({
  id,
  title,
  category: 'action',
  perform: vi.fn(),
})

describe('useCommands', () => {
  beforeEach(() => {
    commandRegistry._clearForTest()
  })

  it('keeps the snapshot reference stable when the registry does not change', () => {
    const { result, rerender } = renderHook(() => useCommands())
    const firstSnapshot = result.current

    rerender()

    expect(result.current).toBe(firstSnapshot)
  })

  it('updates the snapshot when commands or recent ids change', async () => {
    const { result, rerender } = renderHook(() => useCommands())
    const emptySnapshot = result.current

    act(() => {
      commandRegistry.register(makeCmd('layout.reset', 'Reset Layout'))
    })

    const registeredSnapshot = result.current
    expect(registeredSnapshot).not.toBe(emptySnapshot)
    expect(registeredSnapshot.commands.map((cmd) => cmd.id)).toEqual([
      'layout.reset',
    ])

    rerender()
    expect(result.current).toBe(registeredSnapshot)

    await act(async () => {
      await commandRegistry.execute('layout.reset')
    })

    const recentSnapshot = result.current
    expect(recentSnapshot).not.toBe(registeredSnapshot)
    expect(recentSnapshot.recentIds).toEqual(['layout.reset'])
  })
})
