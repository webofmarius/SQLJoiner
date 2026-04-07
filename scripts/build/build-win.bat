@echo off
setlocal

:: Navigate to project root regardless of where the script is called from
cd /d "%~dp0..\.."

echo === SQL Joiner - Windows Build ===

:: Check PHP binary is present
if not exist "php-bin\win\php.exe" (
    echo.
    echo Error: php-bin\win\php.exe not found.
    echo Please set up PHP for Windows first. See electron\docs\build\win.md for instructions.
    exit /b 1
)

:: Check npm is available
where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo Error: npm not found. Please install Node.js from https://nodejs.org
    exit /b 1
)

echo.
echo Building...
npm run build:win

echo.
echo === Build complete! ===
echo Output: dist\*.exe
