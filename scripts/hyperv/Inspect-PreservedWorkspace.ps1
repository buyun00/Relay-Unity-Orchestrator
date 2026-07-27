[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath
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
    $GuestProjectPath
) -ScriptBlock {
    param($ProjectPath)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding

    function Invoke-ReadOnlyGit([string[]]$Arguments) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& git -C $ProjectPath @Arguments 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    function Get-GitValue([string[]]$Arguments) {
        $lines = @(Invoke-ReadOnlyGit $Arguments)
        if ($lines.Count -eq 0) { return '' }
        return $lines[-1].ToString().Trim()
    }

    function Get-NulSeparatedPaths([string[]]$Arguments) {
        $rawPaths = (Invoke-ReadOnlyGit $Arguments) -join ''
        if ([string]::IsNullOrEmpty($rawPaths)) { return @() }
        return @(
            $rawPaths -split [char]0 |
                Where-Object { -not [string]::IsNullOrEmpty($_) }
        )
    }

    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
        return [pscustomobject]@{
            ready = $false
            code = 'PRESERVED_WORKSPACE_NOT_FOUND'
            message = "Preserved workspace was not found at '$ProjectPath'."
            projectPath = $ProjectPath
            repositoryExists = $false
            branch = $null
            head = $null
            porcelainV2 = @()
            untrackedFiles = @()
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
        return [pscustomobject]@{
            ready = $false
            code = 'PRESERVED_REPOSITORY_NOT_FOUND'
            message = "Git metadata was not found at '$ProjectPath'."
            projectPath = $ProjectPath
            repositoryExists = $false
            branch = $null
            head = $null
            porcelainV2 = @()
            untrackedFiles = @()
        }
    }

    $branch = Get-GitValue @('branch', '--show-current')
    $head = Get-GitValue @('rev-parse', '--verify', 'HEAD')
    $porcelainV2 = @(
        Invoke-ReadOnlyGit @(
            'status', '--porcelain=v2', '--branch', '--untracked-files=all'
        ) | ForEach-Object { $_.ToString() }
    )
    $untrackedFiles = @(
        Get-NulSeparatedPaths @(
            'ls-files', '--others', '--exclude-standard', '-z'
        ) | Sort-Object
    )

    [pscustomobject]@{
        ready = $true
        projectPath = $ProjectPath
        repositoryExists = $true
        branch = $branch
        head = $head
        porcelainV2 = $porcelainV2
        untrackedFiles = $untrackedFiles
    }
}

$result | ConvertTo-Json -Depth 12 -Compress
