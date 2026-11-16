#requires -Version 5.1
<#
  Stop a local Vivic online staging instance started by scripts/start-staging.ps1.

    pwsh scripts/stop-staging.ps1              # 8791
    pwsh scripts/stop-staging.ps1 -Port 8792
    pwsh scripts/stop-staging.ps1 -All         # stop every staging pid file
#>
param(
  [ValidateRange(1024, 65535)][int]$Port = 8791,
  [switch]$All
)

$ErrorActionPreference = "Stop"
$merge = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logs = Join-Path $merge "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Stop-One([int]$p) {
  $pidFile = Join-Path $logs "staging-$p.pid"
  $stopped = @()
  if (Test-Path $pidFile) {
    $procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($procId) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) { Stop-Process -Id $procId -Force; $stopped += "pid $procId" }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  # A pid file can be lost after a crash; fall back to the listener on this loopback port.
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      if (Get-Process -Id $_ -ErrorAction SilentlyContinue) { Stop-Process -Id $_ -Force; $stopped += "pid $_ (port $p)" }
    }
  if ($stopped.Count) { Write-Output ("stopped {0}: {1}" -f $p, ($stopped -join ", ")) }
  else { Write-Output ("nothing running on {0}" -f $p) }
}

if ($All) {
  Get-ChildItem $logs -Filter "staging-*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
    $value = [int]($_.BaseName -replace "^staging-", "")
    if ($value) { Stop-One $value }
  }
  # Also sweep the two documented ports even without a pid file.
  foreach ($p in 8791, 8792) { Stop-One $p }
} else {
  Stop-One $Port
}
