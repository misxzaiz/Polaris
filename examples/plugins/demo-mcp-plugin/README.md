# Demo MCP Plugin

This is an external Polaris plugin example. It is not registered as a builtin plugin.

## Install

1. Open Polaris settings.
2. Open the Plugins tab.
3. Choose User or Project scope.
4. Click Install from directory.
5. Select this directory: `examples/plugins/demo-mcp-plugin`.
6. Refresh installed plugins.

After installation, the plugin should appear as `example.demo-mcp` with one MCP server contribution: `example-demo-mcp`.
It also contributes a Demo MCP ActivityBar entry backed by Polaris's controlled `demoPlugin` panel host.

## Scope

This demo verifies the external plugin install and discovery flow:

- local directory install
- manifest discovery
- frontend manifest validation
- installed plugin listing
- MCP contribution display
- ActivityBar view contribution display
- demo panel echo interaction
- sending a demo MCP test prompt to chat
- plugin state toggles
- safe local uninstall

Polaris resolves `{{pluginDir}}`, `{{workspacePath}}`, and `{{appConfigDir}}` for external stdio MCP server declarations before writing Claude or Codex MCP runtime config.

## Manifest

The plugin uses root-level `plugin.json`. Polaris also supports `.codex-plugin/plugin.json`, but this sample uses the simpler layout so users can select the plugin directory directly.
