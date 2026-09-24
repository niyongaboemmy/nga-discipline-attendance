@echo off
setlocal enabledelayedexpansion
title Tendo - local development
cd /d "%~dp0"

echo ===================================================
echo    NGA Tendo  -  local development
echo ===================================================
echo.

:: ---------------------------------------------------------------- 1. Node.js
echo [1/5] Checking Node.js...
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
:: Creating .env only when it is missing never repairs one, and an .env written
:: during an earlier setup keeps pointing wherever it pointed then - for most
:: people the production MIS, so sign-in redirects there and fails. The script
:: fills in a missing file and, in one that exists, replaces only the settings
:: that wire the modules on this machine together (URLs, SSO client id/secret).
:: Your own keys are left alone and the old file is kept as .env.bak.
echo [2/5] Checking configuration...
node scripts\sync-local-env.cjs server client
if errorlevel 1 (
    echo.
    echo   [X] Could not write server\.env or client\.env - see the error above.
    echo.
    pause
    exit /b 1
)
:: These files are git-ignored: your local settings can never be pushed.
echo   - Configuration present
echo   - Note: the database is a local SQLite file, created on first run.

:: ------------------------------------------------------------ 3. Central MIS
:: Tendo has no login of its own - users sign in through the NGA Central MIS.
:: Like the Docker stack, we run a private copy of the MIS on this machine: its
:: own start.bat builds a local database seeded with a known admin login and
:: with this module's SSO client (backend/scripts/setup-local-db.ts), which is
:: what .env.example already points at. Nothing here touches the real MIS.
::
:: It is started now, in its own window, so its first-run install and database
:: build overlap with ours below. We only wait for it right before launch.
echo [3/5] Checking Central MIS...
set "MIS_REPO=https://github.com/niyongaboemmy/nga_central_mis.git"
set "MIS_STARTED="
call :port_open 5001
if not errorlevel 1 (
    echo   - Already running ^(API answering on port 5001^)
    goto :mis_started
)

:: Where is the MIS checkout? An explicit NGA_MIS_DIR wins; otherwise a clone
:: next to this folder, then the NGAMIS workspace layout used with docker-compose.
set "MIS_DIR="
if defined NGA_MIS_DIR if exist "%NGA_MIS_DIR%\start.bat" set "MIS_DIR=%NGA_MIS_DIR%"
if "!MIS_DIR!"=="" if exist "..\nga_central_mis\start.bat" set "MIS_DIR=..\nga_central_mis"
if "!MIS_DIR!"=="" if exist "..\..\Central MIS\nga_central_mis\start.bat" set "MIS_DIR=..\..\Central MIS\nga_central_mis"

if "!MIS_DIR!"=="" (
    echo   - Not found next to this folder. Cloning it ^(one time^)...
    where git >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [warn] Git is not installed, so the Central MIS cannot be fetched.
        echo          Install it from https://git-scm.com/ and run this again.
        echo          Tendo will start, but SIGNING IN WILL NOT WORK until then.
        echo.
        goto :mis_started
    )
    git clone "!MIS_REPO!" "..\nga_central_mis"
    if errorlevel 1 (
        :: A full clone is ~30k objects and a flaky connection resets it often.
        :: Git removes its own half-finished folder; a shallow clone is a
        :: fraction of the size, and history is not needed to run the MIS.
        echo.
        echo   - Download interrupted. Trying once more with a smaller download...
        if exist "..\nga_central_mis" if not exist "..\nga_central_mis\start.bat" rmdir /s /q "..\nga_central_mis"
        git clone --depth 1 "!MIS_REPO!" "..\nga_central_mis"
    )
    if not exist "..\nga_central_mis\start.bat" (
        echo.
        echo   [warn] Could not clone the Central MIS. Either the connection dropped
        echo          ^(just run start.bat again^) or you do not have access to its
        echo          repository yet ^(ask your team lead^).
        echo          Tendo will start, but SIGNING IN WILL NOT WORK until then.
        echo.
        goto :mis_started
    )
    set "MIS_DIR=..\nga_central_mis"
)
for %%D in ("!MIS_DIR!") do set "MIS_DIR=%%~fD"
echo   - Using !MIS_DIR!
echo   - Starting it in its own window
start "Central MIS - local development" /D "!MIS_DIR!" cmd /k .\start.bat
set "MIS_STARTED=1"
:mis_started

:: ----------------------------------------------------------- 4. Dependencies
echo [4/5] Checking dependencies...
:: Test for the tool each dev script actually runs, not just the folder: an
:: `npm install` cut off half-way (a dropped connection, a closed window)
:: leaves node_modules present but without its .bin entries, and the app
:: then dies with "'vite' is not recognized". Re-running npm install
:: repairs such a folder, so that is the fix as well as the first-run path.
if not exist "node_modules\.bin\concurrently.cmd" (
    echo   - Installing root packages ^(first run, takes a few minutes^)...
    call npm install
    if errorlevel 1 (
        echo   - That did not finish ^(usually the connection^) - trying once more...
        call npm install
        if errorlevel 1 (
            echo.
            echo   [X] Installing root packages failed twice - see the error above.
            echo       Check your connection and run start.bat again.
            echo.
            pause
            exit /b 1
        )
    )
)
if not exist "server\node_modules\.bin\tsx.cmd" (
    echo   - Installing server packages...
    call npm install --prefix server
    if errorlevel 1 (
        echo   - That did not finish ^(usually the connection^) - trying once more...
        call npm install --prefix server
        if errorlevel 1 (
            echo.
            echo   [X] Installing server packages failed twice - see the error above.
            echo       Check your connection and run start.bat again.
            echo.
            pause
            exit /b 1
        )
    )
)
if not exist "client\node_modules\.bin\vite.cmd" (
    echo   - Installing client packages...
    call npm install --prefix client
    if errorlevel 1 (
        echo   - That did not finish ^(usually the connection^) - trying once more...
        call npm install --prefix client
        if errorlevel 1 (
            echo.
            echo   [X] Installing client packages failed twice - see the error above.
            echo       Check your connection and run start.bat again.
            echo.
            pause
            exit /b 1
        )
    )
)
echo   - Dependencies ready

:: ----------------------------------------------------------------- 5. Launch
:: The MIS was started in parallel above; give it until now to come up.
:: Two ports matter: 5001 is the API this server talks to, 5173 is the
:: login page the browser is sent to. Both come from the MIS's `npm run
:: dev`, but the API is the slow one, so wait on it first and confirm each.
if defined MIS_STARTED (
    echo   - Waiting for Central MIS ^(first run: a few minutes^)
    call :wait_port 5001 900
    if errorlevel 1 (
        echo.
        echo   [warn] Central MIS is still not answering after 15 minutes. Look at
        echo          the "Central MIS" window for what it is stuck on. Tendo
        echo          starts anyway, but signing in needs the MIS running.
        echo.
    ) else (
        echo   - Central MIS API ready         http://localhost:5001
        call :wait_port 5173 120
        if errorlevel 1 (
            echo.
            echo   [warn] The MIS API is up but its login page ^(port 5173^) is not.
            echo          Check the "Central MIS" window for a frontend error.
            echo.
        ) else (
            echo   - Central MIS login page ready  http://localhost:5173/login
        )
    )
) else (
    call :port_open 5173
    if errorlevel 1 (
        echo.
        echo   [warn] An MIS API answers on 5001 but nothing serves its login page
        echo          on 5173, so Sign In will dead-end. Start the MIS frontend too.
        echo.
    ) else (
        echo   - Central MIS login page ready  http://localhost:5173/login
    )
)
echo [5/5] Starting Tendo...
echo.
echo ===================================================
echo   Open:  http://localhost:3000
echo   API:   http://localhost:5171
echo.
echo   Click Sign In - it takes you to your own Central
echo   MIS at localhost:5173. Sign in as
echo.
echo       superadmin  /  Admin@1234
echo.
echo   or as any role - dev.teacher, dev.student,
echo   dev.admin ... same password. Full list in
echo   guides\START_HERE.pdf
echo.
echo   The 6-digit code is printed on the login page.
echo   Everything is local - production is never touched.
echo.
echo   Press Ctrl+C in this window to stop.
echo ===================================================
echo.
call npm run dev
pause

goto :eof

:: ---------------------------------------------------------------- helpers
:: Both gate on the TCP port rather than on a tool being on PATH: that is what
:: "the MIS is up" actually means, and it works whether it runs natively or in
:: Docker. PowerShell is used because cmd has no socket primitive of its own.

:: port_open <port>  ->  errorlevel 0 if something is listening
:port_open
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%1)).Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b %errorlevel%

:: wait_port <port> <seconds>  ->  errorlevel 0 once it opens, 1 on timeout
:wait_port
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(%2);while((Get-Date) -lt $d){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%1)).Close();Write-Host '';exit 0}catch{};Write-Host -NoNewline '.';Start-Sleep 5};Write-Host '';exit 1"
exit /b %errorlevel%
