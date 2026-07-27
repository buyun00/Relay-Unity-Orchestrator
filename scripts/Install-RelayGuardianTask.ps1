[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$TaskName = 'Relay Unity Guardian',
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
$startScript = Join-Path $root 'scripts\Start-RelayGuardian.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Guardian start script was not found: $startScript"
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

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    $elevationId = [Guid]::NewGuid().ToString('N')
    $elevationResultPath = Join-Path ([IO.Path]::GetTempPath()) "relay-guardian-install-$elevationId.json"
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        "`"$PSCommandPath`"",
        '-ProjectRoot',
        "`"$root`"",
        '-TaskName',
        "`"$TaskName`"",
        '-NodePath',
        "`"$resolvedNodePath`"",
        '-ResultPath',
        "`"$elevationResultPath`""
    )
    $elevatedResult = if (Test-Path -LiteralPath $elevationResultPath) {
        Get-Content -LiteralPath $elevationResultPath -Raw | ConvertFrom-Json
    } else {
        $null
    }
    Remove-Item -LiteralPath $elevationResultPath -Force -ErrorAction SilentlyContinue
    if (-not $elevatedResult) {
        throw "Elevated Guardian installation returned no result (exit code $($process.ExitCode))."
    }
    if (-not $elevatedResult.ok) {
        throw "Elevated Guardian installation failed. $($elevatedResult.error)"
    }
    Write-Output $elevatedResult.output
    exit 0
}

$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -ProjectRoot `"$root`" -NodePath `"$resolvedNodePath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$startup = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $startup `
    -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$guardianUrl = 'http://127.0.0.1:4318/api/health'
$guardianHealth = $null
$healthDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    try {
        $guardianHealth = Invoke-RestMethod -Uri $guardianUrl -TimeoutSec 2
    } catch {
        $guardianHealth = $null
    }
} while (-not $guardianHealth -and [DateTime]::UtcNow -lt $healthDeadline)
if (-not $guardianHealth -or -not $guardianHealth.ok) {
    $task = Get-ScheduledTask -TaskName $TaskName
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
    throw "Guardian task did not become healthy. State=$($task.State); LastTaskResult=$($taskInfo.LastTaskResult)."
}

$output = [pscustomobject]@{
    taskName = $TaskName
    state = (Get-ScheduledTask -TaskName $TaskName).State.ToString()
    guardianUrl = 'http://127.0.0.1:4318/'
    guardianVersion = $guardianHealth.version
} | ConvertTo-Json -Compress
if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    [pscustomobject]@{
        ok = $true
        output = $output
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} else {
    Write-Output $output
}
