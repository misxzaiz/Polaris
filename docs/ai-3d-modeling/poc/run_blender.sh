#!/usr/bin/env bash
# Blender 建模助手 - 一键执行脚本
# 用法: ./run_blender.sh [--params '{"key":"value"}'] [--output output.glb]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POC_DIR="$SCRIPT_DIR"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# === 配置 ===
# Blender 可执行路径（便携版）
BLENDER_DIR="D:/tools/blender/blender-4.5.12-windows-x64"
BLENDER_EXE="$BLENDER_DIR/blender.exe"

# 建模脚本
BUILD_SCRIPT="$POC_DIR/qbox_character.py"

# 默认输出路径
OUTPUT_DIR="$POC_DIR/output"
OUTPUT_PATH="$OUTPUT_DIR/qbox_character.glb"

# 解析参数
PARAMS_JSON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --params) PARAMS_JSON="$2"; shift 2 ;;
    --output) OUTPUT_PATH="$2"; shift 2 ;;
    --help) echo "用法: $0 [--params '{\"key\":\"val\"}'] [--output path]"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# === 检查 ===
if [ ! -f "$BLENDER_EXE" ]; then
    echo "❌ 未找到 Blender: $BLENDER_EXE"
    echo "   请先下载 Blender 便携版到: $BLENDER_DIR"
    echo "   或修改脚本中的 BLENDER_DIR 路径"
    exit 1
fi

if [ ! -f "$BUILD_SCRIPT" ]; then
    echo "❌ 未找到建模脚本: $BUILD_SCRIPT"
    exit 1
fi

# 确保输出目录存在
mkdir -p "$OUTPUT_DIR"

# === 执行 ===
echo "🚀 开始建模..."
echo "   Blender: $BLENDER_EXE"
echo "   脚本:    $BUILD_SCRIPT"
echo "   输出:    $OUTPUT_PATH"
if [ -n "$PARAMS_JSON" ]; then
    echo "   参数:    $PARAMS_JSON"
fi
echo ""

# 构建命令
CMD=("$BLENDER_EXE" --background "$BUILD_SCRIPT" -- --output "$OUTPUT_PATH")
if [ -n "$PARAMS_JSON" ]; then
    CMD+=(--params "$PARAMS_JSON")
fi

# 执行
time "${CMD[@]}"

EXIT_CODE=$?
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ 建模完成！"
    echo "   输出文件: $OUTPUT_PATH"
    echo "   大小: $(ls -lh "$OUTPUT_PATH" 2>/dev/null | awk '{print $5}')"

    # 询问是否打开预览
    echo ""
    echo "   用以下命令打开预览:"
    echo "   start $POC_DIR/preview.html?model=$(basename "$OUTPUT_PATH")"
else
    echo "❌ 建模失败 (exit code: $EXIT_CODE)"
    exit $EXIT_CODE
fi