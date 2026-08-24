@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
if "%~1"=="" (
  node scripts\manage-schedule.mjs status
  echo.
  echo 用法：auto-update.cmd install ^| status ^| remove
) else (
  node scripts\manage-schedule.mjs %*
)
set PULSE_SCHEDULE_CODE=%ERRORLEVEL%
echo.
if "%PULSE_NO_PAUSE%"=="1" exit /b %PULSE_SCHEDULE_CODE%
pause
exit /b %PULSE_SCHEDULE_CODE%
