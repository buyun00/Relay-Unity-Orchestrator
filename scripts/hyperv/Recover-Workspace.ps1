[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [ValidateNotNullOrEmpty()][string]$GitAuthorName = 'Relay Unity Orchestrator',
    [ValidateNotNullOrEmpty()][string]$GitAuthorEmail = 'relay-unity-orchestrator@localhost',
    [string]$SharePath,
    [string]$UnityHealthUrl,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$prepareScript = Join-Path $PSScriptRoot 'Prepare-Workspace.ps1'
if (-not (Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
    throw "Workspace preparation script '$prepareScript' was not found."
}

& $prepareScript `
    -VMName $VMName `
    -CredentialPath $CredentialPath `
    -GuestProjectPath $GuestProjectPath `
    -RepoUrl $RepoUrl `
    -BaseBranch $BaseBranch `
    -TaskBranch $TaskBranch `
    -Mode recovery `
    -GitAuthorName $GitAuthorName `
    -GitAuthorEmail $GitAuthorEmail `
    -SharePath $SharePath `
    -UnityHealthUrl $UnityHealthUrl `
    -TimeoutSeconds $TimeoutSeconds
