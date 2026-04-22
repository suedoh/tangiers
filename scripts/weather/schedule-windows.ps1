# weather/schedule-windows.ps1 — Windows Task Scheduler setup for Weathermen
#
# Equivalent of `make weather-cron` on macOS/Linux.
# Creates two scheduled tasks:
#   Weathermen-Scan    — runs market-scan.js every 15 minutes
#   Weathermen-Report  — runs weekly-report.js every Sunday at 18:00 UTC
#
# Usage (run once as Administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\weather\schedule-windows.ps1
#
# To remove tasks later:
#   Unregister-ScheduledTask -TaskName "Weathermen-Scan"   -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Weathermen-Report" -Confirm:$false

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$NodePath    = (Get-Command node -ErrorAction Stop).Source
$ScanScript  = Join-Path $ProjectRoot "scripts\weather\market-scan.js"
$ReportScript= Join-Path $ProjectRoot "scripts\weather\weekly-report.js"
$LogDir      = Join-Path $ProjectRoot "logs"

# Ensure logs directory exists
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

Write-Host ""
Write-Host "  Weathermen — Windows Task Scheduler Setup" -ForegroundColor Cyan
Write-Host "  Project: $ProjectRoot"
Write-Host "  Node:    $NodePath"
Write-Host ""

# ── Task 1: market-scan every 15 minutes ──────────────────────────────────────

$scanAction  = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "`"$ScanScript`"" `
    -WorkingDirectory $ProjectRoot

$scanTrigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 15) -Once -At (Get-Date)

$scanSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

if (Get-ScheduledTask -TaskName "Weathermen-Scan" -ErrorAction SilentlyContinue) {
    Write-Host "  ✓  Weathermen-Scan already registered — updating..." -ForegroundColor Yellow
    Set-ScheduledTask -TaskName "Weathermen-Scan" -Action $scanAction -Trigger $scanTrigger -Settings $scanSettings | Out-Null
} else {
    Register-ScheduledTask `
        -TaskName    "Weathermen-Scan" `
        -Description "Polymarket weather edge scanner (every 15 min)" `
        -Action      $scanAction `
        -Trigger     $scanTrigger `
        -Settings    $scanSettings `
        -RunLevel    Limited | Out-Null
    Write-Host "  ✓  Weathermen-Scan registered (every 15 minutes)" -ForegroundColor Green
}

# ── Task 2: weekly-report every Sunday at 18:00 UTC ───────────────────────────
# Note: Task Scheduler uses local time. Adjust the hour to match 18:00 UTC
# for your timezone. Default below is 18:00 local — edit if needed.

$reportAction = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "`"$ReportScript`" --force" `
    -WorkingDirectory $ProjectRoot

$reportTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "18:00"

$reportSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

if (Get-ScheduledTask -TaskName "Weathermen-Report" -ErrorAction SilentlyContinue) {
    Write-Host "  ✓  Weathermen-Report already registered — updating..." -ForegroundColor Yellow
    Set-ScheduledTask -TaskName "Weathermen-Report" -Action $reportAction -Trigger $reportTrigger -Settings $reportSettings | Out-Null
} else {
    Register-ScheduledTask `
        -TaskName    "Weathermen-Report" `
        -Description "Weathermen weekly P&L report (Sundays 18:00)" `
        -Action      $reportAction `
        -Trigger     $reportTrigger `
        -Settings    $reportSettings `
        -RunLevel    Limited | Out-Null
    Write-Host "  ✓  Weathermen-Report registered (Sundays at 18:00)" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Setup complete. To verify:" -ForegroundColor Cyan
Write-Host "    Get-ScheduledTask -TaskName 'Weathermen-*' | Select TaskName, State"
Write-Host ""
Write-Host "  To run a scan now:"
Write-Host "    Start-ScheduledTask -TaskName 'Weathermen-Scan'"
Write-Host "  Or directly:"
Write-Host "    node `"$ScanScript`""
Write-Host ""
