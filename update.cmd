@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
node scripts\run-update.mjs --trigger=manual
set PULSE_UPDATE_CODE=%ERRORLEVEL%
echo.
if "%PULSE_NO_PAUSE%"=="1" exit /b %PULSE_UPDATE_CODE%
pause
exit /b %PULSE_UPDATE_CODE%
