[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CommitMessage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $TaskBranch, $CommitMessage
) -ScriptBlock {
    param($ProjectPath, $Branch, $Message)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    function Invoke-Git([string[]]$Arguments) {
        $output = & git -C $ProjectPath @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    $currentBranch = (Invoke-Git @('branch', '--show-current') | Select-Object -Last 1).ToString().Trim()
    if ($currentBranch -ne $Branch) {
        throw "Expected branch '$Branch', but guest workspace is on '$currentBranch'."
    }

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
