#!/bin/sh
# Polaris Knowledge: Post-commit hook
# Detects changed files and marks affected knowledge modules as stale.
# Install: cp scripts/knowledge-post-commit.sh .git/hooks/post-commit

# Find the knowledge MCP binary
KNOWLEDGE_MCP=""
if [ -n "$POLARIS_KNOWLEDGE_MCP" ]; then
    KNOWLEDGE_MCP="$POLARIS_KNOWLEDGE_MCP"
elif [ -f "D:/app/polaris/polaris-knowledge-mcp.exe" ]; then
    KNOWLEDGE_MCP="D:/app/polaris/polaris-knowledge-mcp.exe"
elif command -v polaris-knowledge-mcp >/dev/null 2>&1; then
    KNOWLEDGE_MCP="polaris-knowledge-mcp"
fi

if [ -z "$KNOWLEDGE_MCP" ]; then
    exit 0  # No MCP binary found, skip silently
fi

# Get list of changed files in this commit (relative to repo root)
CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null)

if [ -z "$CHANGED_FILES" ]; then
    exit 0
fi

# Convert to JSON array
JSON_FILES=$(echo "$CHANGED_FILES" | while IFS= read -r file; do
    printf '"%s"' "$file"
done | paste -sd ',' - | sed 's/^/[/;s/$/]/')

# Get workspace path
WORKSPACE_PATH=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$WORKSPACE_PATH" ]; then
    exit 0
fi

# Get config dir
CONFIG_DIR=""
if [ -n "$POLARIS_CONFIG_DIR" ]; then
    CONFIG_DIR="$POLARIS_CONFIG_DIR"
elif [ -d "$HOME/.config/com.polaris.app" ]; then
    CONFIG_DIR="$HOME/.config/com.polaris.app"
elif [ -d "$APPDATA/com.polaris.app" ]; then
    CONFIG_DIR="$APPDATA/com.polaris.app"
fi

if [ -z "$CONFIG_DIR" ]; then
    exit 0
fi

# Call the MCP tool via a simple JSON-RPC message
# This writes stale marker files that the MCP server will read later
MARK_STALE_REQUEST=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mark_modules_stale","arguments":{"changedFiles":$JSON_FILES}}}
EOF
)

echo "$MARK_STALE_REQUEST" | "$KNOWLEDGE_MCP" "$CONFIG_DIR" "$WORKSPACE_PATH" >/dev/null 2>&1

exit 0
