@echo off
setlocal
cd /d "%~dp0"
title Umbryx server

rem Find a real Python 3.9+ (the Microsoft Store placeholder fails this check).
set "PY="
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=python"
if not defined PY (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo.
  echo   Python 3.9 or newer was not found on this computer.
  echo   Install it from https://www.python.org/downloads/ and tick
  echo   "Add python.exe to PATH" in the installer, then run this file again.
  echo.
  pause
  exit /b 1
)

%PY% server.py
echo.
pause
