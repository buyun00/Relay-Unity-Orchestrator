[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

function Complete-Inspection([object]$Result) {
    if ($OutputJson) {
        return ($Result | ConvertTo-Json -Depth 12 -Compress)
    }
    return $Result
}

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    return (Complete-Inspection ([pscustomobject]@{
        ready = $false
        code = 'PRESERVED_WORKSPACE_NOT_FOUND'
        message = "Preserved workspace was not found at '$ProjectPath'."
        projectPath = $ProjectPath
        repositoryExists = $false
        branch = $null
        head = $null
        statusBefore = @()
        auditedFiles = @()
        audit = $null
        porcelainV2 = @()
        untrackedFiles = @()
    }))
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    return (Complete-Inspection ([pscustomobject]@{
        ready = $false
        code = 'PRESERVED_REPOSITORY_NOT_FOUND'
        message = "Git metadata was not found at '$ProjectPath'."
        projectPath = $ProjectPath
        repositoryExists = $false
        branch = $null
        head = $null
        statusBefore = @()
        auditedFiles = @()
        audit = $null
        porcelainV2 = @()
        untrackedFiles = @()
    }))
}

$branch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
$head = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
$statusBefore = @(Get-RelayWorkspaceStatus $ProjectPath)
$auditedFiles = @(
    foreach ($entry in $statusBefore) {
        $absolutePath = [System.IO.Path]::GetFullPath(
            (Join-Path $ProjectPath $entry.path)
        )
        [pscustomobject]@{
            code = $entry.code
            path = $entry.path
            originalPath = $entry.originalPath
            auditBlob = if ([System.IO.File]::Exists($absolutePath)) {
                Get-RelayPathBlob $ProjectPath $entry.path
            } else {
                ''
            }
        }
    }
)
$auditFingerprint = Get-RelayAuditFingerprint $head $auditedFiles

# Hashing can race with an editor write. Re-read HEAD and every path before
# returning so the adapter receives one coherent, immutable audit snapshot.
$headAfter = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
$statusAfter = @(Get-RelayWorkspaceStatus $ProjectPath)
$auditedFilesAfter = @(
    foreach ($entry in $statusAfter) {
        $absolutePath = [System.IO.Path]::GetFullPath(
            (Join-Path $ProjectPath $entry.path)
        )
        [pscustomobject]@{
            code = $entry.code
            path = $entry.path
            originalPath = $entry.originalPath
            auditBlob = if ([System.IO.File]::Exists($absolutePath)) {
                Get-RelayPathBlob $ProjectPath $entry.path
            } else {
                ''
            }
        }
    }
)
$auditFingerprintAfter = Get-RelayAuditFingerprint $headAfter $auditedFilesAfter
if ($headAfter -ne $head -or $auditFingerprintAfter -ne $auditFingerprint) {
    return (Complete-Inspection ([pscustomobject]@{
        ready = $false
        code = 'PRESERVED_WORKSPACE_CHANGED_DURING_AUDIT'
        message = 'The preserved workspace changed while Relay was auditing it; it remains in attention.'
        projectPath = $ProjectPath
        repositoryExists = $true
        branch = $branch
        head = $head
        statusBefore = $statusBefore
        auditedFiles = $auditedFiles
        audit = $null
        porcelainV2 = @()
        untrackedFiles = @(
            $statusBefore |
                Where-Object { $_.code -eq '??' } |
                ForEach-Object { $_.path }
        )
    }))
}

$porcelainV2Result = Invoke-RelayGit $ProjectPath @(
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'
)
$porcelainV2 = @(ConvertFrom-RelayNulFields $porcelainV2Result.stdoutBytes)
$untrackedFiles = @(
    $statusBefore |
        Where-Object { $_.code -eq '??' } |
        ForEach-Object { $_.path }
)
$audit = [pscustomobject]@{
    version = 1
    branch = $branch
    head = $head
    fingerprint = $auditFingerprint
    changes = $auditedFiles
}

Complete-Inspection ([pscustomobject]@{
    ready = $true
    projectPath = $ProjectPath
    repositoryExists = $true
    branch = $branch
    head = $head
    statusBefore = $statusBefore
    auditedFiles = $auditedFiles
    auditFingerprint = $auditFingerprint
    audit = $audit
    porcelainV2 = $porcelainV2
    untrackedFiles = $untrackedFiles
})
