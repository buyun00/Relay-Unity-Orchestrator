function Import-RelayCredential {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    $credentialFile = [System.IO.Path]::GetFullPath($Path)
    if (-not (Microsoft.PowerShell.Management\Test-Path `
        -LiteralPath $credentialFile `
        -PathType Leaf)) {
        throw "Credential file '$credentialFile' does not exist."
    }

    $legacyError = $null
    try {
        $legacyCredential = Import-Clixml -LiteralPath $credentialFile
        if ($legacyCredential -is [System.Management.Automation.PSCredential]) {
            return $legacyCredential
        }
        $legacyError = 'the file did not contain a PSCredential'
    } catch {
        $legacyError = $_.Exception.Message
    }

    try {
        if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
            Add-Type -AssemblyName System.Security -ErrorAction Stop
        }
        $document = [System.IO.File]::ReadAllText(
            $credentialFile,
            [System.Text.Encoding]::UTF8
        ) | ConvertFrom-Json
        if ($document.format -ne 'relay-machine-credential-v1') {
            throw "unsupported credential format '$($document.format)'"
        }
        $userName = [string]$document.userName
        $protectedPassword = [string]$document.protectedPassword
        if (
            [string]::IsNullOrWhiteSpace($userName) -or
            [string]::IsNullOrWhiteSpace($protectedPassword)
        ) {
            throw 'the machine credential is missing its user name or protected password'
        }

        $protectedBytes = [Convert]::FromBase64String($protectedPassword)
        $plainBytes = $null
        try {
            $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $protectedBytes,
                $null,
                [System.Security.Cryptography.DataProtectionScope]::LocalMachine
            )
            $password = [System.Text.Encoding]::UTF8.GetString($plainBytes)
            try {
                $securePassword = New-Object System.Security.SecureString
                foreach ($character in $password.ToCharArray()) {
                    $securePassword.AppendChar($character)
                }
                $securePassword.MakeReadOnly()
                return New-Object System.Management.Automation.PSCredential(
                    $userName,
                    $securePassword
                )
            } finally {
                $password = $null
            }
        } finally {
            if ($null -ne $plainBytes) {
                [Array]::Clear($plainBytes, 0, $plainBytes.Length)
            }
            [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
        }
    } catch {
        throw (
            "Credential file '$credentialFile' could not be imported as a " +
            "legacy user credential or a Relay machine credential. " +
            "Legacy import error: $legacyError Machine import error: " +
            $_.Exception.Message
        )
    }
}
