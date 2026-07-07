# ADR 0001: Agent-Owned Built-In Browser Tabs

## Status

Accepted

## Context

Polaris built-in browser tabs are represented in two layers:

- The React tab store owns tab metadata and renders `BrowserPanel` only for the active tab.
- The Tauri backend owns native WebViews addressed by stable WebView labels.

Existing browser tools resolve an omitted label to the most recently updated browser session. That is convenient for one user-controlled tab, but it is unsafe for multiple agents: a parent agent and sub-agents can accidentally operate the same "latest" tab. The current `openBrowserTab` store action also reuses the first browser tab by default, preventing one tab per agent.

## Decision

Introduce an agent-aware browser acquisition protocol.

1. Keep the current user-facing browser launcher behavior: opening from the left browser panel reuses the existing browser tab.
2. Add an agent acquisition path that can create a new browser tab, or bind an agent to an existing WebView label.
3. Use the agent/session id as the default browser owner key. SimpleAI sub-agents already have distinct session ids, so they naturally receive separate browser tabs.
4. Support explicit acquire modes:
   - `auto`: reuse this agent's existing binding, otherwise create a dedicated tab.
   - `create`: always create a dedicated tab.
   - `reuse`: bind the most recent existing browser tab when available, otherwise create a dedicated tab.
   Invalid mode values are rejected.
5. Resolve omitted browser labels in this order:
   - Explicit `label`
   - Existing binding for `agentKey`
   - Most recently updated browser session
6. Create new browser tabs through a frontend event. The backend requests a tab, the frontend creates a React browser tab, `BrowserPanel` creates the native WebView, then the frontend completes the pending backend request.

## Consequences

- Agent browser operations stop relying on global "latest tab" state once an agent has acquired a tab.
- Existing manual browser workflow remains compatible.
- New native WebViews still require an active rendered `BrowserPanel`; therefore agent-created tabs are activated during acquisition.
- Background non-active tabs are hidden by the existing bounds behavior. Text/DOM operations can still target their WebView label if the WebView exists; screenshot diagnostics require a visible tab.

## Rejected Options

- Creating native WebViews directly in the backend without React tabs: rejected because the user would not see or manage those tabs in the workbench.
- Making every browser tab permanently mounted in React: rejected for the initial implementation because it changes layout lifecycle and WebView visibility semantics more broadly.
- Continuing to rely on latest-session label resolution: rejected because it causes cross-agent tab ownership ambiguity.
