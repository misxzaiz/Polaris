#!/bin/bash
# setup-hooks.sh — 安装 Git hooks
#
# 用法:
#   cd temp/3d-map
#   bash tools/setup-hooks.sh
#
# 效果: 将 pre-commit 安装到 .git/hooks/pre-commit 并赋予执行权限

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_HOOKS="$PROJECT_ROOT/.git/hooks"

if [ ! -d "$GIT_HOOKS" ]; then
  echo "错误: 未找到 .git/hooks 目录。请确认当前是 git 仓库。"
  exit 1
fi

echo "安装 Git hooks..."
cp "$SCRIPT_DIR/pre-commit" "$GIT_HOOKS/pre-commit"
chmod +x "$GIT_HOOKS/pre-commit"
echo "✅ pre-commit 已安装到 $GIT_HOOKS/pre-commit"
echo ""
echo "提交时自动运行质量门禁。如需禁用: git config core.hooksPath /dev/null"
