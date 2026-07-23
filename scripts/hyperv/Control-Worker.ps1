[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateSet('start', 'shutdown', 'restart', 'forceOff')][string]$Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $VMName -ErrorAction Stop

switch ($Action) {
    'start' {
        if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Running) { Start-VM -VM $vm | Out-Null }
    }
    'shutdown' {
        if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) { Stop-VM -VM $vm -Confirm:$false }
    }
    'restart' {
        if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) { Restart-VM -VM $vm -Force }
        else { Start-VM -VM $vm | Out-Null }
    }
    'forceOff' {
        if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) { Stop-VM -VM $vm -TurnOff -Force -Confirm:$false }
    }
}

[pscustomobject]@{
    vmName = $VMName
    action = $Action
    state = (Get-VM -Name $VMName).State.ToString()
} | ConvertTo-Json -Compress
