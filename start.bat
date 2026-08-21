@echo off
setlocal
title ViewCoder Studio Agent v1.0.0
cd /d "%~dp0"

if exist "%USERPROFILE%\.local\bin\uvx.exe" (
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ViewCoder needs Node.js 18 or newer.
  echo Install it from https://nodejs.org then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo ViewCoder needs Node.js 18 or newer.
  echo Update Node.js from https://nodejs.org then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

echo Starting ViewCoder v1.0.0...
node bridge.js

if errorlevel 1 (
  echo.
  echo ViewCoder stopped because of an error.
  echo Read the message above, then press any key to close this window.
  pause >nul
)
