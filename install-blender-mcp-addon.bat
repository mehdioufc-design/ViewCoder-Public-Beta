@echo off
setlocal EnableExtensions
title ViewCoder - Install Bundled Blender MCP Add-on

set "ADDON_SOURCE=%~dp0Blender MCP Add-on\blender_mcp.py"
set "BLENDER_ROOT=%APPDATA%\Blender Foundation\Blender"
set "BLENDER_VERSION_DIR="

if not exist "%ADDON_SOURCE%" (
  echo The bundled Blender MCP add-on is missing:
  echo %ADDON_SOURCE%
  pause
  exit /b 1
)

if not exist "%BLENDER_ROOT%" (
  echo Blender has not created its user settings folder yet.
  echo Install and open Blender once, close it, then run this installer again.
  pause
  exit /b 1
)

for /f "delims=" %%D in ('dir /b /ad /o-n "%BLENDER_ROOT%" 2^>nul') do if not defined BLENDER_VERSION_DIR set "BLENDER_VERSION_DIR=%BLENDER_ROOT%\%%D"
if not defined BLENDER_VERSION_DIR (
  echo ViewCoder could not find an installed Blender user version.
  pause
  exit /b 1
)

set "ADDON_DEST=%BLENDER_VERSION_DIR%\scripts\addons"
if not exist "%ADDON_DEST%" mkdir "%ADDON_DEST%"
if errorlevel 1 (
  echo ViewCoder could not create Blender's add-ons folder:
  echo %ADDON_DEST%
  pause
  exit /b 1
)

copy /y "%ADDON_SOURCE%" "%ADDON_DEST%\blender_mcp.py" >nul
if errorlevel 1 (
  echo The bundled Blender MCP add-on could not be installed.
  pause
  exit /b 1
)

echo.
echo Blender MCP add-on installed from the ViewCoder package:
echo %ADDON_DEST%\blender_mcp.py
echo.
echo Restart Blender, enable "Interface: Blender MCP" in Preferences,
echo open the BlenderMCP sidebar, and click Start MCP Server on port 9876.
echo ViewCoder will show Blender as connected only after the live handshake succeeds.
pause
exit /b 0
