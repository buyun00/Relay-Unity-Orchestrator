[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$NodePath,
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap {
    if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
        [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    } else {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    exit 1
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$startScript = Join-Path $root 'scripts\Start-RelayWeb.ps1'
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
    if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
        $arguments += @('-NodePath', $NodePath)
    }
    $elevationId = [Guid]::NewGuid().ToString('N')
    $elevationResultPath = Join-Path ([IO.Path]::GetTempPath()) "relay-web-restart-$elevationId.json"
    $arguments += @('-ResultPath', $elevationResultPath)
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden `
        -ArgumentList $arguments -PassThru
    $elevationDeadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
    } while (
        -not (Test-Path -LiteralPath $elevationResultPath) -and
        -not $process.HasExited -and
        [DateTime]::UtcNow -lt $elevationDeadline
    )
    $elevatedResult = if (Test-Path -LiteralPath $elevationResultPath) {
        Get-Content -LiteralPath $elevationResultPath -Raw | ConvertFrom-Json
    } else {
        $null
    }
    Remove-Item -LiteralPath $elevationResultPath -Force -ErrorAction SilentlyContinue
    if (-not $elevatedResult) {
        throw 'Elevated Relay web restart did not return a result within 90 seconds.'
    }
    if (-not $elevatedResult.ok) {
        $detail = if ($elevatedResult) { $elevatedResult.error } else { 'No result was returned.' }
        throw "Elevated Relay web restart failed. $detail"
    }
    if ($elevatedResult -and $elevatedResult.output) {
        Write-Output $elevatedResult.output
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Relay web start script was not found: $startScript"
}

$settings = @{}
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*(?:#|$)') { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $settings[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
}
$port = if ($settings.ContainsKey('PORT')) { [int]$settings.PORT } else { 3000 }
$internalPort = if ($settings.ContainsKey('RELAY_INTERNAL_WEB_PORT')) {
    [int]$settings.RELAY_INTERNAL_WEB_PORT
} else {
    $port + 1
}
$webUrl = "http://127.0.0.1:$port/"

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 10
    } catch {
        throw "Port $port is occupied, but it did not respond as the Relay web console."
    }
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<title>Relay') {
        throw "Port $port did not return the Relay web console; refusing to stop it."
    }
    $listenerProcessIds = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($listenerProcessIds.Count -ne 1) {
        throw "Port $port is owned by more than one process; refusing to stop it automatically."
    }
    $relayProcessId = [int]$listenerProcessIds[0]
    $relayProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$relayProcessId"
    if (
        -not $relayProcess -or
        $relayProcess.CommandLine -notmatch '(server[\\/]web\.mjs|vinext.+\bdev\b)'
    ) {
        throw "Port $port is not owned by a recognized Relay web process; refusing to stop PID $relayProcessId."
    }
    Stop-Process -Id $relayProcessId -Force -ErrorAction Stop
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    } while ($listener -and [DateTime]::UtcNow -lt $closeDeadline)
    if ($listener) {
        throw "Port $port did not close after stopping Relay web process $relayProcessId."
    }
}

$rendererListener = Get-NetTCPConnection -LocalPort $internalPort -State Listen -ErrorAction SilentlyContinue
if ($rendererListener) {
    $rendererProcessIds = @($rendererListener | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($rendererProcessIds.Count -ne 1) {
        throw "Internal renderer port $internalPort has multiple owners; refusing to stop them automatically."
    }
    $rendererProcessId = [int]$rendererProcessIds[0]
    $rendererProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$rendererProcessId"
    if (
        -not $rendererProcess -or
        $rendererProcess.CommandLine -notmatch "vinext.+\bstart\b.+--port\s+$internalPort\b"
    ) {
        throw "Internal renderer port $internalPort is not owned by Relay; refusing to stop PID $rendererProcessId."
    }
    Stop-Process -Id $rendererProcessId -Force -ErrorAction Stop
}

$resolvedNodePath = if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodeCommand.Source
    } else {
        $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { $null }
    }
}
if (-not $resolvedNodePath) {
    throw 'Node.js was not found in PATH or the bundled Codex runtime. Pass -NodePath explicitly.'
}

$logDirectory = if ($settings.ContainsKey('PIPELINE_DATA_DIR')) {
    Join-Path ([System.IO.Path]::GetFullPath($settings.PIPELINE_DATA_DIR)) 'logs'
} else {
    'C:\ProgramData\Relay\logs'
}
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logDirectory "web-$stamp.stdout.log"
$stderrPath = Join-Path $logDirectory "web-$stamp.stderr.log"

Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $root -ArgumentList @(
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $startScript,
    '-ProjectRoot',
    $root,
    '-NodePath',
    $resolvedNodePath
) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$startDeadline = [DateTime]::UtcNow.AddSeconds(45)
$page = $null
do {
    Start-Sleep -Milliseconds 500
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 3
    } catch {
        $page = $null
    }
} while (-not $page -and [DateTime]::UtcNow -lt $startDeadline)

if (-not $page) {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
        (Get-Content -LiteralPath $stderrPath -Raw).Trim()
    } else {
        ''
    }
    throw "Relay production web service did not start within 45 seconds. $stderr"
}
if ($page.Headers['x-relay-web-proxy'] -ne '1' -or $page.Content -match '/@vite/client') {
    throw 'Relay web console started, but it is not serving the production build.'
}

$newListener = Get-NetTCPConnection -LocalPort $port -State Listen |
    Select-Object -First 1
$result = [pscustomobject]@{
    mode = 'production'
    port = $port
    processId = [int]$newListener.OwningProcess
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
} | ConvertTo-Json -Compress
if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    [pscustomobject]@{
        ok = $true
        output = $result
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} else {
    Write-Output $result
}
