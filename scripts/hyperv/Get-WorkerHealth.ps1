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
$dialogGuard = $false
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
                $guestHealth = Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
                    $unityProcesses = @(
                        Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" -ErrorAction SilentlyContinue
                    )
                    $guardProcesses = @(
                        Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" -ErrorAction SilentlyContinue
                    )
                    $unitySessions = @($unityProcesses | ForEach-Object { [int]$_.SessionId })
                    $sameSessionGuard = @(
                        $guardProcesses |
                            Where-Object { $unitySessions -contains [int]$_.SessionId }
                    ) | Select-Object -First 1
                    $guardStatePath =
                        'C:\ProgramData\Relay\UnityDialogGuard\control\state.json'
                    $guardHeartbeat = $false
                    if ($sameSessionGuard -and
                        (Test-Path -LiteralPath $guardStatePath -PathType Leaf)) {
                        try {
                            $guardState = Get-Content -LiteralPath $guardStatePath `
                                -Raw -Encoding UTF8 |
                                ConvertFrom-Json
                            $lastScan = [DateTime]::Parse(
                                [string]$guardState.lastScanAt
                            ).ToUniversalTime()
                            $guardHeartbeat =
                                [bool]$guardState.healthy -and
                                ([DateTime]::UtcNow - $lastScan).TotalSeconds -le 10 -and
                                [int]$guardState.processId -eq
                                    [int]$sameSessionGuard.ProcessId
                        } catch {
                            $guardHeartbeat = $false
                        }
                    }
                    [pscustomobject]@{
                        unity = $unityProcesses.Count -gt 0
                        dialogGuard = [bool]$sameSessionGuard -and $guardHeartbeat
                    }
                } -ErrorAction Stop
                $unity = [bool]$guestHealth.unity
                $dialogGuard = [bool]$guestHealth.dialogGuard
                # A successful PowerShell Direct round trip proves that the
                # guest is responsive even when Hyper-V Heartbeat is stale.
                $heartbeat = $true
                $errorText = $null
            } catch {
                $unity = $false
                $dialogGuard = $false
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
        if ($heartbeat -and $smb -and $unity -and $skill -and $dialogGuard) {
            $errorText = $null
            break
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ($true)
}

if ($vmRunning -and $heartbeat -and $smb -and $unity -and $skill -and
    -not $dialogGuard -and -not $errorText) {
    $errorText =
        'UnityDialogGuard is not running with a fresh heartbeat in the Unity interactive session.'
}

[pscustomobject]@{
    ready = $vmRunning -and $heartbeat -and $smb -and $unity -and $skill -and $dialogGuard
    vm = $vmRunning
    heartbeat = $heartbeat
    smb = $smb
    unity = $unity
    skill = $skill
    dialogGuard = $dialogGuard
    credentialConfigured = $credentialConfigured
    vmState = $vm.State.ToString()
    error = $errorText
} | ConvertTo-Json -Compress
