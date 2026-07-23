[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CommitMessage,
    [ValidateNotNullOrEmpty()][string]$GitAuthorName = 'Relay Unity Orchestrator',
    [ValidateNotNullOrEmpty()][string]$GitAuthorEmail = 'relay-unity-orchestrator@localhost'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $TaskBranch, $CommitMessage, $GitAuthorName, $GitAuthorEmail
) -ScriptBlock {
    param($ProjectPath, $Branch, $Message, $AuthorName, $AuthorEmail)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
    $env:GCM_INTERACTIVE = '0'

    function Invoke-Git([string[]]$Arguments) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # Git Credential Manager writes some non-fatal provider warnings
            # to stderr. Use the native exit code as the source of truth.
            $ErrorActionPreference = 'Continue'
            $output = & git -C $ProjectPath @Arguments 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    $headPath = Join-Path $ProjectPath '.git\HEAD'
    if (-not (Test-Path -LiteralPath $headPath -PathType Leaf)) {
        throw "Git HEAD file was not found at '$headPath'."
    }
    $headReference = (Get-Content -LiteralPath $headPath -Raw -Encoding UTF8).Trim()
    $headPrefix = 'ref: refs/heads/'
    if (-not $headReference.StartsWith($headPrefix, [System.StringComparison]::Ordinal)) {
        throw "Guest workspace has a detached HEAD: '$headReference'."
    }
    $currentBranch = $headReference.Substring($headPrefix.Length)
    if ($currentBranch -ne $Branch) {
        throw "Expected branch '$Branch', but guest workspace is on '$currentBranch'."
    }

    # Set identity on the managed repository itself. This keeps delivery
    # independent from whichever Windows account happens to own the VM.
    Invoke-Git @('config', '--local', 'user.name', $AuthorName) | Out-Null
    Invoke-Git @('config', '--local', 'user.email', $AuthorEmail) | Out-Null
    Invoke-Git @('add', '-A') | Out-Null
    & git -C $ProjectPath diff --cached --quiet
    $hasChanges = $LASTEXITCODE -ne 0
    if ($hasChanges) {
        Invoke-Git @('commit', '-m', $Message) | Out-Null
    }
    $localSha = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -Last 1).ToString().Trim()
    Invoke-Git @('push', '--set-upstream', 'origin', $Branch) | Out-Null
    $remoteLine = (Invoke-Git @('ls-remote', 'origin', "refs/heads/$Branch") | Select-Object -Last 1).ToString().Trim()
    $remoteSha = ($remoteLine -split '\s+')[0]
    if ([string]::IsNullOrWhiteSpace($remoteSha) -or $remoteSha -ne $localSha) {
        throw "Remote verification failed. Local SHA '$localSha'; remote SHA '$remoteSha'."
    }
    [pscustomobject]@{
        commitSha = $localSha
        remoteSha = $remoteSha
        pushed = $true
        verified = $true
        hadChanges = $hasChanges
    }
}

$result | ConvertTo-Json -Compress
