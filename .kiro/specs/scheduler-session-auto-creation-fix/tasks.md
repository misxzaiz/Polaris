# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Scheduler Auto-Creates Session Tabs
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to the concrete failing case(s) to ensure reproducibility
  - Test implementation details from Bug Condition in design
  - The test assertions should match the Expected Behavior Properties from design
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Scheduler Session Behavior
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [-] 3. Fix for scheduler session auto-creation and status update

  - [ ] 3.1 Extend SessionMetadata and CreateSessionOptions types
    - Add optional `silentMode?: boolean` field to SessionMetadata interface
    - Add optional `silentMode?: boolean` field to CreateSessionOptions interface
    - _Bug_Condition: isBugCondition1(input) where input.contextId starts with 'scheduler-'_
    - _Expected_Behavior: Sessions created with silentMode=true should not appear in tab bar_
    - _Preservation: Non-scheduler sessions continue to work as before_
    - _Requirements: 2.1, 2.2_

  - [ ] 3.2 Modify sessionStoreManager.dispatchEvent() to detect scheduler tasks
    - Check if routeSessionId starts with 'scheduler-' before auto-creating session
    - Pass silentMode: true when creating session for scheduler tasks
    - Pass silentMode: false (or omit) for non-scheduler sessions
    - _Bug_Condition: isBugCondition1(input) where sessionAutoCreated(input.contextId)_
    - _Expected_Behavior: Scheduler tasks create silent sessions, others create visible sessions_
    - _Preservation: Event routing logic remains unchanged_
    - _Requirements: 2.1_

  - [ ] 3.3 Modify sessionStoreManager.createSession() to handle silent sessions
    - When silentMode is true, do not set activeSessionId to the new session
    - Keep current activeSessionId unchanged for silent sessions
    - For non-silent sessions, continue to set activeSessionId as before
    - _Bug_Condition: isBugCondition1(input) where sessionAutoCreated(input.contextId)_
    - _Expected_Behavior: Silent sessions do not auto-activate_
    - _Preservation: Non-silent session creation behavior unchanged_
    - _Requirements: 2.1_

  - [ ] 3.4 Add makeSessionVisible() method to sessionStoreManager
    - Create new method that converts silent session to visible session
    - Update metadata to set silentMode: false
    - Call switchSession() to activate the session
    - Handle case where session doesn't exist (log warning)
    - Handle case where session is already visible (just switch)
    - _Bug_Condition: User clicks "查询日志" button_
    - _Expected_Behavior: Silent session becomes visible and switches to tab_
    - _Preservation: Existing switchSession() behavior unchanged_
    - _Requirements: 2.2_

  - [ ] 3.5 Modify schedulerStore.subscribeToEvents() to call makeSessionVisible
    - Before subscribing to events, call makeSessionVisible(sessionId)
    - Construct sessionId as `scheduler-${taskId}`
    - This converts silent session to visible when user clicks "查询日志"
    - _Bug_Condition: User clicks "查询日志" button_
    - _Expected_Behavior: Session tab appears and shows logs_
    - _Preservation: Event subscription logic unchanged_
    - _Requirements: 2.2, 3.1_

  - [ ] 3.6 Filter silent sessions from tab bar rendering
    - In SessionTabs component, filter out sessions where silentMode === true
    - Only render visible sessions in the tab bar
    - Ensure filtering doesn't affect session store or event routing
    - _Bug_Condition: isBugCondition1(input) where sessionAutoCreated(input.contextId)_
    - _Expected_Behavior: Silent sessions do not appear in tab bar_
    - _Preservation: Tab bar rendering for visible sessions unchanged_
    - _Requirements: 2.1_

  - [ ] 3.7 Ensure session_end event routes correctly to session Store
    - In schedulerStore event handler, call sessionStoreManager.dispatchEvent() for all events
    - Ensure session_end event is dispatched with correct _routeSessionId
    - Verify ConversationStore handles session_end and sets isStreaming: false
    - Add debug logging for session_end event handling
    - _Bug_Condition: isBugCondition2(input) where session_end event received_
    - _Expected_Behavior: Session Store updates isStreaming to false, tab shows completed status_
    - _Preservation: Other event types continue to route correctly_
    - _Requirements: 2.3, 3.2_

  - [ ] 3.8 Verify session tab displays correct status
    - Ensure SessionTab component reads isStreaming from session store
    - Display spinning indicator when isStreaming === true
    - Display completed indicator when isStreaming === false and messages exist
    - Add debug logging for status changes
    - _Bug_Condition: isBugCondition2(input) where session completes_
    - _Expected_Behavior: Tab shows completed status, stops spinning animation_
    - _Preservation: Tab status display for other session types unchanged_
    - _Requirements: 2.3_

  - [ ] 3.9 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Scheduler Silent Session Creation
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: Expected Behavior Properties from design_

  - [ ] 3.10 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Scheduler Session Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [~] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
