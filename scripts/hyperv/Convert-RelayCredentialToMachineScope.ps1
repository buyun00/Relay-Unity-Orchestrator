[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
}

$sourceFile = [System.IO.Path]::GetFullPath($SourcePath)
$destinationFile = [System.IO.Path]::GetFullPath($DestinationPath)
if (Test-Path -LiteralPath $destinationFile) {
    throw "Destination credential file '$destinationFile' already exists."
}

$credential = Import-Clixml -LiteralPath $sourceFile
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw "Source credential file '$sourceFile' did not contain a PSCredential."
}

$destinationDirectory = Split-Path -Parent $destinationFile
if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
    throw "Destination credential directory '$destinationDirectory' does not exist."
}

$temporaryFile = Join-Path $destinationDirectory (
    '.relay-credential-{0}.tmp' -f [guid]::NewGuid().ToString('N')
)
$plainBytes = $null
$protectedBytes = $null
try {
    $plainPassword = $credential.GetNetworkCredential().Password
    try {
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plainPassword)
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
    } finally {
        $plainPassword = $null
    }

    $document = [ordered]@{
        format = 'relay-machine-credential-v1'
        userName = $credential.UserName
        protectedPassword = [Convert]::ToBase64String($protectedBytes)
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        $temporaryFile,
        $document,
        [System.Text.UTF8Encoding]::new($false)
    )

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedIdentities = @(
        $currentUser,
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        ),
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
            $null
        )
    )
    $acl = Get-Acl -LiteralPath $temporaryFile
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        $acl.RemoveAccessRuleSpecific($existingRule)
    }
    foreach ($identity in $allowedIdentities) {
        $acl.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new(
                $identity,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
        )
    }
    Set-Acl -LiteralPath $temporaryFile -AclObject $acl
    [System.IO.File]::Move($temporaryFile, $destinationFile)
} finally {
    if ($null -ne $plainBytes) {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    if ($null -ne $protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
    }
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    ok = $true
    path = $destinationFile
    format = 'relay-machine-credential-v1'
    userName = $credential.UserName
} | ConvertTo-Json -Compress
