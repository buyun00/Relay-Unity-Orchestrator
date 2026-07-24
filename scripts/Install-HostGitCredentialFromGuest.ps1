[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestRepositoryPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^https?://')][string]$GitLabRepositoryUrl,
    [string]$HostGitCommand = 'C:\Program Files\Git\cmd\git.exe',
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

trap {
    if ($ResultPath) {
        [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    }
    exit 1
}

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    if (-not $ResultPath) {
        $ResultPath = Join-Path ([System.IO.Path]::GetTempPath()) (
            "relay-git-credential-$([Guid]::NewGuid().ToString('N')).json"
        )
    }
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $PSCommandPath,
        '-VMName',
        $VMName,
        '-CredentialPath',
        ([System.IO.Path]::GetFullPath($CredentialPath)),
        '-GuestRepositoryPath',
        $GuestRepositoryPath,
        '-GitLabRepositoryUrl',
        $GitLabRepositoryUrl,
        '-ResultPath',
        $ResultPath
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden `
        -ArgumentList $arguments -Wait -PassThru
    if (Test-Path -LiteralPath $ResultPath) {
        Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8
        Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue
    }
    exit $process.ExitCode
}

if (-not (Test-Path -LiteralPath $HostGitCommand -PathType Leaf)) {
    throw "Host Git executable was not found: $HostGitCommand"
}

$guestCredential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($guestCredential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$repositoryUri = [Uri]$GitLabRepositoryUrl
$credentialRecord = $null
try {
    $credentialRecord = Invoke-Command -VMName $VMName -Credential $guestCredential -ArgumentList @(
        $GuestRepositoryPath,
        $repositoryUri.Scheme,
        $repositoryUri.Host,
        $repositoryUri.AbsolutePath.TrimStart('/')
    ) -ScriptBlock {
        param($RepositoryPath, $Protocol, $HostName, $RepositoryPathName)
        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest
        $env:GCM_INTERACTIVE = '0'
        $env:GIT_TERMINAL_PROMPT = '0'
        $env:GCM_ALLOW_UNSAFE_REMOTES = 'true'

        if (-not (Test-Path -LiteralPath (Join-Path $RepositoryPath '.git'))) {
            throw "Guest Git repository was not found at '$RepositoryPath'."
        }

        $query = @(
            "protocol=$Protocol",
            "host=$HostName",
            "path=$RepositoryPathName",
            ''
        ) -join "`n"
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $response = @($query | & git -C $RepositoryPath credential fill 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw 'Guest Git Credential Manager could not return the stored GitLab credential.'
        }

        $fields = @{}
        foreach ($line in $response) {
            $text = [string]$line
            $separator = $text.IndexOf('=')
            if ($separator -gt 0) {
                $fields[$text.Substring(0, $separator)] = $text.Substring($separator + 1)
            }
        }
        if (-not $fields.username -or -not $fields.password) {
            throw 'Guest Git Credential Manager returned no username or token.'
        }

        [pscustomobject]@{
            username = [string]$fields.username
            password = [string]$fields.password
        }
    }

    $approve = @(
        "protocol=$($repositoryUri.Scheme)",
        "host=$($repositoryUri.Host)",
        "username=$($credentialRecord.username)",
        "password=$($credentialRecord.password)",
        ''
    ) -join "`n"
    $env:GCM_INTERACTIVE = '0'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_ALLOW_UNSAFE_REMOTES = 'true'
    $approve | & $HostGitCommand -c credential.allowUnsafeRemotes=true credential approve
    if ($LASTEXITCODE -ne 0) {
        throw 'Host Git Credential Manager rejected the credential.'
    }

    $remote = @(
        & $HostGitCommand -c credential.allowUnsafeRemotes=true ls-remote --exit-code `
            $GitLabRepositoryUrl HEAD 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw 'Host GitLab credential was stored, but non-interactive verification failed.'
    }
    $remoteSha = (($remote | Select-Object -First 1) -split '\s+')[0]
    $resultJson = [pscustomobject]@{
        ok = $true
        host = $repositoryUri.Host
        credentialManager = 'Git Credential Manager'
        verified = $true
        remoteHead = $remoteSha
    } | ConvertTo-Json -Compress
    if ($ResultPath) {
        $resultJson | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    } else {
        $resultJson
    }
} finally {
    if ($credentialRecord) {
        $credentialRecord.password = $null
    }
    $approve = $null
}
