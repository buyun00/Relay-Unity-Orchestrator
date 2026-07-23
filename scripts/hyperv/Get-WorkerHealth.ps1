[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [string]$CredentialPath,
    [string]$SharePath,
    [string]$HealthUrl,
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop

$vm = Get-VM -Name $VMName -ErrorAction Stop
$vmRunning = $vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running
$heartbeat = $false
$unity = $false
$skill = $false
$smb = $false
$errorText = $null
$credentialConfigured = -not [string]::IsNullOrWhiteSpace($CredentialPath)

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

    $credential = $null
    if ($credentialConfigured) {
        try {
            $credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
            if ($credential -isnot [System.Management.Automation.PSCredential]) {
                throw 'CredentialPath did not contain a PSCredential.'
            }
        } catch {
            $errorText = $_.Exception.Message
        }
    }

    # A VM can report Running several seconds before PowerShell Direct, Unity,
    # and its HTTP skill endpoint are ready. Poll within the adapter's health
    # timeout so a normal boot does not leave the worker stuck in attention.
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($credential -is [System.Management.Automation.PSCredential]) {
            try {
                $unity = [bool](Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
                    @(Get-Process -Name 'Unity' -ErrorAction SilentlyContinue).Count -gt 0
                } -ErrorAction Stop)
                # A successful PowerShell Direct round trip proves that the
                # guest is responsive even when Hyper-V Heartbeat is stale.
                $heartbeat = $true
                $errorText = $null
            } catch {
                $unity = $false
                $errorText = $_.Exception.Message
            }
        }

        $skill = [string]::IsNullOrWhiteSpace($HealthUrl)
        if (-not $skill) {
            try {
                $healthResponse = Invoke-WebRequest -Uri $HealthUrl -Method Get -UseBasicParsing `
                    -TimeoutSec 3 -ErrorAction Stop
                $skill = $healthResponse.StatusCode -ge 200 -and $healthResponse.StatusCode -lt 300
            } catch {
                $skill = $false
                if (-not $errorText) { $errorText = $_.Exception.Message }
            }
        }

        $smb = [string]::IsNullOrWhiteSpace($SharePath) -or (Test-Path -LiteralPath $SharePath)
        if ($heartbeat -and $smb -and $unity -and $skill) {
            $errorText = $null
            break
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ($true)
}

[pscustomobject]@{
    ready = $vmRunning -and $heartbeat -and $smb -and $unity -and $skill
    vm = $vmRunning
    heartbeat = $heartbeat
    smb = $smb
    unity = $unity
    skill = $skill
    credentialConfigured = $credentialConfigured
    vmState = $vm.State.ToString()
    error = $errorText
} | ConvertTo-Json -Compress
