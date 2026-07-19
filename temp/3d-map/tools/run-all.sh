#!/bin/bash
# run-all.sh — 3D World 开发一键入口
#
# 用法:
#   node tools/run-all.sh            # 运行全部检查 + 报告
#   node tools/run-all.sh --serve    # 运行检查后启动开发服务器
#   node tools/run-all.sh --ci       # CI 模式
#   node tools/run-all.sh --scaffold # 先补全缺失模块再检查
#
# 零外部依赖

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_DIR="$SCRIPT_DIR"
CI=false
SERVE=false
SCAFFOLD=false

for arg in "$@"; do
  case $arg in
    --ci) CI=true ;;
    --serve) SERVE=true ;;
    --scaffold) SCAFFOLD=true ;;
  esac
done

echo ""
echo "🌍 3D World 开发工作流"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. 骨架生成（按需）
if [ "$SCAFFOLD" = true ]; then
  echo ""
  echo "[1/3] 生成缺失模块骨架..."
  node "$TOOLS_DIR/scaffold.js"
fi

# 2. 质量门禁
echo ""
echo "[2/3] 质量门禁检查..."
if [ "$CI" = true ]; then
  node "$TOOLS_DIR/qa-gate.js" --ci
  EXIT=$?
  if [ $EXIT -ne 0 ]; then
    echo ""
    echo "❌ 门禁失败，退出"
    exit 1
  fi
else
  node "$TOOLS_DIR/qa-gate.js"
fi

# 3. 开发服务器（按需）
if [ "$SERVE" = true ]; then
  echo ""
  echo "[3/3] 启动开发服务器..."
  node "$TOOLS_DIR/dev-server.js"
fi

echo ""
echo "✅ 全部完成"
echo ""
