Set-StrictMode -Version Latest

function Get-RelayVMStorageInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName
    )

    $vm = Get-VM -Name $VMName -ErrorAction Stop
    $snapshots = @(
        Get-VMSnapshot -VM $vm -ErrorAction Stop |
            Sort-Object Id |
            ForEach-Object {
                '{0}|{1}' -f $_.Id, $_.Name
            }
    )
    $disks = @(
        Get-VMHardDiskDrive -VM $vm -ErrorAction Stop |
            Sort-Object ControllerType, ControllerNumber, ControllerLocation |
            ForEach-Object {
                '{0}|{1}|{2}|{3}' -f $_.ControllerType, $_.ControllerNumber, $_.ControllerLocation, $_.Path
            }
    )

    [pscustomobject]@{
        snapshots = $snapshots
        disks = $disks
    }
}

function Assert-RelayVMStorageInventoryUnchanged {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Operation
    )

    $snapshotDifference = @(Compare-Object -ReferenceObject @($Before.snapshots) -DifferenceObject @($After.snapshots))
    if ($snapshotDifference.Count -gt 0) {
        throw "$Operation changed the checkpoint inventory."
    }

    $diskDifference = @(Compare-Object -ReferenceObject @($Before.disks) -DifferenceObject @($After.disks))
    if ($diskDifference.Count -gt 0) {
        throw "$Operation changed the VM disk attachment inventory."
    }
}

function Remove-RelayVMSavedStatePreservingStorage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Reason
    )

    $vm = Get-VM -Name $VMName -ErrorAction Stop
    if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Saved) {
        throw "VM '$VMName' must be in state 'Saved' before its saved state can be cleared; actual state: '$($vm.State)'."
    }

    $before = Get-RelayVMStorageInventory -VMName $VMName
    Remove-VMSavedState -VM $vm -ErrorAction Stop
    $updated = Get-VM -Name $VMName -ErrorAction Stop
    if ($updated.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
        throw "VM '$VMName' did not reach state 'Off' after clearing its saved state; actual state: '$($updated.State)'."
    }

    $after = Get-RelayVMStorageInventory -VMName $VMName
    Assert-RelayVMStorageInventoryUnchanged -Before $before -After $after -Operation 'Clearing the VM saved state'

    [pscustomobject]@{
        discarded = $true
        reason = $Reason
        state = $updated.State.ToString()
        checkpointCount = @($after.snapshots).Count
        diskCount = @($after.disks).Count
    }
}

function Start-RelayVMWithSavedStateFallback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName
    )

    $vm = Get-VM -Name $VMName -ErrorAction Stop
    $initialState = $vm.State.ToString()
    $resumeError = $null
    $savedStateDiscarded = $false

    if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) {
        return [pscustomobject]@{
            initialState = $initialState
            state = $initialState
            started = $false
            savedStateDiscarded = $false
            resumeError = $null
        }
    }

    if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Off) {
        Start-VM -VM $vm -ErrorAction Stop | Out-Null
    } elseif ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Saved) {
        try {
            Start-VM -VM $vm -ErrorAction Stop | Out-Null
        } catch {
            $resumeError = $_.Exception.Message
            $failedVM = Get-VM -Name $VMName -ErrorAction Stop
            if ($failedVM.State -eq [Microsoft.HyperV.PowerShell.VMState]::Saved) {
                $null = Remove-RelayVMSavedStatePreservingStorage `
                    -VMName $VMName `
                    -Reason "Saved-state resume failed: $resumeError"
                $savedStateDiscarded = $true
            } elseif ($failedVM.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
                throw "VM '$VMName' failed to resume from Saved state and ended in unsupported state '$($failedVM.State)'. Original error: $resumeError"
            }

            try {
                $offVM = Get-VM -Name $VMName -ErrorAction Stop
                Start-VM -VM $offVM -ErrorAction Stop | Out-Null
            } catch {
                throw "VM '$VMName' failed to resume its saved state and the cold-start fallback also failed. Resume error: $resumeError Cold-start error: $($_.Exception.Message)"
            }
        }
    } else {
        throw "VM '$VMName' is in state '$($vm.State)' and cannot be started automatically."
    }

    $updated = Get-VM -Name $VMName -ErrorAction Stop
    if ($updated.State -ne [Microsoft.HyperV.PowerShell.VMState]::Running) {
        throw "VM '$VMName' did not reach state 'Running' after start; actual state: '$($updated.State)'."
    }

    [pscustomobject]@{
        initialState = $initialState
        state = $updated.State.ToString()
        started = $true
        savedStateDiscarded = $savedStateDiscarded
        resumeError = $resumeError
    }
}
