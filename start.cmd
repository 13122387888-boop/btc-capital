@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
node scripts\start-local.mjs
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上面的提示。
  pause
)
