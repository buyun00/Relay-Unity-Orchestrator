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
$vm = Get-VM -Name $VMName -ErrorAction Stop

switch ($Action) {
    'start' {
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Off) {
            Start-VM -VM $vm -ErrorAction Stop | Out-Null
        } elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Running) {
            throw "VM '$VMName' is in state '$($vm.State)' and cannot be started."
        }
    }
    'shutdown' {
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) {
            Stop-VM -VM $vm -Shutdown -Confirm:$false -ErrorAction Stop
        } elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) {
            throw "VM '$VMName' is in state '$($vm.State)' and cannot be shut down gracefully."
        }
    }
    'restart' {
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) { Restart-VM -VM $vm -Force }
        else { Start-VM -VM $vm | Out-Null }
    }
    'forceOff' {
        if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) { Stop-VM -VM $vm -TurnOff -Force -Confirm:$false }
    }
}

$updated = Get-VM -Name $VMName -ErrorAction Stop
[pscustomobject]@{
    vmName = $VMName
    action = $Action
    state = $updated.State.ToString()
    status = $updated.Status
} | ConvertTo-Json -Compress
