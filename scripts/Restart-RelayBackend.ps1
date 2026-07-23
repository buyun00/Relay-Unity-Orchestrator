[CmdletBinding()]
param(
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$startScript = Join-Path $root 'scripts\Start-RelayBackend.ps1'
$envFile = Join-Path $root '.env.local'

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $PSCommandPath,
        '-ProjectRoot',
        $root
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden `
        -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Relay backend start script was not found: $startScript"
}
if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Relay environment file was not found: $envFile"
}

$settings = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*(?:#|$)') { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { continue }
    $settings[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
}
$port = if ($settings.ContainsKey('PORT')) { [int]$settings.PORT } else { 4317 }
$adminToken = if ($settings.ContainsKey('PIPELINE_ADMIN_TOKEN')) { $settings.PIPELINE_ADMIN_TOKEN } else { $null }
if ([string]::IsNullOrWhiteSpace($adminToken)) {
    throw 'PIPELINE_ADMIN_TOKEN is not configured in .env.local.'
}

$headers = @{ Authorization = "Bearer $adminToken" }
$runtimeUrl = "http://127.0.0.1:$port/api/runtime"
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $runtime = Invoke-RestMethod -Uri $runtimeUrl -Headers $headers -TimeoutSec 10
    } catch {
        throw "Port $port is occupied, but it did not respond as the configured Relay API."
    }
    if (-not $runtime.ok) {
        throw "Port $port did not return a valid Relay runtime response."
    }
    $listenerProcessIds = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($listenerProcessIds.Count -ne 1) {
        throw "Port $port is owned by more than one process; refusing to stop it automatically."
    }
    $relayProcessId = [int]$listenerProcessIds[0]
    Stop-Process -Id $relayProcessId -Force -ErrorAction Stop
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    } while ($listener -and [DateTime]::UtcNow -lt $closeDeadline)
    if ($listener) {
        throw "Port $port did not close after stopping Relay process $relayProcessId."
    }
}

$logDirectory = if ($settings.ContainsKey('PIPELINE_DATA_DIR')) {
    Join-Path ([System.IO.Path]::GetFullPath($settings.PIPELINE_DATA_DIR)) 'logs'
} else {
    'C:\ProgramData\Relay\logs'
}
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logDirectory "backend-$stamp.stdout.log"
$stderrPath = Join-Path $logDirectory "backend-$stamp.stderr.log"

Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $root -ArgumentList @(
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $startScript,
    '-ProjectRoot',
    $root
) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$startDeadline = [DateTime]::UtcNow.AddSeconds(45)
$runtime = $null
do {
    Start-Sleep -Milliseconds 500
    try {
        $runtime = Invoke-RestMethod -Uri $runtimeUrl -Headers $headers -TimeoutSec 3
    } catch {
        $runtime = $null
    }
} while (-not $runtime -and [DateTime]::UtcNow -lt $startDeadline)

if (-not $runtime) {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
        (Get-Content -LiteralPath $stderrPath -Raw).Trim()
    } else {
        ''
    }
    throw "Relay backend did not start within 45 seconds. $stderr"
}

[pscustomobject]@{
    ready = [bool]$runtime.runtime.ready
    checkpointsEnabled = [bool]$runtime.runtime.checkpointsEnabled
    hyperVCanManage = [bool]$runtime.runtime.hyperv.canManage
    codexAuthenticated = [bool]$runtime.runtime.codex.authenticated
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
} | ConvertTo-Json -Compress
