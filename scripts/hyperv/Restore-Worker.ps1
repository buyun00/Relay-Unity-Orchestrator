[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CheckpointName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Saved-State-Recovery.ps1')
. (Join-Path $PSScriptRoot 'Credential.ps1')

$vm = Get-VM -Name $VMName -ErrorAction Stop
$checkpoint = @(Get-VMSnapshot -VM $vm -Name $CheckpointName -ErrorAction Stop)
if ($checkpoint.Count -ne 1) {
    throw "Expected exactly one checkpoint named '$CheckpointName' for '$VMName'; found $($checkpoint.Count)."
}
$credential = Import-RelayCredential -Path $CredentialPath

if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Saved) {
    $null = Remove-RelayVMSavedStatePreservingStorage `
        -VMName $VMName `
        -Reason "Applying checkpoint '$CheckpointName' replaces the current saved state"
} elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
    Stop-VM -VM $vm -TurnOff -Force -Confirm:$false
}
Restore-VMCheckpoint -Name $CheckpointName -VMName $VMName -Confirm:$false
$startResult = Start-RelayVMWithSavedStateFallback -VMName $VMName

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$guestReady = $false
do {
    try {
        $null = Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock { $env:COMPUTERNAME } -ErrorAction Stop
        $guestReady = $true
        break
    } catch {
        Start-Sleep -Seconds 3
    }
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $guestReady) {
    throw "VM '$VMName' started, but PowerShell Direct did not become ready within $TimeoutSeconds seconds."
}

# A checkpoint may contain an older desktop helper. Overlay the last validated
# host package once, without an AI audit or a new task admission gate.
$dialogGuardSync = $null
try {
    $dialogGuardSync = & (Join-Path $PSScriptRoot 'Sync-UnityDialogGuard.ps1') `
        -VMName $VMName -CredentialPath $CredentialPath
} catch {
    $dialogGuardSync = [pscustomobject]@{ changed = $false; warning = $_.Exception.Message }
    Write-Warning "Optional DialogGuard sync: $($_.Exception.Message)"
}

[pscustomobject]@{
    vmName = $VMName
    checkpointName = $CheckpointName
    checkpointRestored = $true
    state = (Get-VM -Name $VMName).State.ToString()
    guestReady = $true
    savedStateDiscarded = [bool]$startResult.savedStateDiscarded
    resumeError = $startResult.resumeError
    dialogGuardSync = $dialogGuardSync
} | ConvertTo-Json -Compress
