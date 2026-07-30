[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [string]$ControlDirectory = 'C:\ProgramData\Relay\UnityDialogGuard\control',
    [string]$ScreenshotDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
$credential = Import-RelayCredential -Path $CredentialPath

$includeScreenshots = -not [string]::IsNullOrWhiteSpace($ScreenshotDirectory)
$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $ControlDirectory, $includeScreenshots
) -ScriptBlock {
    param($ControlPath, $IncludeScreenshots)
    $ErrorActionPreference = 'Stop'
    $statePath = Join-Path $ControlPath 'state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "UnityDialogGuard state was not found at '$statePath'."
    }
    $stateJson = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8
    $state = $stateJson | ConvertFrom-Json
    $installedExecutable = Join-Path (Split-Path -Parent $ControlPath) 'UnityDialogGuard.exe'
    $screenshots = @()
    if ($IncludeScreenshots) {
        foreach ($dialog in @($state.pendingDialogs)) {
            $path = [string]$dialog.screenshotPath
            if ([string]::IsNullOrWhiteSpace($path) -or
                -not (Test-Path -LiteralPath $path -PathType Leaf)) {
                continue
            }
            $screenshots += [pscustomobject]@{
                dialogId = [string]$dialog.dialogId
                fileName = [System.IO.Path]::GetFileName($path)
                bytes = [System.IO.File]::ReadAllBytes($path)
            }
        }
    }
    $process = Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" |
        Where-Object {
            $_.ExecutablePath -and
            [System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq
                $installedExecutable
        } |
        Select-Object -First 1
    [pscustomobject]@{
        stateJson = $stateJson
        processId = if ($process) { [int]$process.ProcessId } else { $null }
        screenshots = $screenshots
    }
} -ErrorAction Stop

$state = $result.stateJson | ConvertFrom-Json
$state | Add-Member -NotePropertyName guardProcessRunning `
    -NotePropertyValue ($null -ne $result.processId) -Force
$state | Add-Member -NotePropertyName observedProcessId `
    -NotePropertyValue $result.processId -Force
$lastScan = [DateTime]::Parse([string]$state.lastScanAt).ToUniversalTime()
$state | Add-Member -NotePropertyName heartbeatAgeSeconds `
    -NotePropertyValue ([Math]::Round(([DateTime]::UtcNow - $lastScan).TotalSeconds, 3)) `
    -Force

if ($includeScreenshots) {
    $resolvedScreenshots = [System.IO.Path]::GetFullPath($ScreenshotDirectory)
    New-Item -ItemType Directory -Path $resolvedScreenshots -Force | Out-Null
    foreach ($screenshot in @($result.screenshots)) {
        $destination = Join-Path $resolvedScreenshots ([string]$screenshot.fileName)
        [System.IO.File]::WriteAllBytes($destination, [byte[]]$screenshot.bytes)
        foreach ($dialog in @($state.pendingDialogs)) {
            if ([string]$dialog.dialogId -eq [string]$screenshot.dialogId) {
                $dialog | Add-Member -NotePropertyName hostScreenshotPath `
                    -NotePropertyValue $destination -Force
            }
        }
    }
}

$state | ConvertTo-Json -Depth 12 -Compress
