# weather/schedule-windows.ps1 - Windows Task Scheduler setup for Weathermen
#
# Creates four scheduled tasks:
#   Weathermen-Scan   - runs market-scan.js every 30 minutes (includes exit monitor)
#   Weathermen-Settle - runs settle.js every hour (NOAA METAR settlement resolver)
#   Weathermen-Report - runs weekly-report.js every Sunday at 18:00 local time
#   Weathermen-Bot    - runs discord-bot/index.js every minute (handles !commands)
#
# All tasks run via wscript.exe VBS launchers so no console window ever appears.
#
# Usage (run once as Administrator):
#   powershell -ExecutionPolicy Bypass -File "D:\path\to\scripts\weather\schedule-windows.ps1"
#
# To remove tasks later:
#   Unregister-ScheduledTask -TaskName "Weathermen-Scan"   -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Weathermen-Settle" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Weathermen-Report" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Weathermen-Bot"    -Confirm:$false

$ProjectRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$NodePath     = (Get-Command node -ErrorAction Stop).Source
$ScanScript   = Join-Path $ProjectRoot 'scripts\weather\market-scan.js'
$ReportScript = Join-Path $ProjectRoot 'scripts\weather\weekly-report.js'
$BotScript    = Join-Path $ProjectRoot 'scripts\discord-bot\index.js'
$LogDir       = Join-Path $ProjectRoot 'logs'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# -- Generate silent VBS launchers (wscript window style 0 = truly invisible) --

$ScanVbs   = Join-Path $ProjectRoot 'scripts\weather\run-scan.vbs'
$SettleVbs = Join-Path $ProjectRoot 'scripts\weather\run-settle.vbs'
$ReportVbs = Join-Path $ProjectRoot 'scripts\weather\run-report.vbs'
$BotVbs    = Join-Path $ProjectRoot 'scripts\weather\run-bot.vbs'

$SettleScript = Join-Path $ProjectRoot 'scripts\weather\settle.js'

@"
Set oShell = CreateObject("WScript.Shell")
oShell.Run """$NodePath"" ""$ScanScript""", 0, False
"@ | Out-File -FilePath $ScanVbs -Encoding ascii

@"
Set oShell = CreateObject("WScript.Shell")
oShell.Run """$NodePath"" ""$SettleScript""", 0, False
"@ | Out-File -FilePath $SettleVbs -Encoding ascii

@"
Set oShell = CreateObject("WScript.Shell")
oShell.Run """$NodePath"" ""$ReportScript"" --force", 0, False
"@ | Out-File -FilePath $ReportVbs -Encoding ascii

@"
Set oShell = CreateObject("WScript.Shell")
oShell.Run """$NodePath"" ""$BotScript""", 0, False
"@ | Out-File -FilePath $BotVbs -Encoding ascii

Write-Host ''
Write-Host 'Weathermen - Windows Task Scheduler Setup'
Write-Host "Project: $ProjectRoot"
Write-Host "Node:    $NodePath"
Write-Host ''

# -- Task 1: market-scan every 30 minutes -------------------------------------

$scanAction = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('//NoLogo "' + $ScanVbs + '"') `
    -WorkingDirectory $ProjectRoot

$scanTrigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -Once `
    -At (Get-Date)

$scanSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$existingScan = Get-ScheduledTask -TaskName 'Weathermen-Scan' -ErrorAction SilentlyContinue
if ($existingScan) {
    Set-ScheduledTask -TaskName 'Weathermen-Scan' `
        -Action $scanAction `
        -Trigger $scanTrigger `
        -Settings $scanSettings | Out-Null
    Write-Host '[updated] Weathermen-Scan (every 30 minutes)'
} else {
    Register-ScheduledTask `
        -TaskName    'Weathermen-Scan' `
        -Description 'Polymarket weather edge scanner (every 30 min)' `
        -Action      $scanAction `
        -Trigger     $scanTrigger `
        -Settings    $scanSettings `
        -RunLevel    Limited | Out-Null
    Write-Host '[created] Weathermen-Scan (every 30 minutes)'
}

# -- Task 2: settle.js every 1 hour ------------------------------------------

$settleAction = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('//NoLogo "' + $SettleVbs + '"') `
    -WorkingDirectory $ProjectRoot

$settleTrigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -Once `
    -At (Get-Date)

$settleSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew

$existingSettle = Get-ScheduledTask -TaskName 'Weathermen-Settle' -ErrorAction SilentlyContinue
if ($existingSettle) {
    Set-ScheduledTask -TaskName 'Weathermen-Settle' `
        -Action $settleAction `
        -Trigger $settleTrigger `
        -Settings $settleSettings | Out-Null
    Write-Host '[updated] Weathermen-Settle (every 1 hour)'
} else {
    Register-ScheduledTask `
        -TaskName    'Weathermen-Settle' `
        -Description 'Weathermen NOAA METAR settlement resolver (every 1 hour)' `
        -Action      $settleAction `
        -Trigger     $settleTrigger `
        -Settings    $settleSettings `
        -RunLevel    Limited | Out-Null
    Write-Host '[created] Weathermen-Settle (every 1 hour)'
}

# -- Task 4: weekly-report every Sunday at 18:00 local time -------------------

$reportAction = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('//NoLogo "' + $ReportVbs + '"') `
    -WorkingDirectory $ProjectRoot

$reportTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '18:00'

$reportSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

$existingReport = Get-ScheduledTask -TaskName 'Weathermen-Report' -ErrorAction SilentlyContinue
if ($existingReport) {
    Set-ScheduledTask -TaskName 'Weathermen-Report' `
        -Action $reportAction `
        -Trigger $reportTrigger `
        -Settings $reportSettings | Out-Null
    Write-Host '[updated] Weathermen-Report (Sundays at 18:00)'
} else {
    Register-ScheduledTask `
        -TaskName    'Weathermen-Report' `
        -Description 'Weathermen weekly P&L report (Sundays 18:00)' `
        -Action      $reportAction `
        -Trigger     $reportTrigger `
        -Settings    $reportSettings `
        -RunLevel    Limited | Out-Null
    Write-Host '[created] Weathermen-Report (Sundays at 18:00)'
}

# -- Task 5: discord bot every 1 minute ---------------------------------------

$botAction = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('//NoLogo "' + $BotVbs + '"') `
    -WorkingDirectory $ProjectRoot

$botTrigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -Once `
    -At (Get-Date)

$botSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$existingBot = Get-ScheduledTask -TaskName 'Weathermen-Bot' -ErrorAction SilentlyContinue
if ($existingBot) {
    Set-ScheduledTask -TaskName 'Weathermen-Bot' `
        -Action $botAction `
        -Trigger $botTrigger `
        -Settings $botSettings | Out-Null
    Write-Host '[updated] Weathermen-Bot (every 1 minute)'
} else {
    Register-ScheduledTask `
        -TaskName    'Weathermen-Bot' `
        -Description 'Weathermen Discord bot - handles !commands (every 1 min)' `
        -Action      $botAction `
        -Trigger     $botTrigger `
        -Settings    $botSettings `
        -RunLevel    Limited | Out-Null
    Write-Host '[created] Weathermen-Bot (every 1 minute)'
}

Write-Host ''
Write-Host 'Setup complete. Verify with:'
Write-Host "  Get-ScheduledTask -TaskName 'Weathermen-*' | Select TaskName, State"
Write-Host ''
Write-Host 'To trigger a scan immediately:'
Write-Host "  Start-ScheduledTask -TaskName 'Weathermen-Scan'"
Write-Host ''
