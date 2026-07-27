[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpectedBranch,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}
if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    throw "Preserved workspace was not found at '$ProjectPath'."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    throw "Git metadata was not found at '$ProjectPath'."
}

$currentBranch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
if ([string]::IsNullOrWhiteSpace($currentBranch)) {
    throw 'Preserved workspace has a detached HEAD.'
}
if ($currentBranch -ne $ExpectedBranch) {
    throw "Expected preserved branch '$ExpectedBranch', but found '$currentBranch'."
}
$status = @(Get-RelayWorkspaceStatus $ProjectPath)
$result = [pscustomobject]@{
    branch = $currentBranch
    changedFiles = $status.Count
    preserved = $true
}
if ($OutputJson) {
    $result | ConvertTo-Json -Compress
} else {
    $result
}
