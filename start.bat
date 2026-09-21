@echo off
setlocal enabledelayedexpansion
title Tendo - local development
cd /d "%~dp0"

echo ===================================================
echo    NGA Tendo  -  local development
echo ===================================================
echo.

:: ---------------------------------------------------------------- 1. Node.js
echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] Node.js is not installed, or not on your PATH.
    echo       Install the LTS build from https://nodejs.org/ and run this again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%V in ('node -v') do echo   - Node %%V

:: -------------------------------------------------------- 2. .env from template
echo [2/4] Checking configuration...
if not exist "server\.env" (
    copy "server\.env.example" "server\.env" >nul
    echo   - Created server\.env
)
if not exist "client\.env" (
    copy "client\.env.example" "client\.env" >nul
    echo   - Created client\.env
)
:: These files are git-ignored: your local settings can never be pushed.
findstr /C:"PASTE_DEV_SECRET_FROM_MIS_SYSTEMS_PAGE" "server\.env" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo   [warn] server\.env still has a placeholder SSO secret.
    echo          Everything will start, but SIGNING IN WILL FAIL until
    echo          you ask your team lead for the Tendo dev SSO secret
    echo          and put it in server\.env as:
    echo              SSO_CLIENT_SECRET=...
    echo.
)
echo   - Configuration present
echo   - Note: the database is a local SQLite file, created on first run.

:: ----------------------------------------------------------- 3. Dependencies
echo [3/4] Checking dependencies...
if not exist "node_modules" (
    echo   - Installing root packages ^(first run, takes a few minutes^)...
    call npm install
)
if not exist "server\node_modules" (
    echo   - Installing server packages...
    call npm install --prefix server
)
if not exist "client\node_modules" (
    echo   - Installing client packages...
    call npm install --prefix client
)
echo   - Dependencies ready

:: ----------------------------------------------------------------- 4. Launch
echo [4/4] Starting Tendo...
echo.
echo ===================================================
echo   Open:  http://localhost:3000
echo   API:   http://localhost:5171
echo.
echo   Clicking Sign In takes you to the real MIS at
echo   mis.amashuri.com, which sends you straight back
echo   here once you are logged in.
echo.
echo   Ask your team lead for the MIS admin login.
echo.
echo   Press Ctrl+C in this window to stop.
echo ===================================================
echo.
call npm run dev
pause
