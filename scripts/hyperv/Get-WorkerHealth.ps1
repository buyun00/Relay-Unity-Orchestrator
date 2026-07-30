[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [string]$CredentialPath,
    [string]$SharePath,
    # Retained for compatibility with older callers. Worker readiness no longer
    # probes or depends on the Unity Skill HTTP endpoint.
    [string]$HealthUrl,
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Credential.ps1')

function Get-RelaySmbShareRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Path
    )

    if ($Path -notmatch '^(\\\\[^\\]+\\[^\\]+)(?:\\.*)?$') {
        throw "SMB path '$Path' is not a valid UNC share path."
    }
    return $Matches[1]
}

function Test-RelaySmbPath {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return [pscustomobject]@{
            accessible = $true
            error = $null
            unauthorized = $false
        }
    }

    try {
        return [pscustomobject]@{
            accessible = [bool](Test-Path -LiteralPath $Path -PathType Container -ErrorAction Stop)
            error = $null
            unauthorized = $false
        }
    } catch {
        return [pscustomobject]@{
            accessible = $false
            error = $_.Exception.Message
            unauthorized = (
                $_.Exception -is [System.UnauthorizedAccessException] -or
                $_.FullyQualifiedErrorId -match 'UnauthorizedAccess|PermissionDenied'
            )
        }
    }
}

function Connect-RelaySmbGlobalShare {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ShareRoot,
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.PSCredential]$Credential
    )

    if (-not (Get-Command New-SmbGlobalMapping -ErrorAction SilentlyContinue)) {
        throw 'New-SmbGlobalMapping is unavailable on the Relay host.'
    }
    $systemIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

    try {
        New-SmbGlobalMapping `
            -RemotePath $ShareRoot `
            -Credential $Credential `
            -Persistent $true `
            -FullAccess @($systemIdentity) `
            -ErrorAction Stop | Out-Null
        return
    } catch {
        $firstError = $_.Exception.Message
    }

    foreach ($mapping in @(
        Get-SmbGlobalMapping -RemotePath $ShareRoot -ErrorAction SilentlyContinue
    )) {
        if ($mapping.RemotePath -eq $ShareRoot) {
            Remove-SmbGlobalMapping `
                -RemotePath $ShareRoot `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }
    try {
        New-SmbGlobalMapping `
            -RemotePath $ShareRoot `
            -Credential $Credential `
            -Persistent $true `
            -FullAccess @($systemIdentity) `
            -ErrorAction Stop | Out-Null
    } catch {
        throw (
            "SYSTEM SMB global mapping failed. Initial error: $firstError " +
            "Retry error: $($_.Exception.Message)"
        )
    }
}

function Connect-RelaySmbShare {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ShareRoot,
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.PSCredential]$Credential
    )

    if ($Credential.UserName -notmatch '[\\@]') {
        $serverName = ($ShareRoot -replace '^\\\\', '').Split('\')[0]
        $Credential = New-Object System.Management.Automation.PSCredential(
            "$serverName\$($Credential.UserName)",
            $Credential.Password
        )
    }

    if ([System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
        Connect-RelaySmbGlobalShare `
            -ShareRoot $ShareRoot `
            -Credential $Credential
        return
    }

    $mappingCommand = Get-Command New-SmbMapping -ErrorAction SilentlyContinue
    if (-not $mappingCommand) {
        throw 'New-SmbMapping is unavailable on the Relay host.'
    }

    $password = $Credential.GetNetworkCredential().Password
    try {
        New-SmbMapping -RemotePath $ShareRoot `
            -UserName $Credential.UserName `
            -Password $password `
            -Persistent $false `
            -ErrorAction Stop | Out-Null
        return
    } catch {
        $firstError = $_.Exception.Message
    }

    # An expired or anonymous connection to the exact share can prevent the
    # SYSTEM-hosted Relay service from authenticating with the guest account.
    # Remove only that mapping, never a different server or share, then retry.
    foreach ($mapping in @(
        Get-SmbMapping -ErrorAction SilentlyContinue |
            Where-Object {
                $_.RemotePath -eq $ShareRoot
            }
    )) {
        Remove-SmbMapping -RemotePath $mapping.RemotePath `
            -Force `
            -ErrorAction SilentlyContinue
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $null = & net.exe use $ShareRoot /delete /y 2>&1
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    try {
        New-SmbMapping -RemotePath $ShareRoot `
            -UserName $Credential.UserName `
            -Password $password `
            -Persistent $false `
            -ErrorAction Stop | Out-Null
    } catch {
        $retryError = $_.Exception.Message
        throw "SMB authentication refresh failed. Initial error: $firstError Retry error: $retryError"
    }
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
$vmRunning = $vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running
$heartbeat = $false
$unity = $false
$smb = $false
$smbError = $null
$smbReconnectAttempted = $false
$smbConnectionRefreshed = $false
$smbReconnectFailed = $false
$credentialError = $null
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
            $credential = Import-RelayCredential -Path $CredentialPath
        } catch {
            $credentialError = $_.Exception.Message
            $errorText = "Credential import failed: $credentialError"
        }
    }

    # A VM can report Running several seconds before PowerShell Direct and
    # Unity are ready. Skill HTTP availability and UnityDialogGuard heartbeat
    # are intentionally not worker-readiness gates.
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($credential -is [System.Management.Automation.PSCredential]) {
            try {
                $unity = [bool](Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
                    @(
                        Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" -ErrorAction SilentlyContinue
                    ).Count -gt 0
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

        $shareProbe = Test-RelaySmbPath -Path $SharePath
        if (
            -not $shareProbe.accessible -and
            $shareProbe.unauthorized -and
            -not $smbReconnectAttempted -and
            $credential -is [System.Management.Automation.PSCredential]
        ) {
            $smbReconnectAttempted = $true
            try {
                $shareRoot = Get-RelaySmbShareRoot -Path $SharePath
                Connect-RelaySmbShare `
                    -ShareRoot $shareRoot `
                    -Credential $credential
                $shareProbe = Test-RelaySmbPath -Path $SharePath
                $smbConnectionRefreshed = [bool]$shareProbe.accessible
            } catch {
                $smbReconnectFailed = $true
                $shareProbe = [pscustomobject]@{
                    accessible = $false
                    error = $_.Exception.Message
                    unauthorized = $true
                }
            }
        }
        $smb = [bool]$shareProbe.accessible
        $smbError = $shareProbe.error
        if (-not $smb) {
            $shareError = if ([string]::IsNullOrWhiteSpace([string]$smbError)) {
                "SMB share '$SharePath' does not exist or is unavailable."
            } else {
                "SMB share '$SharePath' is not accessible: $smbError"
            }
            $errorText = if ([string]::IsNullOrWhiteSpace([string]$errorText)) {
                $shareError
            } else {
                "$errorText $shareError"
            }
        }
        if (
            $shareProbe.unauthorized -and
            $credential -isnot [System.Management.Automation.PSCredential]
        ) {
            $smbReconnectFailed = $true
            $credentialDetail = if ([string]::IsNullOrWhiteSpace([string]$credentialError)) {
                'no usable guest credential is available'
            } else {
                "guest credential import failed: $credentialError"
            }
            $errorText = "$errorText SMB authentication refresh was skipped because $credentialDetail."
        }
        if ($heartbeat -and $smb -and $unity) {
            $errorText = $null
            break
        }
        if ($smbReconnectFailed) { break }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ($true)
}

[pscustomobject]@{
    ready = $vmRunning -and $heartbeat -and $smb -and $unity
    vm = $vmRunning
    heartbeat = $heartbeat
    smb = $smb
    unity = $unity
    skill = $null
    dialogGuard = $null
    credentialConfigured = $credentialConfigured
    credentialError = $credentialError
    smbConnectionRefreshed = $smbConnectionRefreshed
    smbError = $smbError
    vmState = $vm.State.ToString()
    error = $errorText
} | ConvertTo-Json -Compress
