@echo off
title CS2 Vault
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting CS2 Vault...
echo Browser will open at http://localhost:3000
echo Press Ctrl+C to stop.
echo.

:: Open browser after 3 seconds
start "" powershell -Command "Start-Sleep 3; Start-Process 'http://localhost:3000'"

npm start