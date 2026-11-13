# Run the desk as a PRODUCTION build against the demo database, then warm every page, so a screen recording clicks through instantly.
#
# Why: `next dev` compiles each page the first time it is opened (seconds each), which is what makes clicks feel slow. A production build is compiled once, up front;
# measured on the demo data every page answers in about 50 to 300 ms, and the warm-up below pays the first-visit cost for the pages and their kept answers before you hit record.
#
# Use (from the TRUELANE folder, or anywhere):
#   powershell -File dispatch-desk\start-demo-prod.ps1               # build if needed, start on port 3100, warm, leave it running
#   powershell -File dispatch-desk\start-demo-prod.ps1 -Rebuild      # build again first (after any code change)
#   powershell -File dispatch-desk\start-demo-prod.ps1 -NoStart -Port 3200   # only warm a server that is already running
#
# Before recording: re-seed so "today" is today (load windows are set relative to the moment the seed runs):
#   $env:DATABASE_URL="postgresql://demo:demo@localhost:54330/demo"; npx tsx dispatch-desk/apps/web/scripts/seed-demo.ts
# and then the money on top (statements, payroll, the driver ledger, tax profiles, factored invoices; docs/MONEY_PLAN.md Waves 1-4):
#   npx tsx dispatch-desk/apps/web/scripts/seed-money-demo.ts
# then start (or restart) this script, so the warm-up reads the fresh data. Open http://localhost:3100/sign-in, press the Admin demo button, and record from there.
param(
  [int]$Port = 3100,
  [switch]$Rebuild,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$web = Join-Path $root "apps\web"
$env:DATABASE_URL = "postgresql://demo:demo@localhost:54330/demo"
$env:BYPASS_AUTH = "true"
$env:NEXT_DIST_DIR = ".next-prod"

if (-not $NoStart) {
  Push-Location $web
  if ($Rebuild -or -not (Test-Path (Join-Path $web ".next-prod\BUILD_ID"))) {
    Write-Host "Building the desk for production (a few minutes, once)..."
    if (Test-Path ".next-prod") { Remove-Item ".next-prod" -Recurse -Force }
    & npx next build
    if ($LASTEXITCODE -ne 0) { throw "next build failed" }
  }
  Write-Host "Starting the desk on http://localhost:$Port ..."
  # node + next's own script (as start-dev.ps1 does), because Start-Process cannot launch the npx shim on Windows; the server's output goes to a log beside the build
  $nextBin = Join-Path $root "node_modules\next\dist\bin\next"
  $log = Join-Path $web ".next-prod\server.log"
  Start-Process -FilePath "node" -ArgumentList @($nextBin, "start", "-p", "$Port") -WorkingDirectory $web -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
  Pop-Location
}

$base = "http://localhost:$Port"
$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) {
  try { Invoke-WebRequest -Uri "$base/sign-in" -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { throw "The desk did not answer on $base" }

# The demo door wants its cookie (the Admin button makes this same one).
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.Cookies.Add((New-Object System.Net.Cookie("desk-demo", "admin", "/", "localhost")))

$pages = "loads", "dispatch", "planner", "quote", "customers", "lanes", "kpi", "kpi/report", "leaks", "signals", "data-health", "invoices", "settlements", "payroll", "payroll/1099", "fleet", "drivers", "trailers",
  "fuel", "detention", "alerts", "audit", "documents", "rate-cons", "schedules", "messages", "settings", "ifta", "radar"

function Warm([string]$path) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest -Uri "$base/$path" -WebSession $session -UseBasicParsing -TimeoutSec 60 -Headers @{ Accept = "text/html" }
    $code = $r.StatusCode
    $html = $r.Content
  } catch { $code = "ERR"; $html = "" }
  $sw.Stop()
  [pscustomobject]@{ Path = "/$path"; Code = $code; Ms = [int]$sw.ElapsedMilliseconds; Html = $html }
}

Write-Host "Warming every page (two passes: the first pays the first-visit cost, the second shows what you will see)..."
$first = foreach ($p in $pages) { Warm $p }
# a few load pages too, found from the loads list, so the load drawer is warm
$ids = [regex]::Matches(($first | Where-Object Path -eq "/loads").Html, 'href="/loads/([A-Za-z0-9_-]{8,})"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -First 8
foreach ($id in $ids) { Warm "loads/$id" | Out-Null }
$second = foreach ($p in $pages) { Warm $p }

$second | Select-Object Path, Code, Ms | Format-Table -AutoSize
$slow = $second | Where-Object { $_.Ms -gt 600 -or $_.Code -ne 200 }
if ($slow) { Write-Host "Check these (slow or not 200):"; $slow | Select-Object Path, Code, Ms | Format-Table -AutoSize } else { Write-Host "All pages answered in under 600 ms. Ready to record at $base/sign-in" }
