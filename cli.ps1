<# 
P2 Claw CLI launcher (PowerShell).
Keeps secrets in .env; only sets UI_MODE and forwards args.
#>

$env:UI_MODE = "cli"
npm run start -- @args

