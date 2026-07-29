[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateSet('start', 'shutdown', 'restart', 'forceOff')][string]$Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Saved-State-Recovery.ps1')

$initialVM = Get-VM -Name $VMName -ErrorAction Stop
$initialState = $initialVM.State.ToString()
$savedStateDiscarded = $false
$resumeError = $null

switch ($Action) {
    'start' {
        $startResult = Start-RelayVMWithSavedStateFallback -VMName $VMName
        $savedStateDiscarded = [bool]$startResult.savedStateDiscarded
        $resumeError = $startResult.resumeError
    }
    'shutdown' {
        $vm = Get-VM -Name $VMName -ErrorAction Stop
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) {
            Stop-VM -VM $vm -Confirm:$false -ErrorAction Stop
        } elseif ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Saved) {
            try {
                Start-VM -VM $vm -ErrorAction Stop | Out-Null
                $runningVM = Get-VM -Name $VMName -ErrorAction Stop
                Stop-VM -VM $runningVM -Confirm:$false -ErrorAction Stop
            } catch {
                $resumeError = $_.Exception.Message
                $failedVM = Get-VM -Name $VMName -ErrorAction Stop
                if ($failedVM.State -ne [Microsoft.HyperV.PowerShell.VMState]::Saved) {
                    throw
                }
                $null = Remove-RelayVMSavedStatePreservingStorage `
                    -VMName $VMName `
                    -Reason "Shutdown could not resume the saved VM: $resumeError"
                $savedStateDiscarded = $true
            }
        } elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
            throw "VM '$VMName' is in state '$($vm.State)' and cannot be shut down gracefully."
        }
    }
    'restart' {
        $vm = Get-VM -Name $VMName -ErrorAction Stop
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) { Restart-VM -VM $vm -Force }
        else {
            $startResult = Start-RelayVMWithSavedStateFallback -VMName $VMName
            $savedStateDiscarded = [bool]$startResult.savedStateDiscarded
            $resumeError = $startResult.resumeError
        }
    }
    'forceOff' {
        $vm = Get-VM -Name $VMName -ErrorAction Stop
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Saved) {
            $null = Remove-RelayVMSavedStatePreservingStorage `
                -VMName $VMName `
                -Reason 'Explicit forceOff action'
            $savedStateDiscarded = $true
        } elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
            Stop-VM -VM $vm -TurnOff -Force -Confirm:$false
        }
    }
}

$updated = Get-VM -Name $VMName -ErrorAction Stop
[pscustomobject]@{
    vmName = $VMName
    action = $Action
    initialState = $initialState
    state = $updated.State.ToString()
    status = $updated.Status
    savedStateDiscarded = $savedStateDiscarded
    resumeError = $resumeError
} | ConvertTo-Json -Compress
