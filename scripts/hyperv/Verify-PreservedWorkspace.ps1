[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch
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
    $GuestProjectPath, $TaskBranch
) -ScriptBlock {
    param($ProjectPath, $ExpectedBranch)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding

    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
        throw "Preserved workspace was not found at '$ProjectPath'."
    }
    $headPath = Join-Path $ProjectPath '.git\HEAD'
    if (-not (Test-Path -LiteralPath $headPath -PathType Leaf)) {
        throw "Git HEAD file was not found at '$headPath'."
    }
    $headReference = (Get-Content -LiteralPath $headPath -Raw -Encoding UTF8).Trim()
    $headPrefix = 'ref: refs/heads/'
    if (-not $headReference.StartsWith($headPrefix, [System.StringComparison]::Ordinal)) {
        throw "Preserved workspace has a detached HEAD: '$headReference'."
    }
    $currentBranch = $headReference.Substring($headPrefix.Length)
    if ($currentBranch -ne $ExpectedBranch) {
        throw "Expected preserved branch '$ExpectedBranch', but found '$currentBranch'."
    }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $status = @(& git -C $ProjectPath status --porcelain=v1 --untracked-files=all 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "git status failed: $($status -join [Environment]::NewLine)"
    }

    [pscustomobject]@{
        branch = $currentBranch
        changedFiles = $status.Count
        preserved = $true
    }
}

$result | ConvertTo-Json -Compress
