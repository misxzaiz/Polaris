@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

REM ============================================================
REM   Polaris WSL Linux Web 一键打包
REM   流程: 检查 WSL -> 同步项目 -> pnpm install -> package:web -> 压缩 -> 复制回 Windows
REM   用法: 双击运行，或命令行: scripts\wsl-package-web.bat
REM ============================================================

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%~dp0.."
set "WSL_DISTRO=Ubuntu"
set "WSL_SRC_DIR=/home/qusc/polaris"

echo ============================================
echo   Polaris WSL Linux Web 一键打包
echo   流程: WSL 编译 -> 压缩 -> 复制产物回 Windows
echo ============================================
echo.

REM ========== Step 1: 检查 WSL ==========
echo [1/6] 检查 WSL 环境...
wsl -d !WSL_DISTRO! -e bash -c "echo ok" >nul 2>&1
if !errorlevel! neq 0 (
    echo [错误] 无法连接 WSL 发行版 '!WSL_DISTRO!'，请确认已安装。
    echo 使用 'wsl --list' 查看已安装的发行版。
    pause
    exit /b 1
)
echo [1/6] WSL 连接正常 OK
echo.

REM ========== Step 2: 检查/修复 Rust ==========
echo [2/6] 检查 Rust 环境...

REM 确保 ~/.bashrc 包含 cargo env（解决 1.75 vs 1.96 问题）
wsl -d !WSL_DISTRO! -e bash -c "
  if ! grep -q '.cargo/env' ~/.bashrc 2^>^&1; then
    echo 'source \$HOME/.cargo/env' >> ~/.bashrc
    echo ' 已修复 .bashrc 添加 cargo env'
  fi
" >nul 2>&1

for /f "delims=" %%i in ('wsl -d !WSL_DISTRO! -e bash -c "source \$HOME/.cargo/env 2^>^&1; rustc --version 2^>^&1"') do set RUST_VERSION=%%i
echo [2/6] !RUST_VERSION!
echo.

REM ========== Step 3: 克隆/同步项目到 WSL ==========
echo [3/6] 同步项目到 WSL（WSL 原生路径）...

REM 将 Windows 路径转为 WSL 路径
set "WIN_PROJECT_DIR=!PROJECT_DIR:\=!"
set "WSL_CLONE_PATH=!WIN_PROJECT_DIR:/=!"

wsl -d !WSL_DISTRO! -e bash -c "
  if [ ! -d '!WSL_SRC_DIR!/.git' ]; then
    echo '  首次克隆...'
    git clone !WSL_CLONE_PATH! '!WSL_SRC_DIR!'
  else
    echo '  项目已存在，跳过克隆'
    cd '!WSL_SRC_DIR!'
    git stash --include-untracked 2>nul
    git pull --rebase --quiet 2>nul || echo '  已在本地分支，跳过 pull'
    git stash pop 2>nul || true
  fi
"
if !errorlevel! neq 0 (
    echo [错误] 项目同步失败。
    pause
    exit /b 1
)
echo [3/6] 项目就绪 OK
echo.

REM ========== Step 4: 安装依赖 ==========
echo [4/6] 安装前端依赖...

wsl -d !WSL_DISTRO! -e bash -c "
  source \$HOME/.cargo/env
  cd '!WSL_SRC_DIR!'
  if [ ! -d node_modules ]; then
    pnpm install
  else
    echo '  node_modules 已存在，跳过安装'
  fi
"
if !errorlevel! neq 0 (
    echo [错误] 依赖安装失败。
    pause
    exit /b 1
)
echo [4/6] 依赖就绪 OK
echo.

REM ========== Step 5: 编译打包 ==========
echo [5/6] 执行 Web 打包（首次编译可能需要数分钟）...
echo      编译: vite build + cargo build --release --no-default-features ...
echo.

wsl -d !WSL_DISTRO! -e bash -c "
  source \$HOME/.cargo/env
  cd '!WSL_SRC_DIR!'
  pnpm run package:web
"
if !errorlevel! neq 0 (
    echo [错误] 打包失败。
    pause
    exit /b 1
)
echo [5/6] 打包完成 OK
echo.

REM ========== Step 6: 压缩 + 复制回 Windows ==========
echo [6/6] 压缩产物并复制到 Windows...

set "OUTPUT_TAR=polaris-web-linux.tar.gz"
set "OUTPUT_TAR_PATH=%PROJECT_DIR%\!OUTPUT_TAR!"

wsl -d !WSL_DISTRO! -e bash -c "
  cd '!WSL_SRC_DIR!'
  if [ -f '!OUTPUT_TAR!' ]; then
    rm -f '!OUTPUT_TAR!'
  fi
  echo '  压缩 polaris-web/ 目录...'
  tar czf '!OUTPUT_TAR!' polaris-web/
  echo '  复制到 Windows 目录...'
  cp '!OUTPUT_TAR!' /mnt/!PROJECT_DIR:/=\!/
  ls -lh '!OUTPUT_TAR!' | tail -1
"

if !errorlevel! neq 0 (
    echo [错误] 压缩或复制失败。
    pause
    exit /b 1
)

echo [6/6] OK
echo.

REM ========== 汇总 ==========
echo ============================================
echo   打包完成！
echo ============================================
echo.
echo   产物文件: !OUTPUT_TAR!
echo   文件位置: %PROJECT_DIR%\!OUTPUT_TAR!
echo.
echo   部署到 Linux 服务器:
echo     scp !OUTPUT_TAR! user@server:~/
echo     ssh user@server
echo     tar xzf !OUTPUT_TAR!
echo     cd polaris-web
echo     ./start.sh
echo.
echo   在 WSL 中测试运行:
echo     wsl -d Ubuntu cd ~/polaris/polaris-web && ./start.sh
echo.
pause
