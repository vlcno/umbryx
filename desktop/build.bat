@echo off
rem Builds the Umbryx desktop app into %USERPROFILE%\umbryx-build\dist\Umbryx-win32-x64.
rem
rem Needs Node.js: either on the PATH, or the portable copy in %USERPROFILE%\umbryx-build\node.
rem The build happens outside this folder so the large node_modules folder is not synced by OneDrive.
setlocal
set "BUILD=%USERPROFILE%\umbryx-build"
if exist "%BUILD%\node\node.exe" set "PATH=%BUILD%\node;%PATH%"
where node >nul 2>nul || (echo Node.js was not found. Get it from https://nodejs.org & exit /b 1)

if not exist "%BUILD%\app" mkdir "%BUILD%\app"
copy /y "%~dp0*.*" "%BUILD%\app\" >nul
cd /d "%BUILD%\app"
if not exist node_modules call npm install --no-audit --no-fund || exit /b 1
call npm run package || exit /b 1

rem The address file and helper travel with the app.
copy /y "%~dp0..\server-address.txt" "%BUILD%\dist\Umbryx-win32-x64\" >nul
copy /y "%~dp0Change server.bat" "%BUILD%\dist\Umbryx-win32-x64\" >nul
echo.
echo Built %BUILD%\dist\Umbryx-win32-x64\Umbryx.exe
