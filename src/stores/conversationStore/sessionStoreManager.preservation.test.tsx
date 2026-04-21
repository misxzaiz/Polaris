/**
 * Preservation Property Tests - SessionTabs Reactivity
 * 
 * **CRITICAL**: These tests MUST PASS on unfixed code - passing confirms baseline behavior to preserve
 * **GOAL**: Capture existing reactivity behavior that must remain unchanged after the fix
 * 
 * **Property 2: Preservation** - Reactivity to Data Changes
 * 
 * Tests verify that session metadata changes (status updates, additions, deletions, updatedAt)
 * are correctly detected by the custom equality function. This baseline behavior must be preserved
 * after implementing the caching fix.
 * 
 * **NOTE**: These tests observe the store state and equality function behavior directly,
 * without rendering components, to avoid triggering the infinite loop bug. We verify that
 * the custom equality function correctly identifies when data has changed vs when it hasn't.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStoreManager } from './sessionStoreManager'
import * as fc from 'fast-check'
import type { SessionMetadata } from './types'

describe('Preservation Property Tests - Reactivity to Data Changes', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    const state = sessionStoreManager.getState()
    const sessionIds = Array.from(state.stores.keys())
    sessionIds.forEach(id => state.deleteSession(id))
  })

  /**
   * Helper function: Extract the custom equality function logic from useSessionMetadataList
   * This is the comparison logic that determines if metadata has changed
   */
  const customEqualityCheck = (prev: SessionMetadata[], next: SessionMetadata[]): boolean => {
    if (prev.length !== next.length) return false
    return prev.every((item, index) => {
      const nextItem = next[index]
      return item.id === nextItem.id &&
        item.status === nextItem.status &&
        item.updatedAt === nextItem.updatedAt
    })
  }

  /**
   * Test: Session status change (idle → running) is detected as a change
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   * This confirms that status changes are detected (behavior to preserve)
   */
  it('should detect session status change from idle to running', () => {
    const state = sessionStoreManager.getState()
    const sessionId = state.createSession({ type: 'free', title: 'Test Session' })

    // Wait for state to be updated (zustand set is synchronous but we need to get fresh state)
    const freshState = sessionStoreManager.getState()
    
    // Get initial metadata array
    const initialMetadata = Array.from(freshState.sessionMetadata.values())
    expect(initialMetadata.length).toBe(1)
    expect(initialMetadata[0].status).toBe('idle')

    // Simulate status change by dispatching session_start event
    freshState.dispatchEvent({
      type: 'session_start',
      sessionId,
      _routeSessionId: sessionId,
    })

    // Get updated metadata array
    const updatedState = sessionStoreManager.getState()
    const updatedMetadata = Array.from(updatedState.sessionMetadata.values())
    expect(updatedMetadata[0].status).toBe('running')

    // Verify the custom equality function detects this as a change
    const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
    expect(areEqual).toBe(false) // Should be different due to status change
  })

  /**
   * Test: Session addition is detected as a change
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   * This confirms that adding sessions is detected (behavior to preserve)
   */
  it('should detect when a new session is added', () => {
    const state = sessionStoreManager.getState()
    state.createSession({ type: 'free', title: 'Session 1' })

    // Get fresh state after creation
    const freshState = sessionStoreManager.getState()
    
    // Get initial metadata array
    const initialMetadata = Array.from(freshState.sessionMetadata.values())
    expect(initialMetadata.length).toBe(1)

    // Add a new session
    freshState.createSession({ type: 'free', title: 'Session 2' })

    // Get updated metadata array
    const updatedState = sessionStoreManager.getState()
    const updatedMetadata = Array.from(updatedState.sessionMetadata.values())
    expect(updatedMetadata.length).toBe(2)

    // Verify the custom equality function detects this as a change
    const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
    expect(areEqual).toBe(false) // Should be different due to length change
  })

  /**
   * Test: Session deletion is detected as a change
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   * This confirms that deleting sessions is detected (behavior to preserve)
   */
  it('should detect when a session is deleted', () => {
    const state = sessionStoreManager.getState()
    const sessionId1 = state.createSession({ type: 'free', title: 'Session 1' })
    state.createSession({ type: 'free', title: 'Session 2' })

    // Get fresh state after creation
    const freshState = sessionStoreManager.getState()
    
    // Get initial metadata array
    const initialMetadata = Array.from(freshState.sessionMetadata.values())
    expect(initialMetadata.length).toBe(2)

    // Delete a session
    freshState.deleteSession(sessionId1)

    // Get updated metadata array
    const updatedState = sessionStoreManager.getState()
    const updatedMetadata = Array.from(updatedState.sessionMetadata.values())
    expect(updatedMetadata.length).toBe(1)

    // Verify the custom equality function detects this as a change
    const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
    expect(areEqual).toBe(false) // Should be different due to length change
  })

  /**
   * Test: UpdatedAt timestamp change is detected as a change
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   * This confirms that updatedAt changes are detected (behavior to preserve)
   * 
   * NOTE: We verify status change as a proxy for updatedAt change since they happen together
   */
  it('should detect when session updatedAt timestamp changes', () => {
    const state = sessionStoreManager.getState()
    const sessionId = state.createSession({ type: 'free', title: 'Test Session' })

    // Get fresh state after creation
    const freshState = sessionStoreManager.getState()
    
    // Get initial metadata array
    const initialMetadata = Array.from(freshState.sessionMetadata.values())
    const initialStatus = initialMetadata[0].status

    // Simulate updatedAt change by dispatching session_start event
    // (session_start updates both status and updatedAt)
    freshState.dispatchEvent({
      type: 'session_start',
      sessionId,
      _routeSessionId: sessionId,
    })

    // Get updated metadata array
    const updatedState = sessionStoreManager.getState()
    const updatedMetadata = Array.from(updatedState.sessionMetadata.values())
    
    // Verify status changed (which means updatedAt also changed)
    expect(updatedMetadata[0].status).not.toBe(initialStatus)

    // Verify the custom equality function detects this as a change
    const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
    expect(areEqual).toBe(false) // Should be different due to status/updatedAt change
  })

  /**
   * Property-Based Test: Session status changes are detected
   * 
   * Tests that for various session counts and status transitions,
   * the equality function correctly detects changes.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   */
  it('property: status changes are detected for any session count', () => {
    fc.assert(
      fc.property(
        // Generate session count between 1 and 5
        fc.integer({ min: 1, max: 5 }),
        // Generate status transition (use session_start for reliable status change)
        fc.constantFrom('session_start', 'error'),
        (sessionCount, eventType) => {
          // Clean up before each property test
          const state = sessionStoreManager.getState()
          const sessionIds = Array.from(state.stores.keys())
          sessionIds.forEach(id => state.deleteSession(id))

          // Create sessions
          const createdIds: string[] = []
          for (let i = 0; i < sessionCount; i++) {
            const id = state.createSession({ type: 'free', title: `Session ${i + 1}` })
            createdIds.push(id)
          }

          // Get fresh state after creation
          const freshState = sessionStoreManager.getState()
          
          // Get initial metadata
          const initialMetadata = Array.from(freshState.sessionMetadata.values())

          // Dispatch event to first session
          freshState.dispatchEvent({
            type: eventType as 'session_start' | 'error',
            sessionId: createdIds[0],
            _routeSessionId: createdIds[0],
          })

          // Get updated metadata
          const updatedState = sessionStoreManager.getState()
          const updatedMetadata = Array.from(updatedState.sessionMetadata.values())

          // Verify the custom equality function detects this as a change
          const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
          return !areEqual // Should be different
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    )
  })

  /**
   * Property-Based Test: Session additions and deletions are detected
   * 
   * Tests that adding and removing sessions is correctly detected across
   * various scenarios.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   */
  it('property: additions and deletions are detected', () => {
    fc.assert(
      fc.property(
        // Generate initial session count
        fc.integer({ min: 1, max: 4 }),
        // Generate operation: add or delete
        fc.constantFrom('add', 'delete'),
        (initialCount, operation) => {
          // Clean up before each property test
          const state = sessionStoreManager.getState()
          const sessionIds = Array.from(state.stores.keys())
          sessionIds.forEach(id => state.deleteSession(id))

          // Create initial sessions
          const createdIds: string[] = []
          for (let i = 0; i < initialCount; i++) {
            const id = state.createSession({ type: 'free', title: `Session ${i + 1}` })
            createdIds.push(id)
          }

          // Get fresh state after creation
          const freshState = sessionStoreManager.getState()
          
          // Get initial metadata
          const initialMetadata = Array.from(freshState.sessionMetadata.values())

          // Perform operation
          if (operation === 'add') {
            freshState.createSession({ type: 'free', title: 'New Session' })
          } else if (operation === 'delete' && createdIds.length > 0) {
            freshState.deleteSession(createdIds[0])
          }

          // Get updated metadata
          const updatedState = sessionStoreManager.getState()
          const updatedMetadata = Array.from(updatedState.sessionMetadata.values())

          // Verify the custom equality function detects this as a change
          const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
          return !areEqual // Should be different
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    )
  })

  /**
   * Test: Custom equality function comparison logic
   * 
   * Verifies that the custom equality function correctly compares arrays
   * based on length, id, status, and updatedAt.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   */
  it('should use custom equality function to compare session metadata arrays', () => {
    const state = sessionStoreManager.getState()
    const sessionId = state.createSession({ type: 'free', title: 'Test Session' })

    // Get fresh state after creation
    const freshState = sessionStoreManager.getState()
    
    // Get initial metadata
    const initialMetadata = Array.from(freshState.sessionMetadata.values())
    const initialStatus = initialMetadata[0].status

    // Change session status
    freshState.dispatchEvent({
      type: 'session_start',
      sessionId,
      _routeSessionId: sessionId,
    })

    // Get updated metadata
    const updatedState = sessionStoreManager.getState()
    const updatedMetadata = Array.from(updatedState.sessionMetadata.values())

    // Verify that metadata changed (different status)
    expect(updatedMetadata[0].status).not.toBe(initialStatus)
    
    // But id and length should be the same
    expect(updatedMetadata.length).toBe(initialMetadata.length)
    expect(updatedMetadata[0].id).toBe(initialMetadata[0].id)

    // Verify the custom equality function detects this as a change
    const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
    expect(areEqual).toBe(false)
  })

  /**
   * Property-Based Test: Multiple rapid changes are detected
   * 
   * Tests that multiple rapid session metadata changes are all detected,
   * ensuring reactivity is preserved even with frequent updates.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   */
  it('property: multiple rapid changes are detected', () => {
    fc.assert(
      fc.property(
        // Generate number of changes (2-5)
        fc.integer({ min: 2, max: 5 }),
        (changeCount) => {
          // Clean up before each property test
          const state = sessionStoreManager.getState()
          const sessionIds = Array.from(state.stores.keys())
          sessionIds.forEach(id => state.deleteSession(id))

          // Create initial session
          const sessionId = state.createSession({ type: 'free', title: 'Test Session' })

          // Get fresh state after creation
          const freshState = sessionStoreManager.getState()
          
          // Get initial metadata
          const initialMetadata = Array.from(freshState.sessionMetadata.values())

          // Perform multiple rapid changes (alternating between start and error for reliable changes)
          for (let i = 0; i < changeCount; i++) {
            const eventType = i % 2 === 0 ? 'session_start' : 'error'
            freshState.dispatchEvent({
              type: eventType,
              sessionId,
              _routeSessionId: sessionId,
            })
          }

          // Get updated metadata
          const updatedState = sessionStoreManager.getState()
          const updatedMetadata = Array.from(updatedState.sessionMetadata.values())

          // Verify the custom equality function detects this as a change
          const areEqual = customEqualityCheck(initialMetadata, updatedMetadata)
          return !areEqual // Should be different
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    )
  })

  /**
   * Test: Unchanged data is correctly identified as equal
   * 
   * Verifies that when no changes occur, the equality function returns true.
   * This is important for the caching fix - we need to know when data hasn't changed.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   */
  it('should identify unchanged data as equal', () => {
    const state = sessionStoreManager.getState()
    state.createSession({ type: 'free', title: 'Session 1' })
    state.createSession({ type: 'free', title: 'Session 2' })

    // Get fresh state after creation
    const freshState = sessionStoreManager.getState()
    
    // Get metadata twice without any changes
    const metadata1 = Array.from(freshState.sessionMetadata.values())
    const metadata2 = Array.from(freshState.sessionMetadata.values())

    // Verify the custom equality function identifies these as equal
    const areEqual = customEqualityCheck(metadata1, metadata2)
    expect(areEqual).toBe(true) // Should be equal - same data
  })
})
