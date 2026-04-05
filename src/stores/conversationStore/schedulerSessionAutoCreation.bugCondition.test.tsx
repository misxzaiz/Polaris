/**
 * Bug Condition Exploration Test - Scheduler Auto-Creates Session Tabs
 * 
 * **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * **DO NOT attempt to fix the test or the code when it fails**
 * **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
 * 
 * **GOAL**: Surface counterexamples that demonstrate the scheduler auto-creation bug exists
 * 
 * **Validates: Requirements 1.1, 1.2**
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sessionStoreManager } from './sessionStoreManager'
import * as fc from 'fast-check'
import type { AIEvent } from '../../ai-runtime'

describe('Bug Condition Exploration - Scheduler Auto-Creates Session Tabs', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    const state = sessionStoreManager.getState()
    const sessionIds = Array.from(state.stores.keys())
    sessionIds.forEach(id => state.deleteSession(id))
  })

  /**
   * **Property 1: Bug Condition** - Scheduler Tasks Should Not Auto-Create Visible Sessions
   * 
   * Test that when a scheduler task event is dispatched, the system should NOT create
   * a visible session tab. Instead, it should create a silent session that runs in the background.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test FAILS
   * - A visible session is created (activeSessionId is set to scheduler session)
   * - Session appears in sessionMetadata without silentMode flag
   * This proves the bug exists - scheduler tasks auto-create visible tabs
   */
  it('should NOT auto-create visible session for scheduler task events (EXPECTED TO FAIL)', () => {
    const state = sessionStoreManager.getState()
    
    // Verify no sessions exist initially
    expect(state.stores.size).toBe(0)
    expect(state.activeSessionId).toBeNull()
    
    // Simulate scheduler task event (contextId starts with 'scheduler-')
    const schedulerTaskId = 'task-123'
    const schedulerSessionId = `scheduler-${schedulerTaskId}`
    
    const event: AIEvent & { _routeSessionId: string } = {
      type: 'session_start',
      sessionId: schedulerSessionId,
      _routeSessionId: schedulerSessionId,
    }
    
    // Dispatch the event - this triggers auto-creation in dispatchEvent()
    state.dispatchEvent(event)
    
    // Get fresh state after event dispatch
    const freshState = sessionStoreManager.getState()
    
    // EXPECTED BEHAVIOR (will fail on unfixed code):
    // 1. Session should be created (for event routing)
    expect(freshState.stores.has(schedulerSessionId)).toBe(true)
    
    // 2. Session should be SILENT (not visible in tab bar)
    const metadata = freshState.sessionMetadata.get(schedulerSessionId)
    expect(metadata).toBeDefined()
    expect(metadata?.silentMode).toBe(true) // This will fail - silentMode doesn't exist yet
    
    // 3. Session should NOT be activated (activeSessionId should remain null)
    expect(freshState.activeSessionId).toBeNull() // This will fail - session is auto-activated
  })

  /**
   * Test case: Multiple scheduler tasks should all create silent sessions
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test FAILS
   * All scheduler sessions are created as visible sessions
   */
  it('should create silent sessions for multiple scheduler tasks (EXPECTED TO FAIL)', () => {
    const state = sessionStoreManager.getState()
    
    // Dispatch events for 3 different scheduler tasks
    const taskIds = ['task-1', 'task-2', 'task-3']
    
    taskIds.forEach(taskId => {
      const sessionId = `scheduler-${taskId}`
      const event: AIEvent & { _routeSessionId: string } = {
        type: 'session_start',
        sessionId,
        _routeSessionId: sessionId,
      }
      state.dispatchEvent(event)
    })
    
    // Get fresh state
    const freshState = sessionStoreManager.getState()
    
    // All sessions should exist
    expect(freshState.stores.size).toBe(3)
    
    // All sessions should be silent
    taskIds.forEach(taskId => {
      const sessionId = `scheduler-${taskId}`
      const metadata = freshState.sessionMetadata.get(sessionId)
      expect(metadata?.silentMode).toBe(true) // Will fail - silentMode doesn't exist
    })
    
    // No session should be activated
    expect(freshState.activeSessionId).toBeNull() // Will fail - last session is activated
  })

  /**
   * Test case: Non-scheduler sessions should still create visible sessions
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test PASSES
   * This confirms baseline behavior for non-scheduler sessions
   */
  it('should create visible sessions for non-scheduler events', () => {
    const state = sessionStoreManager.getState()
    
    // Dispatch a non-scheduler event (e.g., git commit)
    const gitSessionId = 'session-git-commit-abc'
    const event: AIEvent & { _routeSessionId: string } = {
      type: 'session_start',
      sessionId: gitSessionId,
      _routeSessionId: gitSessionId,
    }
    
    state.dispatchEvent(event)
    
    // Get fresh state
    const freshState = sessionStoreManager.getState()
    
    // Session should exist
    expect(freshState.stores.has(gitSessionId)).toBe(true)
    
    // Session should be visible (NOT silent)
    const metadata = freshState.sessionMetadata.get(gitSessionId)
    expect(metadata).toBeDefined()
    expect(metadata?.silentMode).toBeFalsy() // Should be false or undefined (both mean visible)
    
    // Session should be activated
    expect(freshState.activeSessionId).toBe(gitSessionId)
  })

  /**
   * Test case: Scheduler session should become visible when makeSessionVisible is called
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test FAILS
   * makeSessionVisible method doesn't exist yet
   */
  it('should convert silent session to visible when makeSessionVisible is called (EXPECTED TO FAIL)', () => {
    const state = sessionStoreManager.getState()
    
    // Create a scheduler session
    const schedulerSessionId = 'scheduler-task-456'
    const event: AIEvent & { _routeSessionId: string } = {
      type: 'session_start',
      sessionId: schedulerSessionId,
      _routeSessionId: schedulerSessionId,
    }
    
    state.dispatchEvent(event)
    
    // Verify session is silent
    let freshState = sessionStoreManager.getState()
    let metadata = freshState.sessionMetadata.get(schedulerSessionId)
    expect(metadata?.silentMode).toBe(true) // Will fail - silentMode doesn't exist
    expect(freshState.activeSessionId).toBeNull() // Will fail - session is activated
    
    // Call makeSessionVisible (simulating user clicking "查询日志")
    // @ts-expect-error - makeSessionVisible doesn't exist yet
    freshState.makeSessionVisible(schedulerSessionId) // Will fail - method doesn't exist
    
    // Verify session is now visible
    freshState = sessionStoreManager.getState()
    metadata = freshState.sessionMetadata.get(schedulerSessionId)
    expect(metadata?.silentMode).toBe(false) // Should be visible now
    expect(freshState.activeSessionId).toBe(schedulerSessionId) // Should be activated
  })

  /**
   * Property-Based Test: All scheduler contextIds create silent sessions
   * 
   * Tests that for any contextId starting with 'scheduler-', the system creates
   * a silent session that doesn't appear in the tab bar.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Fails with counterexamples showing
   * scheduler sessions are created as visible sessions
   */
  it('property: all scheduler contextIds create silent sessions (EXPECTED TO FAIL)', () => {
    fc.assert(
      fc.property(
        // Generate random task IDs
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        (taskIds) => {
          // Clean up before each property test
          const state = sessionStoreManager.getState()
          const sessionIds = Array.from(state.stores.keys())
          sessionIds.forEach(id => state.deleteSession(id))

          // Dispatch events for all task IDs
          taskIds.forEach(taskId => {
            const sessionId = `scheduler-${taskId}`
            const event: AIEvent & { _routeSessionId: string } = {
              type: 'session_start',
              sessionId,
              _routeSessionId: sessionId,
            }
            state.dispatchEvent(event)
          })

          // Get fresh state
          const freshState = sessionStoreManager.getState()

          // All sessions should be silent
          const allSilent = taskIds.every(taskId => {
            const sessionId = `scheduler-${taskId}`
            const metadata = freshState.sessionMetadata.get(sessionId)
            return metadata?.silentMode === true
          })

          // No session should be activated
          const noneActivated = freshState.activeSessionId === null

          return allSilent && noneActivated
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    )
  })

  /**
   * Test case: Scheduler session should not appear in visible session list
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test FAILS
   * Scheduler sessions appear in the visible session list
   */
  it('should filter out silent sessions from visible session list (EXPECTED TO FAIL)', () => {
    const state = sessionStoreManager.getState()
    
    // Create 1 scheduler session and 1 normal session
    const schedulerSessionId = 'scheduler-task-789'
    const normalSessionId = state.createSession({ type: 'free', title: 'Normal Session' })
    
    // Dispatch scheduler event
    const event: AIEvent & { _routeSessionId: string } = {
      type: 'session_start',
      sessionId: schedulerSessionId,
      _routeSessionId: schedulerSessionId,
    }
    state.dispatchEvent(event)
    
    // Get fresh state
    const freshState = sessionStoreManager.getState()
    
    // Total sessions: 2
    expect(freshState.stores.size).toBe(2)
    
    // Visible sessions (filtered): should only include normal session
    const visibleSessions = Array.from(freshState.sessionMetadata.values())
      .filter(metadata => !metadata.silentMode)
    
    expect(visibleSessions.length).toBe(1) // Will fail - both sessions are visible
    expect(visibleSessions[0].id).toBe(normalSessionId)
  })

  /**
   * Test case: Session_end event should route correctly to scheduler session
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: May pass or fail depending on event routing
   * This tests Bug 2 (session status not updating)
   */
  it('should route session_end event to scheduler session and update isStreaming (EXPECTED TO FAIL)', () => {
    const state = sessionStoreManager.getState()
    
    // Create scheduler session
    const schedulerSessionId = 'scheduler-task-999'
    const startEvent: AIEvent & { _routeSessionId: string } = {
      type: 'session_start',
      sessionId: schedulerSessionId,
      _routeSessionId: schedulerSessionId,
    }
    state.dispatchEvent(startEvent)
    
    // Get the session store
    let freshState = sessionStoreManager.getState()
    const sessionStore = freshState.stores.get(schedulerSessionId)
    expect(sessionStore).toBeDefined()
    
    // Verify session is streaming
    expect(sessionStore?.getState().isStreaming).toBe(true)
    
    // Dispatch session_end event
    const endEvent: AIEvent & { _routeSessionId: string } = {
      type: 'session_end',
      sessionId: schedulerSessionId,
      _routeSessionId: schedulerSessionId,
      reason: 'success',
    }
    state.dispatchEvent(endEvent)
    
    // Verify session is no longer streaming
    freshState = sessionStoreManager.getState()
    const updatedSessionStore = freshState.stores.get(schedulerSessionId)
    expect(updatedSessionStore?.getState().isStreaming).toBe(false) // May fail if event routing is broken
  })
})
