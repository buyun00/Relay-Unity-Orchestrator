[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$moduleAvailable = $null -ne (Get-Module -ListAvailable -Name Hyper-V)
$canManage = $false
$errorText = $null
$virtualMachines = @()

if ($moduleAvailable) {
    try {
        Import-Module Hyper-V -ErrorAction Stop
        $virtualMachines = @(Get-VM -ErrorAction Stop | Sort-Object Name | ForEach-Object {
            $vm = $_
            $heartbeat = $null
            try {
                $heartbeat = Get-VMIntegrationService -VM $vm -Name 'Heartbeat' -ErrorAction Stop
            } catch {
                $heartbeat = $null
            }
            $addresses = @()
            try {
                $addresses = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop |
                    ForEach-Object { $_.IPAddresses } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            } catch {
                $addresses = @()
            }
            [pscustomobject]@{
                id = $vm.Id.ToString()
                name = $vm.Name
                state = $vm.State.ToString()
                status = $vm.Status
                generation = $vm.Generation
                version = $vm.Version.ToString()
                cpuUsage = $vm.CPUUsage
                memoryAssigned = $vm.MemoryAssigned
                uptime = $vm.Uptime.ToString()
                heartbeat = if ($heartbeat) { $heartbeat.PrimaryStatusDescription } else { $null }
                ipAddresses = $addresses
                automaticStartAction = $vm.AutomaticStartAction.ToString()
                automaticStopAction = $vm.AutomaticStopAction.ToString()
            }
        })
        $canManage = $true
    } catch {
        $errorText = $_.Exception.Message
    }
}

[pscustomobject]@{
    computerName = $env:COMPUTERNAME
    moduleAvailable = $moduleAvailable
    canManage = $canManage
    elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
    checkpointsEnabled = $false
    vmCount = $virtualMachines.Count
    virtualMachines = $virtualMachines
    error = $errorText
} | ConvertTo-Json -Depth 6 -Compress
