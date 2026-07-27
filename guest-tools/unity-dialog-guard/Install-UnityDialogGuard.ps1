[CmdletBinding()]
param(
    [string]$InstallDirectory = 'C:\ProgramData\Relay\UnityDialogGuard',
    [string]$TaskName = 'UnityDialogGuard',
    [string]$TaskPath = '\Relay\',
    [string]$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [switch]$ReplaceConfig,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Install-UnityDialogGuard.ps1 from an Administrator PowerShell window in the Unity auto-logon account.'
}

$resolvedInstall = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($InstallDirectory)
)
if ([string]::IsNullOrWhiteSpace($resolvedInstall) -or
    [System.IO.Path]::GetPathRoot($resolvedInstall) -eq $resolvedInstall) {
    throw "InstallDirectory must be a specific child directory: '$resolvedInstall'."
}

$buildResult = & (Join-Path $PSScriptRoot 'Build-UnityDialogGuard.ps1') |
    ConvertFrom-Json
$sourceExecutable = [string]$buildResult.executable
if (-not (Test-Path -LiteralPath $sourceExecutable)) {
    throw "Build did not produce '$sourceExecutable'."
}

New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resolvedInstall 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resolvedInstall 'control\requests') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resolvedInstall 'control\responses') -Force | Out-Null

$installedExecutable = Join-Path $resolvedInstall 'UnityDialogGuard.exe'
$installedConfig = Join-Path $resolvedInstall 'config.json'
$defaultConfig = Join-Path $resolvedInstall 'config.defaults.json'
$learnedRules = Join-Path $resolvedInstall 'learned-rules.json'
$controlDirectory = Join-Path $resolvedInstall 'control'

Import-Module ScheduledTasks -ErrorAction Stop
$existingTask = Get-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath $TaskPath `
    -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
}
$runningProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath($_.ExecutablePath),
                $installedExecutable,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
)
if ($runningProcesses.Count -gt 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $runningProcesses = @(
            Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ExecutablePath -and
                    [string]::Equals(
                        [System.IO.Path]::GetFullPath($_.ExecutablePath),
                        $installedExecutable,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
                }
        )
    } while ($runningProcesses.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
}
foreach ($process in $runningProcesses) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
}
if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) {
    Copy-Item -LiteralPath $installedExecutable `
        -Destination ($installedExecutable + '.previous') `
        -Force
}

Copy-Item -LiteralPath $sourceExecutable -Destination $installedExecutable -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Destination $defaultConfig -Force
if ($ReplaceConfig -or -not (Test-Path -LiteralPath $installedConfig)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Destination $installedConfig -Force
}
if (-not (Test-Path -LiteralPath $learnedRules)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'learned-rules.example.json') `
        -Destination $learnedRules
}

$arguments = '--config "{0}" --learned "{1}" --log-dir "{2}" --control-dir "{3}"' -f
    $installedConfig,
    $learnedRules,
    (Join-Path $resolvedInstall 'logs'),
    $controlDirectory
$action = New-ScheduledTaskAction `
    -Execute $installedExecutable `
    -Argument $arguments `
    -WorkingDirectory $resolvedInstall
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath $TaskPath `
    -Action $action `
    -Trigger $trigger `
    -Principal $taskPrincipal `
    -Settings $settings `
    -Description 'Runs inside the Unity worker interactive desktop, dismisses known Unity dialogs, and learns manually handled dialogs.' `
    -Force | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Start-Sleep -Seconds 2
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
$runningProcess = Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" |
    Where-Object {
        $_.ExecutablePath -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath($_.ExecutablePath),
            $installedExecutable,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } |
    Select-Object -First 1

[pscustomobject]@{
    installed = $true
    installDirectory = $resolvedInstall
    executable = $installedExecutable
    config = $installedConfig
    learnedRules = $learnedRules
    controlDirectory = $controlDirectory
    state = (Join-Path $controlDirectory 'state.json')
    task = "$TaskPath$TaskName"
    taskState = $task.State.ToString()
    processId = if ($runningProcess) { [int]$runningProcess.ProcessId } else { $null }
    userId = $UserId
    configPreserved = -not $ReplaceConfig
} | ConvertTo-Json -Compress
