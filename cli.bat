@echo off
setlocal

REM P2 Claw CLI launcher (Windows).
REM Keeps secrets in .env; only sets UI_MODE and forwards args.

set UI_MODE=cli

REM Use non-watch start for fewer rogue processes.
call npm run start -- %*

endlocal

