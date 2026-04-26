#!/bin/sh
# Polaris Knowledge: Post-commit hook (v2-aware)
#
# Every commit:
#   1. Detects changed files → marks affected modules as stale (v1).
#   2. Re-runs the assertion validator → writes meta/assertions-health.json.
#
# Install: cp scripts/knowledge-post-commit.sh .git/hooks/post-commit
#
# Environment overrides:
#   POLARIS_KNOWLEDGE_MCP   - path to polaris-knowledge-mcp binary
#   POLARIS_CONFIG_DIR      - Polaris config directory
#   POLARIS_SKIP_VALIDATE   - if set to "1", skip the validator step

set -u

# ─── Locate the MCP binary ──────────────────────────────────────────
KNOWLEDGE_MCP=""
if [ -n "${POLARIS_KNOWLEDGE_MCP:-}" ]; then
    KNOWLEDGE_MCP="$POLARIS_KNOWLEDGE_MCP"
elif command -v polaris-knowledge-mcp >/dev/null 2>&1; then
    KNOWLEDGE_MCP="polaris-knowledge-mcp"
fi

if [ -z "$KNOWLEDGE_MCP" ]; then
    exit 0  # No MCP binary available — skip silently.
fi

# ─── Collect repo context ───────────────────────────────────────────
WORKSPACE_PATH=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$WORKSPACE_PATH" ]; then
    exit 0
fi

CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null)
if [ -z "$CHANGED_FILES" ]; then
    exit 0
fi

CONFIG_DIR=""
if [ -n "${POLARIS_CONFIG_DIR:-}" ]; then
    CONFIG_DIR="$POLARIS_CONFIG_DIR"
elif [ -d "$HOME/.config/com.polaris.app" ]; then
    CONFIG_DIR="$HOME/.config/com.polaris.app"
elif [ -n "${APPDATA:-}" ] && [ -d "$APPDATA/com.polaris.app" ]; then
    CONFIG_DIR="$APPDATA/com.polaris.app"
fi

if [ -z "$CONFIG_DIR" ]; then
    exit 0
fi

# ─── Build JSON-RPC payload: mark_stale + (optionally) validate_assertions ─

JSON_FILES=$(echo "$CHANGED_FILES" | while IFS= read -r file; do
    printf '"%s"' "$file"
done | paste -sd ',' - | sed 's/^/[/;s/$/]/')

MARK_STALE=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mark_modules_stale","arguments":{"changedFiles":$JSON_FILES}}}
EOF
)

REQUESTS="$MARK_STALE"

if [ "${POLARIS_SKIP_VALIDATE:-0}" != "1" ]; then
    # Only run the validator if an index.v2.json exists — avoids noisy errors
    # on projects still on v1.
    if [ -f "$WORKSPACE_PATH/.polaris/knowledge/index.v2.json" ]; then
        VALIDATE=$(cat <<EOF
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_assertions","arguments":{"persist":true}}}
EOF
)
        REQUESTS="$REQUESTS
$VALIDATE"
    fi
fi

# Feed both requests on stdin, line-delimited. The server processes one per
# line and exits on EOF.
printf '%s\n' "$REQUESTS" | "$KNOWLEDGE_MCP" "$CONFIG_DIR" "$WORKSPACE_PATH" >/dev/null 2>&1

exit 0
