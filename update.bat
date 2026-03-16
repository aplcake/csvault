@echo off
title CS2 Vault Updater
cd /d "%~dp0"
echo CS2 Vault Updater
echo ==================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found.
    pause
    exit /b 1
)

echo Step 1: Refreshing item database (cases, stickers, capsules)...
echo.
node fetch-items.js

echo.
echo Step 2: Checking for app updates...
echo.
node update.js

echo.
echo Done! Restart CS2 Vault if it is running.
pause
