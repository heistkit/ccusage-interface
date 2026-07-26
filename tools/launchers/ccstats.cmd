@echo off
REM Double-click launcher (Windows). Keep this next to ccstats.mjs.
REM %~dp0 is this script's own folder, so it works no matter where it is run from.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Get it from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)
node "%~dp0ccstats.mjs" --serve --open
REM Only reached once the server stops, so the window stays up to show any error.
pause
