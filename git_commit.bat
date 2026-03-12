@echo off
chcp 65001 >nul
cd /d "D:\space\app\Polaris"
echo Adding changes...
git add .
echo.
echo Committing changes...
git commit -m "Update workspace creation modal and related state management"
echo.
echo Pushing changes...
git push
echo.
echo Commit and push completed!
pause