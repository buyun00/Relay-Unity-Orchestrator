[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallDirectory = 'C:\ProgramData\Relay\UnityDialogGuard',
    [string]$TaskName = 'UnityDialogGuard',
    [string]$TaskPath = '\Relay\',
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Uninstall-UnityDialogGuard.ps1 from an Administrator PowerShell window.'
}

$resolvedInstall = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($InstallDirectory)
)
if ([string]::IsNullOrWhiteSpace($resolvedInstall) -or
    [System.IO.Path]::GetPathRoot($resolvedInstall) -eq $resolvedInstall) {
    throw "InstallDirectory must be a specific child directory: '$resolvedInstall'."
}
$installedExecutable = Join-Path $resolvedInstall 'UnityDialogGuard.exe'

Import-Module ScheduledTasks -ErrorAction Stop
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($task -and $PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
}

$processes = Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" |
    Where-Object {
        $_.ExecutablePath -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath($_.ExecutablePath),
            $installedExecutable,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
foreach ($process in $processes) {
    if ($PSCmdlet.ShouldProcess(
        "UnityDialogGuard PID $($process.ProcessId)",
        'Stop process'
    )) {
        Stop-Process -Id $process.ProcessId -Force
    }
}

if ($RemoveData) {
    if ((Test-Path -LiteralPath $resolvedInstall) -and
        $PSCmdlet.ShouldProcess($resolvedInstall, 'Remove installation and learned data')) {
        Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
    }
} else {
    if ((Test-Path -LiteralPath $installedExecutable) -and
        $PSCmdlet.ShouldProcess($installedExecutable, 'Remove executable')) {
        Remove-Item -LiteralPath $installedExecutable -Force
    }
}

[pscustomobject]@{
    uninstalled = $true
    task = "$TaskPath$TaskName"
    installDirectory = $resolvedInstall
    dataPreserved = -not $RemoveData
} | ConvertTo-Json -Compress
