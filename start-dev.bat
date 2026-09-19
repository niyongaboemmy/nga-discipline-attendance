@echo off
setlocal enabledelayedexpansion
title Tendo - 1-Click Dev Launcher
cd /d "%~dp0"

echo ===================================================
echo       NGA Tendo - 1-Click Local Dev
echo ===================================================
echo.

:: 1. Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Setup .env files if missing
echo [1/3] Checking environment configuration...
if not exist "server\.env" (
    if exist "server\.env.example" (
        copy "server\.env.example" "server\.env" >nul
        echo   - Created server\.env from example
    )
)
if not exist "client\.env" (
    if exist "client\.env.example" (
        copy "client\.env.example" "client\.env" >nul
        echo   - Created client\.env from example
    )
)

:: 3. Install dependencies if needed
echo [2/3] Checking dependencies...
if not exist "node_modules" (
    echo   - Installing root dependencies...
    call npm install
)
if not exist "server\node_modules" (
    echo   - Installing server dependencies...
    call npm install --prefix server
)
if not exist "client\node_modules" (
    echo   - Installing client dependencies...
    call npm install --prefix client
)

:: 4. Start development servers
echo [3/3] Starting Tendo (SQLite DB auto-initializes)...
echo.
echo ===================================================
echo   Backend:  http://localhost:5002
echo   Frontend: http://localhost:5175
echo ===================================================
echo.
call npm run dev
pause
