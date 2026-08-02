/**
 * Bug Condition Exploration Test - SessionTabs Infinite Loop
 * 
 * **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * **DO NOT attempt to fix the test or the code when it fails**
 * **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
 * 
 * **GOAL**: Surface counterexamples that demonstrate the infinite loop bug exists
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SessionTabs } from '@/components/Session/SessionTabs'
import { sessionStoreManager } from './sessionStoreManager'
import * as fc from 'fast-check'

describe('Bug Condition Exploration - SessionTabs Infinite Loop', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    const state = sessionStoreManager.getState()
    const sessionIds = Array.from(state.stores.keys())
    sessionIds.forEach(id => state.deleteSession(id))
  })

  /**
   * **Property 1: Bug Condition** - Stable Reference for Unchanged Data
   * 
   * Test that useSessionMetadataList returns same reference when sessionMetadata Map hasn't changed
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Test FAILS with "Maximum update depth exceeded" error
   * This proves the bug exists - new array reference on every call triggers infinite re-renders
   */
  it('should return stable reference when sessionMetadata Map is unchanged (EXPECTED TO FAIL)', () => {
    // Spy on console.error to catch React's "Maximum update depth exceeded" error
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    
    let renderCount = 0
    const maxRenderCount = 50 // React's maximum update depth

    // Create a wrapper component that tracks render count
    function TestWrapper() {
      renderCount++
      
      // If we exceed max renders, we've hit the infinite loop bug
      if (renderCount > maxRenderCount) {
        throw new Error(`Render count exceeded ${maxRenderCount} - infinite loop detected`)
      }
      
      return <SessionTabs />
    }

    // Create 2 test sessions
    const state = sessionStoreManager.getState()
    state.createSession({ type: 'free', title: 'Session 1' })
    state.createSession({ type: 'free', title: 'Session 2' })

    // Attempt to render - this should trigger infinite loop on unfixed code
    try {
      render(<TestWrapper />)
      
      // If we get here without error, check render count
      // On unfixed code, render count should be very high (approaching maxRenderCount)
      // On fixed code, render count should be low (1-3 renders)
      expect(renderCount).toBeLessThan(10)
      
      // Also check that no console errors were logged
      const errorCalls = consoleErrorSpy.mock.calls
      const hasMaxUpdateDepthError = errorCalls.some(call => 
        call.some(arg => 
          typeof arg === 'string' && arg.includes('Maximum update depth exceeded')
        )
      )
      
      expect(hasMaxUpdateDepthError).toBe(false)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  /**
   * Test case: Basic render with 2 sessions, monitor render count
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Render count exceeds 50
   */
  it('should render with stable render count for 2 sessions (EXPECTED TO FAIL)', () => {
    let renderCount = 0
    
    function TestWrapper() {
      renderCount++
      if (renderCount > 50) {
        throw new Error('Infinite loop detected: render count > 50')
      }
      return <SessionTabs />
    }

    const state = sessionStoreManager.getState()
    state.createSession({ type: 'free', title: 'Session 1' })
    state.createSession({ type: 'free', title: 'Session 2' })

    render(<TestWrapper />)
    
    // On fixed code, should render only 1-3 times
    // On unfixed code, will throw before getting here
    expect(renderCount).toBeLessThan(10)
  })

  /**
   * Test case: Empty sessions list (0 sessions)
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: May fail with infinite loop
   */
  it('should handle empty sessions list without infinite loop (EXPECTED TO FAIL)', () => {
    let renderCount = 0
    
    function TestWrapper() {
      renderCount++
      if (renderCount > 50) {
        throw new Error('Infinite loop detected: render count > 50')
      }
      return <SessionTabs />
    }

    // No sessions created - empty list
    render(<TestWrapper />)
    
    expect(renderCount).toBeLessThan(10)
  })

  /**
   * Test case: Rapid successive re-renders without data changes
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Fails with infinite loop
   */
  it('should handle rapid re-renders without data changes (EXPECTED TO FAIL)', () => {
    let renderCount = 0
    
    function TestWrapper({ trigger: _trigger }: { trigger: number }) {
      renderCount++
      if (renderCount > 50) {
        throw new Error('Infinite loop detected: render count > 50')
      }
      return <SessionTabs />
    }

    const state = sessionStoreManager.getState()
    state.createSession({ type: 'free', title: 'Session 1' })

    // Render multiple times with same data
    const { rerender } = render(<TestWrapper trigger={0} />)
    const initialRenderCount = renderCount
    
    // Trigger 3 re-renders without changing session data
    rerender(<TestWrapper trigger={1} />)
    rerender(<TestWrapper trigger={2} />)
    rerender(<TestWrapper trigger={3} />)
    
    // Each re-render should only cause 1-2 additional renders
    // On unfixed code, each re-render triggers infinite loop
    const additionalRenders = renderCount - initialRenderCount
    expect(additionalRenders).toBeLessThan(20)
  })

  /**
   * Property-Based Test: Stable reference for unchanged data
   * 
   * Tests that for any number of sessions (0-5), the component renders
   * without infinite loops when data is unchanged.
   * 
   * **EXPECTED OUTCOME ON UNFIXED CODE**: Fails with counterexamples showing
   * render count exceeds threshold for various session counts
   */
  it('property: stable reference for any number of unchanged sessions (EXPECTED TO FAIL)', () => {
    fc.assert(
      fc.property(
        // Generate session count between 0 and 5
        fc.integer({ min: 0, max: 5 }),
        (sessionCount) => {
          // Clean up before each property test
          const state = sessionStoreManager.getState()
          const sessionIds = Array.from(state.stores.keys())
          sessionIds.forEach(id => state.deleteSession(id))

          let renderCount = 0
          
          function TestWrapper() {
            renderCount++
            if (renderCount > 50) {
              throw new Error(`Infinite loop detected with ${sessionCount} sessions`)
            }
            return <SessionTabs />
          }

          // Create the specified number of sessions
          for (let i = 0; i < sessionCount; i++) {
            state.createSession({ type: 'free', title: `Session ${i + 1}` })
          }

          render(<TestWrapper />)
          
          // Should render with low count regardless of session count
          return renderCount < 10
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    )
  })
})
