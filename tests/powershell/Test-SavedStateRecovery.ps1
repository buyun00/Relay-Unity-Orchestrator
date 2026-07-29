[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Hyper-V -ErrorAction Stop

$script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Off
$script:resumeFails = $false
$script:startCalls = 0
$script:removeCalls = 0
$script:snapshotNames = @('PROJECT_READY')
$script:diskPaths = @('D:\vm\os.avhdx', 'D:\vm\data.avhdx')

function Get-VM {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name)

    [pscustomobject]@{
        Name = $Name
        State = $script:vmState
        Status = 'OK'
    }
}

function Get-VMSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$VM)

    for ($index = 0; $index -lt $script:snapshotNames.Count; $index += 1) {
        [pscustomobject]@{
            Id = [guid]::Parse(('00000000-0000-0000-0000-{0:D12}' -f ($index + 1)))
            Name = $script:snapshotNames[$index]
        }
    }
}

function Get-VMHardDiskDrive {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$VM)

    for ($index = 0; $index -lt $script:diskPaths.Count; $index += 1) {
        [pscustomobject]@{
            ControllerType = 'SCSI'
            ControllerNumber = 0
            ControllerLocation = $index
            Path = $script:diskPaths[$index]
        }
    }
}

function Start-VM {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$VM)

    $script:startCalls += 1
    if (
        $script:vmState -eq [Microsoft.HyperV.PowerShell.VMState]::Saved -and
        $script:resumeFails
    ) {
        throw 'simulated VMRS restore failure 0xC0000001'
    }
    $script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Running
}

function Remove-VMSavedState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$VM)

    $script:removeCalls += 1
    if ($script:vmState -ne [Microsoft.HyperV.PowerShell.VMState]::Saved) {
        throw "Remove-VMSavedState called from unexpected state '$script:vmState'."
    }
    $script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Off
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', actual '$Actual'."
    }
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $projectRoot 'scripts\hyperv\Saved-State-Recovery.ps1')

$script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Saved
$script:resumeFails = $false
$script:startCalls = 0
$script:removeCalls = 0
$valid = Start-RelayVMWithSavedStateFallback -VMName 'valid-saved'
Assert-Equal $valid.state 'Running' 'A valid saved state should resume.'
Assert-Equal $valid.savedStateDiscarded $false 'A valid saved state must be preserved.'
Assert-Equal $script:startCalls 1 'A valid saved state should be started once.'
Assert-Equal $script:removeCalls 0 'A valid saved state must not be cleared.'

$script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Saved
$script:resumeFails = $true
$script:startCalls = 0
$script:removeCalls = 0
$invalid = Start-RelayVMWithSavedStateFallback -VMName 'invalid-saved'
Assert-Equal $invalid.state 'Running' 'An invalid saved state should cold-start.'
Assert-Equal $invalid.savedStateDiscarded $true 'An invalid saved state should be cleared after resume fails.'
Assert-Equal $script:startCalls 2 'The invalid path should attempt resume and then cold-start once.'
Assert-Equal $script:removeCalls 1 'The invalid saved state should be cleared exactly once.'
if ($invalid.resumeError -notmatch '0xC0000001') {
    throw 'The original saved-state resume error was not retained.'
}

$script:vmState = [Microsoft.HyperV.PowerShell.VMState]::Off
$script:resumeFails = $false
$script:startCalls = 0
$script:removeCalls = 0
$off = Start-RelayVMWithSavedStateFallback -VMName 'off-vm'
Assert-Equal $off.state 'Running' 'An Off VM should cold-start normally.'
Assert-Equal $off.savedStateDiscarded $false 'An Off VM has no saved state to clear.'
Assert-Equal $script:startCalls 1 'An Off VM should be started once.'
Assert-Equal $script:removeCalls 0 'An Off VM must not call Remove-VMSavedState.'

[pscustomobject]@{
    passed = 3
    validSavedPreserved = $true
    invalidSavedRecovered = $true
    offColdStarted = $true
} | ConvertTo-Json -Compress
