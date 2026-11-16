#requires -Version 5.1
<#
  Start a local Vivic online (hosted) staging instance from this merge worktree.

  The instance never touches the production server and never writes the read-only
  export under work/live-20261101/: it runs against a COPY of the space data dir.
  Provider keys are decrypted in place by the copied .secret-key; nothing is printed.

  Examples
    pwsh scripts/start-staging.ps1                       # 8791, tool layer off, sections off
    pwsh scripts/start-staging.ps1 -Port 8792 -ToolCalls on -Sections on
    pwsh scripts/start-staging.ps1 -Port 8793 -DataDir D:\tmp\vivic-staging -ToolCalls on
#>
param(
  [ValidateRange(1024, 65535)][int]$Port = 8791,
  [Alias("Tools")][ValidateSet("on", "off")][string]$ToolCalls = "off",
  [ValidateSet("on", "off")][string]$Sections = "off",
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$merge = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$api = Join-Path $merge "apps\local-api"
$logs = Join-Path $merge "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$logFile = Join-Path $logs "staging-$Port.log"
$errFile = Join-Path $logs "staging-$Port.err.log"
$pidFile = Join-Path $logs "staging-$Port.pid"

if (-not (Test-Path (Join-Path $api "package.json"))) { throw "apps/local-api not found under $merge" }

if (-not $DataDir) {
  $DataDir = if ($Port -eq 8791) { Join-Path (Split-Path $merge -Parent) "staging-data" }
             else { Join-Path (Split-Path $merge -Parent) "staging-data-$Port" }
}
if (-not (Test-Path $DataDir)) { throw "Staging data dir not found: $DataDir (copy work/live-20261101/db first; never point at the input export)" }
$DataDir = (Resolve-Path $DataDir).Path
if (-not (Test-Path (Join-Path $DataDir "space.sqlite"))) { throw "Staging data dir has no space.sqlite: $DataDir" }

if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    throw "Port $Port already has a staging instance (pid $old). Run scripts/stop-staging.ps1 -Port $Port first."
  }
  Remove-Item $pidFile -Force
}

# Every instance binds its own port and its own data-dir copy (the space store is locked per dir).
$env:VIVIC_ONLINE_ORIGIN = "http://127.0.0.1:$Port"
$env:VIVIC_SPACE_DATA_DIR = $DataDir
$env:VIVIC_SPACE_API_ONLY = "1"
$env:PORT = "$Port"
if ($ToolCalls -eq "on") { $env:VIVIC_TOOL_CALLS = "on" } else { Remove-Item Env:VIVIC_TOOL_CALLS -ErrorAction SilentlyContinue }
if ($Sections -eq "on") { $env:VIVIC_SECTIONS = "on" } else { Remove-Item Env:VIVIC_SECTIONS -ErrorAction SilentlyContinue }

$process = Start-Process -FilePath "node" -ArgumentList "--import", "tsx", "src/online/index.ts" `
  -WorkingDirectory $api -RedirectStandardOutput $logFile -RedirectStandardError $errFile `
  -WindowStyle Hidden -PassThru
$process.Id | Set-Content -Path $pidFile

$health = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    if ($health.ok -eq $true) { break }
  } catch { $health = $null }
}

if (-not $health -or $health.ok -ne $true) {
  $tail = if (Test-Path $errFile) { (Get-Content $errFile -Tail 12) -join "`n" } else { "" }
  throw "Staging instance on $Port did not become healthy. stderr tail:`n$tail"
}

Write-Output ("staging ok | port={0} pid={1} toolCalls={2} sections={3}`ndataDir={4}`nhealth={5}`nlog={6}" -f `
  $Port, $process.Id, $ToolCalls, $Sections, $DataDir, ($health | ConvertTo-Json -Compress), $logFile)
