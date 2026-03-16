@echo off
title CS2 Vault — Dependency Installer
cd /d "%~dp0"

echo ============================================
echo   CS2 Vault — Installing Dependencies
echo ============================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org/en/download
    echo.
    echo After installing, close this window and run install.bat again.
    echo.
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
for /f "tokens=*" %%v in ('npm --version') do set NPM_VER=%%v
echo Node.js version : %NODE_VER%
echo npm version     : %NPM_VER%
echo.

:: Remove old node_modules if corrupted install is suspected
if exist "node_modules" (
    echo node_modules folder already exists.
    echo If you're having issues, delete the node_modules folder and run this again.
    echo.
)

echo Installing packages — this may take a minute...
echo.
call npm install

if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERROR: npm install failed!
    echo ============================================
    echo.
    echo Try these steps:
    echo   1. Delete the node_modules folder
    echo   2. Run this bat file again as Administrator
    echo   3. Check your internet connection
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   SUCCESS! Dependencies installed.
echo ============================================
echo.
echo You can now close this window and run start.bat
echo.
pause
