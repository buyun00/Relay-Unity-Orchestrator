[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-RelayTest {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$root = Join-Path $env:TEMP (
    'relay-machine-credential-{0}' -f [guid]::NewGuid().ToString('N')
)
$sourcePath = Join-Path $root 'legacy.xml'
$destinationPath = Join-Path $root 'machine.json'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$converter = Join-Path $projectRoot (
    'scripts\hyperv\Convert-RelayCredentialToMachineScope.ps1'
)
$helper = Join-Path $projectRoot 'scripts\hyperv\Credential.ps1'

New-Item -ItemType Directory -Path $root | Out-Null
try {
    $securePassword = New-Object System.Security.SecureString
    foreach ($character in 'test-password'.ToCharArray()) {
        $securePassword.AppendChar($character)
    }
    $securePassword.MakeReadOnly()
    $sourceCredential = New-Object System.Management.Automation.PSCredential(
        'fake-worker\fake-user',
        $securePassword
    )
    $sourceCredential | Export-Clixml -LiteralPath $sourcePath

    $conversionJson = & $converter `
        -SourcePath $sourcePath `
        -DestinationPath $destinationPath
    $conversion = $conversionJson | ConvertFrom-Json
    Assert-RelayTest ($conversion.ok -eq $true) 'Credential conversion failed.'

    $serialized = [System.IO.File]::ReadAllText($destinationPath)
    Assert-RelayTest (
        -not $serialized.Contains('test-password')
    ) 'The machine credential exposed its plaintext password.'

    . $helper
    $machineCredential = Import-RelayCredential -Path $destinationPath
    Assert-RelayTest (
        $machineCredential.UserName -eq 'fake-worker\fake-user'
    ) 'The machine credential user name changed.'
    Assert-RelayTest (
        $machineCredential.GetNetworkCredential().Password.Length -eq 13
    ) 'The machine credential password could not be decrypted.'
    $legacyCredential = Import-RelayCredential -Path $sourcePath
    Assert-RelayTest (
        $legacyCredential.UserName -eq 'fake-worker\fake-user'
    ) 'Legacy credential compatibility was lost.'

    $acl = Get-Acl -LiteralPath $destinationPath
    $principals = @($acl.Access | ForEach-Object {
        $_.IdentityReference.Translate(
            [System.Security.Principal.SecurityIdentifier]
        ).Value
    })
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-RelayTest $acl.AreAccessRulesProtected (
        'The machine credential still inherits directory ACLs.'
    )
    foreach ($requiredSid in @($currentSid, 'S-1-5-18', 'S-1-5-32-544')) {
        Assert-RelayTest ($principals -contains $requiredSid) (
            "The machine credential ACL is missing '$requiredSid'."
        )
    }
    Assert-RelayTest ($principals -notcontains 'S-1-5-32-545') (
        'The machine credential ACL grants access to Builtin Users.'
    )

    [pscustomobject]@{
        passed = 2
        machineScopeRoundTrip = $true
        legacyCompatible = $true
        aclProtected = $true
    } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
