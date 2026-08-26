[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Protect', 'Unprotect')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
}

$format = 'relay-project-management-sessions-dpapi-v1'
$statePath = [System.IO.Path]::GetFullPath($Path)
$entropy = [System.Text.Encoding]::UTF8.GetBytes(
    'Relay-Unity-Orchestrator/project-management-sessions/v1'
)
$plainBytes = $null
$protectedBytes = $null
$temporaryPath = $null
$backupPath = $null

function Set-RelaySecretFileAcl {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

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
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($currentUser)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in $allowedIdentities) {
        $acl.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new(
                $identity,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
        )
    }
    [System.IO.File]::SetAccessControl($LiteralPath, $acl)
}

try {
    if ($Mode -eq 'Protect') {
        $plainText = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($plainText)) {
            throw 'Project-management session state was empty.'
        }
        try {
            $null = $plainText | ConvertFrom-Json -ErrorAction Stop
            $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plainText)
        } finally {
            $plainText = $null
        }
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        $document = [ordered]@{
            format = $format
            protectedPayload = [Convert]::ToBase64String($protectedBytes)
        } | ConvertTo-Json -Compress
        $directory = Split-Path -Parent $statePath
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        $temporaryPath = Join-Path $directory (
            '.project-management-sessions-{0}.tmp' -f [guid]::NewGuid().ToString('N')
        )
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $document,
            [System.Text.UTF8Encoding]::new($false)
        )
        Set-RelaySecretFileAcl -LiteralPath $temporaryPath
        if ([System.IO.File]::Exists($statePath)) {
            $backupPath = Join-Path $directory (
                '.project-management-sessions-{0}.bak' -f [guid]::NewGuid().ToString('N')
            )
            [System.IO.File]::Replace(
                $temporaryPath,
                $statePath,
                $backupPath,
                $true
            )
            $temporaryPath = $null
            [System.IO.File]::Delete($backupPath)
            $backupPath = $null
        } else {
            [System.IO.File]::Move($temporaryPath, $statePath)
            $temporaryPath = $null
        }
        [Console]::Out.Write((
            [ordered]@{ ok = $true; format = $format; path = $statePath } |
                ConvertTo-Json -Compress
        ))
        return
    }

    if (-not [System.IO.File]::Exists($statePath)) {
        throw "Project-management session state '$statePath' does not exist."
    }
    $document = [System.IO.File]::ReadAllText($statePath) |
        ConvertFrom-Json -ErrorAction Stop
    if ($document.format -ne $format -or -not $document.protectedPayload) {
        throw 'Project-management session state has an unsupported format.'
    }
    $protectedBytes = [Convert]::FromBase64String(
        [string]$document.protectedPayload
    )
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))
} finally {
    if ($null -ne $plainBytes) {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    if ($null -ne $protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
    }
    if ($null -ne $entropy) {
        [Array]::Clear($entropy, 0, $entropy.Length)
    }
    if ($temporaryPath -and [System.IO.File]::Exists($temporaryPath)) {
        [System.IO.File]::Delete($temporaryPath)
    }
    if ($backupPath -and [System.IO.File]::Exists($backupPath)) {
        [System.IO.File]::Delete($backupPath)
    }
}
