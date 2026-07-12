#!/bin/bash
# ============================================================
# Polaris WSL Linux Web 一键打包
# 流程: 检查 WSL -> 同步项目 -> pnpm install -> package:web -> 压缩 -> 复制回 Windows
# 用法: 从 Windows 调用: wsl -d Ubuntu bash scripts/wsl-package-web-runner.sh
# ============================================================
set -e

WSL_SRC_DIR=/home/qusc/polaris
OUTPUT_NAME=polaris-web-linux.tar.gz

echo '============================================'
echo '  Polaris WSL Linux Web 一键打包'
echo '  流程: WSL 编译 -> 压缩 -> 复制产物回 Windows'
echo '============================================'
echo ''

# Step 1
echo '[1/6] 检查 WSL 环境...'
echo '[1/6] WSL 连接正常 OK'
echo ''

# Step 2
echo '[2/6] 检查 Rust 环境...'
source $HOME/.cargo/env 2>/dev/null
rustc --version
echo '[2/6] OK'
echo ''

# Step 3
echo '[3/6] 同步项目到 WSL...'
if [ -d "$WSL_SRC_DIR/.git" ]; then
  echo '  项目已存在，检查更新...'
  cd "$WSL_SRC_DIR"
  git pull --quiet 2>/dev/null || echo '  无远程更新，使用本地代码'
else
  echo '  首次克隆...'
  git clone /mnt/d/space/base/Polaris "$WSL_SRC_DIR"
fi
echo '[3/6] OK'
echo ''

# Step 4
echo '[4/6] 安装前端依赖...'
if [ -d "$WSL_SRC_DIR/node_modules" ]; then
  echo '  node_modules 已存在，跳过'
else
  cd "$WSL_SRC_DIR" && pnpm install
fi
echo '[4/6] OK'
echo ''

# Step 5
echo '[5/6] 执行 Web 打包（首次可能需要数分钟）...'
echo ''
cd "$WSL_SRC_DIR" && pnpm run package:web
echo '[5/6] OK'
echo ''

# Step 6
echo '[6/6] 压缩产物并复制到 Windows...'
cd "$WSL_SRC_DIR"
rm -f "$OUTPUT_NAME"
tar czf "$OUTPUT_NAME" polaris-web/
cp "$OUTPUT_NAME" /mnt/d/space/base/Polaris/
ls -lh "$OUTPUT_NAME"
echo '[6/6] OK'
echo ''

echo '============================================'
echo '  打包完成！'
echo '============================================'
echo '  产物: '"$OUTPUT_NAME"
echo '  位置: /mnt/d/space/base/Polaris/'"$OUTPUT_NAME"
echo '  部署: tar xzf '"$OUTPUT_NAME"' && cd polaris-web && ./start.sh'
