[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Hyper-V -ErrorAction Stop

$global:relayTestShareConnected = $false
$global:relayTestMappingFails = $false
$global:relayTestMappingCalls = 0
$script:credentialPath = Join-Path $env:TEMP (
    'relay-worker-health-{0}.xml' -f [guid]::NewGuid().ToString('N')
)

function global:Get-VM {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name)

    [pscustomobject]@{
        Name = $Name
        State = [Microsoft.HyperV.PowerShell.VMState]::Running
    }
}

function global:Get-VMIntegrationService {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$VMName)

    [pscustomobject]@{
        Id = '84EAAE65-2F2E-45F5-9BB5-0E857DC8EB47'
        Enabled = $true
        PrimaryStatusDescription = 'OK'
    }
}

function global:Invoke-Command {
    [CmdletBinding()]
    param(
        [string]$VMName,
        [pscredential]$Credential,
        [scriptblock]$ScriptBlock
    )

    return $true
}

function global:Test-Path {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [string]$PathType
    )

    if ($LiteralPath -eq $script:credentialPath) {
        return Microsoft.PowerShell.Management\Test-Path `
            -LiteralPath $LiteralPath
    }
    if ($LiteralPath -eq '\\fake-worker\d\repo') {
        if ($global:relayTestShareConnected) { return $true }
        throw [System.UnauthorizedAccessException]::new('simulated Access is denied')
    }
    return $false
}

function global:Get-SmbMapping {
    [CmdletBinding()]
    param()
    return @()
}

function global:New-SmbMapping {
    [CmdletBinding()]
    param(
        [string]$RemotePath,
        [string]$UserName,
        [string]$Password,
        [bool]$Persistent
    )

    $global:relayTestMappingCalls += 1
    if ($global:relayTestMappingFails) {
        throw 'simulated SMB authentication failure'
    }
    if (
        $RemotePath -ne '\\fake-worker\d' -or
        $UserName -ne 'fake-worker\fake-worker-user' -or
        [string]::IsNullOrEmpty($Password)
    ) {
        throw 'SMB recovery received unexpected mapping parameters.'
    }
    $global:relayTestShareConnected = $true
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

$securePassword = New-Object System.Security.SecureString
foreach ($character in 'test-password'.ToCharArray()) {
    $securePassword.AppendChar($character)
}
$securePassword.MakeReadOnly()
$credential = New-Object System.Management.Automation.PSCredential(
    'fake-worker-user',
    $securePassword
)
$credential | Export-Clixml -LiteralPath $script:credentialPath

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$healthScript = Join-Path $projectRoot 'scripts\hyperv\Get-WorkerHealth.ps1'
try {
    $global:relayTestShareConnected = $false
    $global:relayTestMappingFails = $false
    $global:relayTestMappingCalls = 0
    $recoveredJson = & $healthScript `
        -VMName 'fake-worker' `
        -CredentialPath $script:credentialPath `
        -SharePath '\\fake-worker\d\repo' `
        -TimeoutSeconds 1
    $recovered = $recoveredJson | ConvertFrom-Json
    Assert-Equal $recovered.ready $true (
        'Authenticated SMB recovery should restore readiness. Result: {0}' -f (
            $recovered | ConvertTo-Json -Compress
        )
    )
    Assert-Equal $recovered.vm $true 'VM health should remain true.'
    Assert-Equal $recovered.heartbeat $true 'Heartbeat health should remain true.'
    Assert-Equal $recovered.unity $true 'Unity health should remain true.'
    Assert-Equal $recovered.smb $true 'SMB health should recover.'
    Assert-Equal $recovered.smbConnectionRefreshed $true 'The result should report the refreshed connection.'
    Assert-Equal $global:relayTestMappingCalls 1 'SMB authentication should be attempted once.'

    $global:relayTestShareConnected = $false
    $global:relayTestMappingFails = $true
    $global:relayTestMappingCalls = 0
    $failedJson = & $healthScript `
        -VMName 'fake-worker' `
        -CredentialPath $script:credentialPath `
        -SharePath '\\fake-worker\d\repo' `
        -TimeoutSeconds 1
    $failed = $failedJson | ConvertFrom-Json
    Assert-Equal $failed.ready $false 'An SMB authentication failure should keep readiness false.'
    Assert-Equal $failed.vm $true 'An SMB failure must not erase VM health.'
    Assert-Equal $failed.heartbeat $true 'An SMB failure must not erase heartbeat health.'
    Assert-Equal $failed.unity $true 'An SMB failure must not erase Unity health.'
    Assert-Equal $failed.smb $false 'SMB should remain false after authentication fails.'
    Assert-Equal $failed.smbConnectionRefreshed $false 'A failed refresh must not be reported as successful.'
    Assert-Equal $global:relayTestMappingCalls 2 'The bounded recovery should attempt the initial mapping and one retry.'
    if ($failed.error -notmatch 'SMB share' -or $failed.error -notmatch 'authentication') {
        throw "The structured SMB failure was not retained: '$($failed.error)'."
    }

    [pscustomobject]@{
        passed = 2
        authenticatedRecovery = $true
        failureStructured = $true
    } | ConvertTo-Json -Compress
} finally {
    Microsoft.PowerShell.Management\Remove-Item `
        -LiteralPath $script:credentialPath `
        -Force `
        -ErrorAction SilentlyContinue
}
