# ADR 0002: Sanitize Provider-Owned Anthropic Content Blocks

## Status

Accepted, implemented

## Date

2026-07-07

## Context

When an agent operates the built-in browser, some sessions intermittently fail with:

```text
API Error: 400 The parameter ***.***.type specified in the request are not valid:
invalid value: server_tool_use, supported values are: text, thinking, image,
'tool_use' and tool_result.
```

Review findings:

1. The Polaris built-in browser tools do not emit `server_tool_use`.
   - SimpleAI's native `browser` tool returns plain text JSON.
   - `polaris-browser-mcp` returns MCP `text` content and optional `image` content.
2. `server_tool_use` is an Anthropic provider-owned/server-side tool block, commonly produced by native server tools such as web search. It is not equivalent to a client MCP/function `tool_use`.
3. Claude Code model profiles currently have two routes:
   - OpenAI Chat/Responses profiles use the local Polaris proxy.
   - `anthropic-messages` profiles are sent directly to the configured `ANTHROPIC_BASE_URL`.
4. The direct `anthropic-messages` route lets Claude CLI resume history pass through unchanged. If a previous assistant turn contains `server_tool_use` or `web_search_tool_result`, a third-party Anthropic-compatible endpoint that only accepts normal client blocks rejects the next request before Polaris can recover.
5. The existing proxy conversion path already normalizes many Anthropic blocks when targeting OpenAI-style upstream APIs, but it has no sanitized Anthropic pass-through mode for Anthropic-compatible upstreams.

The visible symptom often appears during browser tasks because those tasks encourage web access and multi-turn tool use, but the browser tool implementation is not the source of the invalid block.

## Decision

Polaris will fix this at the provider/protocol boundary, not inside the browser tool.

1. Add a sanitized Anthropic pass-through proxy mode.
   - Extend `ProxyWireApi` with an Anthropic Messages upstream mode.
   - Build the upstream URL as `/v1/messages`.
   - Accept Claude CLI `POST /v1/messages` requests locally, sanitize content blocks, then forward the request to the configured Anthropic-compatible upstream.
   - Return upstream streaming and non-streaming responses without converting them to OpenAI format.
2. Route Claude Code `anthropic-messages` custom model profiles through this sanitized proxy by default.
   - The current direct route remains valid only for endpoints explicitly marked as supporting Anthropic provider-owned server tool blocks.
   - Existing OpenAI Chat/Responses proxy routes remain unchanged.
3. Treat provider-owned tool blocks as history annotations, not executable client tool calls.
   - Do not synthesize MCP/function `tool_use` or `tool_result` from `server_tool_use`.
   - Do not ask the client to execute a server-owned tool after the fact.
4. Normalize outbound Anthropic request content blocks with a strict allowlist.
   - Keep supported client blocks: `text`, `image`, `thinking`, `tool_use`, `tool_result`.
   - Convert `server_tool_use`, `web_search_tool_result`, and future provider-owned blocks into compact `text` blocks when the target endpoint does not support them.
   - Preserve useful context: block type, id, name, input, result titles/URLs/snippets where present, and a compact JSON fallback under a bounded size.
   - For unknown blocks, keep `text` if available; otherwise replace with an explanatory compact text block instead of forwarding the raw block.
5. Prevent new provider-owned web-search blocks on incompatible endpoints.
   - When a Claude Code profile is routed through sanitized mode with server tools disabled, append native web tools such as `WebSearch` and `WebFetch` to `--disallowedTools`.
   - Keep Polaris browser MCP/native browser tools available as the supported web access path.
6. Improve error handling.
   - If an upstream still returns a 400 mentioning `server_tool_use`, surface a targeted diagnostic: the resumed session contains Anthropic server-tool history not supported by the selected provider.
   - Suggest retrying through the sanitized proxy or starting a fresh session if the provider cannot accept the history shape.

## Implementation Plan

1. Add `ProxyWireApi::AnthropicMessages` in `src-tauri/src/services/proxy/forwarder.rs`.
   - Add URL tests for `/v1/messages`.
   - Reuse `forward_raw_response` so streaming semantics stay intact.
2. Add a sanitizer module under `src-tauri/src/services/proxy/`.
   - Function shape: `sanitize_anthropic_messages_body(body: Value, capability: AnthropicProviderCapability) -> Value`.
   - `AnthropicProviderCapability` starts with `supports_server_tools: bool`.
   - Unit tests must include the exact failing block type `server_tool_use`.
3. Update `src-tauri/src/services/proxy/handlers.rs`.
   - In `handle_messages`, if the forwarder mode is `AnthropicMessages`, sanitize and forward raw instead of converting to OpenAI/Responses.
4. Update model-profile routing in `src-tauri/src/commands/chat.rs`.
   - For Claude Code + `wire_api == anthropic-messages`, start the local proxy unless the provider capability explicitly says server tool blocks are supported.
   - Generate settings/env overrides pointing Claude CLI at the local proxy, same as existing proxy-backed profiles.
5. Merge disallowed tools in `src-tauri/src/ai/engine/claude.rs`.
   - Replace the hard-coded single `AskUserQuestion` value with a merged list that includes compatibility-driven disallowed tools.
   - Preserve existing user-provided `allowedTools` behavior.
6. Add regression tests.
   - Sanitizer converts `server_tool_use` and `web_search_tool_result` to `text`.
   - Client `tool_use/tool_result` pairing is preserved.
   - Claude profile routing chooses sanitized proxy for Anthropic-compatible custom endpoints.
   - `--disallowedTools` includes `AskUserQuestion` and web tools when server tools are disabled.

## Consequences

- Built-in browser operation remains unchanged; the fix protects all tools and resumed sessions.
- Third-party Anthropic-compatible endpoints stop receiving provider-owned blocks they do not support.
- Existing sessions already containing `server_tool_use` can continue through the sanitized proxy because the request is cleaned before reaching the provider.
- Server-side web-search provenance may be summarized as text on incompatible endpoints. This is intentional: preserving semantic context is safer than forwarding invalid structured blocks or inventing client tool calls.
- Official Anthropic or fully compatible providers can opt into preserving provider-owned server-tool blocks via capability configuration.

## Rejected Options

- Patch the browser tool output.
  - Rejected because the browser tool does not produce `server_tool_use`.
- Silently drop all unsupported blocks.
  - Rejected because it loses useful context from prior web-search turns and makes model behavior harder to explain.
- Convert `server_tool_use` into client `tool_use`.
  - Rejected because server-owned tools are executed by the provider, not by Polaris. Replaying them as MCP/function tools would create invalid tool-result pairing and duplicate side effects.
- Rely only on prompt instructions telling the model not to use native web search.
  - Rejected because resume history can already contain provider-owned blocks, and prompts do not sanitize serialized request history.
- Disable browser/MCP tools.
  - Rejected because MCP browser tools are the supported replacement path and are not the source of the malformed block.

## Validation Checklist

- A Claude Code session with prior `server_tool_use` history can continue against an Anthropic-compatible provider that rejects server-tool blocks.
- The sanitized outbound request contains no content block types outside the allowlist for providers with `supports_server_tools=false`.
- Browser MCP and native browser tool calls still appear as ordinary client `tool_use/tool_result` pairs.
- OpenAI Chat/Responses proxy behavior is unchanged.
- Direct official Anthropic behavior is unchanged when server-tool support is enabled.
