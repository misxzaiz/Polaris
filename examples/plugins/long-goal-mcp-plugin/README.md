# Long Goal MCP Plugin

This is an external Polaris MCP plugin prototype for the long goal executor.

It intentionally keeps scheduling, AI engine selection, session creation, interruption, and automatic continuation in the Polaris host. The external MCP server only exposes document-backed long goal tools that an AI session can call.

## Install

1. Open Polaris settings.
2. Open the Plugins tab.
3. Choose User or Project scope.
4. Click Install from directory.
5. Select this directory: `examples/plugins/long-goal-mcp-plugin`.
6. Refresh installed plugins.

After installation, the plugin contributes one stdio MCP server: `polaris-long-goal`.

## Tools

- `long_goal_list`: list long goals under the current workspace.
- `long_goal_read`: read one long goal's config and protocol documents.
- `long_goal_append_supplement`: append user or AI supplement text to `supplement.md`.
- `long_goal_record_progress`: append execution progress to `progress.md`, with an optional next queue item.
- `long_goal_set_status`: update status, phase, and scheduling fields in `goal.json`.

## Boundary

Host-owned:

- creating AI sessions
- selecting the AI engine
- interval scheduling
- retry and backoff scans
- pause, resume, interrupt, and completion review UX

Plugin-owned:

- protocol document read/write tools
- status and progress document updates requested by an AI session
- portable manifest and MCP server packaging prototype
