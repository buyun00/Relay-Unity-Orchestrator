[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [string]$SharePath,
    [string]$HealthUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Hyper-V -ErrorAction Stop

$vm = Get-VM -Name $VMName -ErrorAction Stop
$vmRunning = $vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running
$heartbeat = $false
$unity = $false
$skill = $false
$smb = [string]::IsNullOrWhiteSpace($SharePath)
$errorText = $null

if ($vmRunning) {
    try {
        $heartbeatService = Get-VMIntegrationService -VMName $VMName | Where-Object {
            $_.Id -eq '84EAAE65-2F2E-45F5-9BB5-0E857DC8EB47'
        }
        $heartbeat = $null -ne $heartbeatService -and $heartbeatService.Enabled -and `
            $heartbeatService.PrimaryStatusDescription -notmatch 'No Contact|Lost Communication'
    } catch {
        $errorText = $_.Exception.Message
    }
    try {
        $credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
        $unity = [bool](Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
            @(Get-Process -Name 'Unity' -ErrorAction SilentlyContinue).Count -gt 0
        })
        $skill = [string]::IsNullOrWhiteSpace($HealthUrl)
        if (-not $skill) {
            try {
                $healthResponse = Invoke-WebRequest -Uri $HealthUrl -Method Get -UseBasicParsing `
                    -TimeoutSec 5 -ErrorAction Stop
                $skill = $healthResponse.StatusCode -ge 200 -and $healthResponse.StatusCode -lt 300
            } catch {
                $skill = $false
                if (-not $errorText) { $errorText = $_.Exception.Message }
            }
        }
    } catch {
        $errorText = $_.Exception.Message
    }
    if (-not [string]::IsNullOrWhiteSpace($SharePath)) {
        $smb = Test-Path -LiteralPath $SharePath
    }
}

[pscustomobject]@{
    ready = $vmRunning -and $heartbeat -and $smb -and $unity -and $skill
    vm = $vmRunning
    heartbeat = $heartbeat
    smb = $smb
    unity = $unity
    skill = $skill
    vmState = $vm.State.ToString()
    error = $errorText
} | ConvertTo-Json -Compress
