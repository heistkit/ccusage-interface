@echo off
REM Two jobs in one file:
REM   double-clicked (no arguments) -> start the live dashboard and keep the window open
REM   called with arguments         -> behave like a normal CLI and forward them
REM The second case matters because Scoop shims this file as `ccstats`, so hardcoding
REM --serve --open would make `ccstats --help` silently launch a server instead.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Get it from https://nodejs.org  then try again.
  echo.
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0ccstats.mjs" --serve --open
  REM only reached once the server stops, so errors stay readable
  pause
) else (
  REM no cd: -o and --root are resolved against the caller's directory
  node "%~dp0ccstats.mjs" %*
)
exit /b %errorlevel%
