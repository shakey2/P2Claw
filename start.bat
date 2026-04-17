@echo off
setlocal EnableExtensions

REM P2 Claw - Double-click entrypoint (Windows)
REM ASCII-only; avoids parenthesized blocks (cmd.exe can be fragile).

cd /d "%~dp0"

echo.
echo ===============================================================
echo   P2 CLAW - LAUNCHER
echo ===============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :node_missing

where npm >nul 2>nul
if errorlevel 1 goto :npm_missing

if not exist "node_modules\" goto :install_deps
goto :start_app

:install_deps
echo Installing dependencies (first run)...
echo.
call npm install
if errorlevel 1 goto :install_failed

:start_app
set "BASE_URL=http://127.0.0.1:3847"
set "OPEN_URL=%BASE_URL%/"

REM Start the app in a dedicated console window (non-blocking)
REM NOTE: Inside cmd's quoted /k string, use doubled quotes ("") — not backslash quotes (\").
start "P2 Claw" cmd /k "cd /d ""%~dp0"" && npm run start"

echo Waiting for local UI at %BASE_URL% ...
set /a TRY=0

:wait_loop
set /a TRY=TRY+1
if %TRY% GTR 30 goto :open_anyway
call :probe
if errorlevel 1 goto :wait_sleep
goto :open

:wait_sleep
REM Avoid TIMEOUT: it errors under redirected stdin in some environments.
ping -n 2 127.0.0.1 >NUL
goto :wait_loop

:open_anyway
echo.
echo NOTE: UI was not reachable yet. Opening anyway...

:open
start "" "%OPEN_URL%"
echo.
echo Done. If the browser shows "not running", wait a moment and refresh.
exit /b 0

:probe
REM Use curl.exe explicitly (PowerShell aliases "curl", cmd.exe does not, but be explicit anyway)
"C:\Windows\System32\curl.exe" -s -o NUL -m 1 "%BASE_URL%/api/status" >NUL 2>NUL
exit /b %errorlevel%

:node_missing
echo ERROR: Node.js is not installed or not on PATH.
echo Install Node.js (v18+) and run start.bat again.
echo.
pause
exit /b 1

:npm_missing
echo ERROR: npm is not available on PATH.
echo Reinstall Node.js (includes npm) and run start.bat again.
echo.
pause
exit /b 1

:install_failed
echo.
echo ERROR: npm install failed.
pause
exit /b 1

