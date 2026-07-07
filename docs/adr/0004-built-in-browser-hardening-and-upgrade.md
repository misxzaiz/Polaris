# ADR 0004: Built-In Browser Hardening and Upgrade Plan

## Status

Proposed

## Date

2026-07-07

## Context

Polaris has recently implemented a built-in browser across three layers:

- React owns browser tab metadata and renders `BrowserPanel` for the active tab.
- Tauri owns native WebViews addressed by stable labels.
- AI access is exposed through the SimpleAI native `browser` tool and the `polaris-browser-mcp` stdio server.

ADR 0001 established agent-owned browser tabs. The current implementation now supports browser acquisition, navigation, page context extraction, DOM element inspection, click/fill automation, diagnostics, browser-region screenshot payloads on Windows, operation logs, and MCP image content for screenshots.

The follow-up review confirms that the core direction is sound, but the implementation needs hardening before treating it as a stable AI automation surface:

1. Browser state is split between frontend tabs, backend session registries, WebView lifecycle, bounds, and agent bindings. Stale state can appear if a tab closes unexpectedly, a WebView fails to create, or a persisted frontend tab is restored without a live native WebView.
2. `tabStore` currently uses Zustand `persist` while the nearby comment says tabs are not persisted. Without an explicit `partialize`, browser tab metadata can survive restart even though native WebViews cannot.
3. Browser action dispatch is duplicated across SimpleAI native tool handling, MCP bridge handling, and the ask-listener browser frame dispatcher.
4. DOM automation currently depends on injected JavaScript, synthetic click/fill events, shadow DOM traversal, and same-origin iframe traversal. This is useful, but not sufficient for all interactive pages.
5. Diagnostics capture console messages only after injection and screenshot support is Windows-only with monitor/window-coordinate assumptions.
6. The element collector scans large DOM trees and may become expensive when AI overlay is enabled on large or highly dynamic pages.

## Decision

Treat the current browser as a valid foundation, then harden it in stages instead of replacing it with a separate headless browser stack.

1. Preserve the existing user-visible model:
   - Manual browser launch reuses the first browser tab by default.
   - Agent acquisition creates or binds agent-owned tabs through the frontend event path.
   - WebView labels remain the stable backend addressing mechanism.
2. Make frontend tab persistence explicit.
   - If browser/editor tabs should not survive app restart, add a `partialize` policy that excludes `tabs` and `activeTabId`.
   - If tab restore is desired later, restore only durable metadata and force browser WebViews through a clean recreation path with cleared `browserAcquireRequestId`, `navigationRequestPending`, and stale ownership metadata.
3. Add a shared browser action dispatcher in Rust.
   - SimpleAI native browser tool, MCP browser bridge, and ask-listener browser frames must call one dispatcher for action parsing, label resolution, validation, execution, operation events, and result shaping.
   - New browser actions must be added in one place and then surfaced through thin adapters.
4. Validate and prune stale backend browser state.
   - `browser_list` and omitted-label resolution should confirm that the corresponding WebView still exists.
   - Missing WebViews should remove their session, bounds, and agent bindings.
5. Keep JavaScript DOM automation, but add native fallback primitives.
   - Add actions such as `wait`, `scroll`, `press_key`, `type_text`, and explicit screenshot.
   - Click/fill should continue to prefer inspected elements, while native coordinate/input fallback can be used when synthetic DOM events fail.
6. Improve diagnostics reliability.
   - Inject console capture as early as practical for browser-created WebViews, not only when diagnostics is called.
   - Return screenshot errors as structured diagnostics, not generic failures.
   - Improve Windows screenshot coordinate handling for DPI, window frame offsets, and multi-monitor layouts.
7. Keep browser MCP safe by default.
   - Do not expose arbitrary JavaScript evaluation.
   - Review `file://` navigation and either block it by default or require an explicit trusted-user path.
   - Keep screenshot binary data out of text payloads and return it as MCP image content.

## Implementation Plan

### P0: Correctness and State Hardening

1. Fix `tabStore` persistence semantics.
   - Add a test that reloads persisted state and proves browser tabs are either intentionally excluded or intentionally restored through sanitized metadata.
2. Create a `BrowserActionDispatcher`.
   - Move shared action names, argument extraction, `agentKey` fallback, label resolution, and action execution out of `simple_ai/tools/browser.rs` and `ask_listener.rs`.
   - Keep the MCP server as a thin JSON-RPC-to-frame adapter.
3. Add stale session pruning.
   - Reconcile `BROWSER_SESSIONS`, `BROWSER_BOUNDS`, and `BROWSER_AGENT_BINDINGS` against actual WebViews.
   - Prune on `browser_list`, label resolution, close, unregister, and failed WebView lookup.
4. Add `file://` policy.
   - Default to deny `file://` for AI/MCP initiated navigation unless a future permission flow explicitly allows it.

### P1: Automation Reliability

1. Add native fallback actions:
   - `browser_wait`
   - `browser_scroll`
   - `browser_press_key`
   - `browser_type_text`
   - `browser_screenshot`
2. Extend inspected elements with richer locator metadata:
   - frame path
   - role/tag/kind
   - accessible name/search text
   - visible/disabled/fillable state
   - approximate rect
3. Add optional wait conditions for navigation and UI readiness:
   - URL changed
   - text appears
   - element appears
   - network/document idle where the platform allows it
4. Reduce element collector cost.
   - Cache overlay results briefly.
   - Cap per-root scanning separately.
   - Prefer selector candidates before broad `querySelectorAll('*')`.

### P2: Diagnostics and Product Experience

1. Early console capture.
   - Install capture script during WebView creation or first navigation when possible.
   - Keep a bounded ring buffer per page.
2. Screenshot robustness.
   - Detect current monitor instead of assuming monitor 0.
   - Account for DPI and window content origin.
   - Add a diagnostic flag when screenshot coordinates are approximate.
3. User-visible ownership and audit trail.
   - Show agent/session ownership on browser tabs created by AI.
   - Keep recent AI browser operations visible even when the browser tab is not active.
4. Add a browser troubleshooting page.
   - Cover WebView creation failures, MCP bridge failures, screenshot limitations, and provider history errors already covered by ADR 0002.

## Validation Plan

1. Frontend unit tests:
   - Browser tab reuse versus dedicated agent tab creation.
   - Navigation request metadata is separate from session updates.
   - Persistence policy for browser tabs is explicit and tested.
2. Rust unit tests:
   - Shared dispatcher rejects invalid actions and negative indexes.
   - Agent binding takes precedence over most-recent session.
   - Stale binding is pruned when the WebView/session is gone.
   - MCP screenshot data is omitted from text and returned as image content.
3. DOM collector fixture tests:
   - Native controls, ARIA roles, labels, contenteditable, shadow DOM, same-origin iframes, duplicate labels, disabled/read-only fields, and hidden elements.
4. Tauri smoke tests:
   - Acquire a dedicated agent tab.
   - Navigate to localhost.
   - Inspect, click, fill, read context, and collect diagnostics.
   - Close the tab and verify WebView/session/bounds/binding cleanup.
5. Manual Windows verification:
   - DPI scaling at 100%, 125%, and 150%.
   - Multi-monitor screenshot alignment.
   - Modal overlays hiding native WebViews correctly.

## Consequences

- The browser remains integrated with the visible Polaris workbench instead of moving to a detached headless browser.
- Shared dispatch reduces duplicated validation logic and lowers the risk of SimpleAI/MCP behavior drift.
- Explicit tab persistence policy prevents restart-time ghost browser tabs.
- Native fallback primitives improve real-page automation while keeping arbitrary JavaScript execution unavailable.
- Screenshot support remains platform-sensitive, but diagnostics will make limitations explicit.

## Rejected Options

- Replace the built-in browser with Playwright/CDP as the primary implementation.
  - Rejected for now because Polaris needs a visible, user-manageable browser tab inside the workbench.
- Keep all browser tabs permanently mounted in React.
  - Rejected for this phase because it changes layout and WebView visibility semantics beyond the hardening scope.
- Expose arbitrary page JavaScript execution through MCP.
  - Rejected because it expands the security surface and is not necessary for the supported automation workflow.
- Rely only on text search without element indexes.
  - Rejected because repeated labels and dynamic UIs require stable inspected targets and visible rect context.

