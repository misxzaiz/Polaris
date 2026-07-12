@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ============================================
echo   Polaris Web 一键打包 (Windows)
echo   将编译前端 + polaris-web 并输出到 polaris-web\ 目录
echo ============================================
echo.
node scripts/package-web.mjs %*
echo.
pause
